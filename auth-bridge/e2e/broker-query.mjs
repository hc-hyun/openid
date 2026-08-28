#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadConfig } from "../lib/config.mjs";
import { KeycloakAdmin, provision } from "../lib/keycloak-admin.mjs";
import { BrowserSession, formById, formWithInput, parseForms } from "./browser-session.mjs";

const execFileAsync = promisify(execFile);
const authBridgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(authBridgeRoot, "..");
const mockRoot = join(authBridgeRoot, "mock");
const cliRoot = join(repositoryRoot, "cli-device-auth-mvp");
const cliPath = join(cliRoot, "bin/skillsctl.mjs");
const apiPath = join(cliRoot, "api-server.mjs");
const gatewayPath = join(authBridgeRoot, "gateway/server.mjs");
const responseMode = process.env.AUTHBRIDGE_E2E_RESPONSE_MODE ?? "query";
assert(
  ["query", "form_post"].includes(responseMode),
  `Unsupported AUTHBRIDGE_E2E_RESPONSE_MODE: ${responseMode}`,
);
const usesStandaloneCompose = process.env.AUTHBRIDGE_E2E_STANDALONE === "true";
const usesFormPostGateway = responseMode === "form_post";
assert(!usesStandaloneCompose || usesFormPostGateway, "standalone E2E requires form_post mode");
const standaloneProject = "authbridge-standalone-e2e";
const standaloneCompose = join(authBridgeRoot, "compose.yaml");
const standaloneMockOverlay = join(mockRoot, "standalone-keycloak.override.yaml");
const publicBaseUrl = usesFormPostGateway
  ? "http://localhost:8180/ws2/30001"
  : "http://localhost:8080";
const issuer = `${publicBaseUrl}/realms/authbridge`;
const mockProfile = join(
  authBridgeRoot,
  usesFormPostGateway ? "config/mock-form-post.json" : "config/mock-query.json",
);
const mockClientId = "authbridge-broker";
const mockClientSecret = "mock-corporate-secret";
const mockUsername = "company-user";
const mockPassword = "company-password-local-only";

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function prepareServers() {
  await run(process.execPath, ["validate-realm.mjs"], { cwd: mockRoot });
  await run("docker", ["compose", "up", "-d", "--wait", "--force-recreate"], {
    cwd: mockRoot,
  });
  if (usesStandaloneCompose) {
    const composeArgs = [
      "compose",
      "-p",
      standaloneProject,
      "-f",
      standaloneCompose,
      "-f",
      standaloneMockOverlay,
    ];
    const composeEnv = {
      ...process.env,
      AUTHBRIDGE_PUBLIC_URL: publicBaseUrl,
      AUTHBRIDGE_KEYCLOAK_ADMIN_PORT: "8280",
      AUTHBRIDGE_GATEWAY_PORT: "8180",
    };
    await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"], {
      cwd: authBridgeRoot,
      env: composeEnv,
    });
    await run("docker", [...composeArgs, "up", "-d", "--build", "--wait"], {
      cwd: authBridgeRoot,
      env: composeEnv,
      timeout: 300_000,
    });
    return;
  }
  await run(
    "docker",
    [
      "compose",
      "-f",
      "compose.yaml",
      "-f",
      "auth-bridge/mock/main-keycloak.override.yaml",
      "up",
      "-d",
      "--wait",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, KEYCLOAK_URL: publicBaseUrl },
    },
  );
}

async function cleanupStandaloneServers() {
  if (!usesStandaloneCompose) return;
  await run(
    "docker",
    [
      "compose",
      "-p",
      standaloneProject,
      "-f",
      standaloneCompose,
      "-f",
      standaloneMockOverlay,
      "down",
      "--volumes",
      "--remove-orphans",
      "--rmi",
      "local",
    ],
    {
      cwd: authBridgeRoot,
      env: {
        ...process.env,
        AUTHBRIDGE_PUBLIC_URL: publicBaseUrl,
        AUTHBRIDGE_KEYCLOAK_ADMIN_PORT: "8280",
        AUTHBRIDGE_GATEWAY_PORT: "8180",
      },
    },
  );
}

async function waitForHealth(url, child, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited with ${child.exitCode}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The child process can take a moment to bind its local port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`${label} did not become healthy at ${url}`);
}

async function driveDeviceApproval(verificationUrl) {
  let upstreamAuthorization;
  let brokerCallback;
  const trace = [];
  const browser = new BrowserSession({
    onRequest({ url, method, headers }) {
      const cookieNames = String(headers.get("cookie") ?? "")
        .split(";")
        .map((item) => item.split("=", 1)[0].trim())
        .filter(Boolean)
        .join("+");
      trace.push(`${method} ${url.origin}${url.pathname}${cookieNames ? ` [${cookieNames}]` : ""}`);
      if (
        method === "GET" &&
        url.origin === "http://localhost:8090" &&
        url.pathname.endsWith("/protocol/openid-connect/auth")
      ) {
        upstreamAuthorization = new URL(url);
      }
      if (
        url.pathname.endsWith("/realms/authbridge/broker/company-oidc/endpoint") &&
        url.origin === new URL(publicBaseUrl).origin
      ) {
        brokerCallback = { method, url: new URL(url) };
      }
    },
  });

  let page = await browser.request(verificationUrl);
  for (let step = 0; step < 16; step += 1) {
    const html = await page.text();
    if (html.includes("Device Login Successful")) {
      assert(upstreamAuthorization, "browser never reached the mock corporate authorization endpoint");
      assert(brokerCallback, "browser never reached the AuthBridge broker callback");
      return { upstreamAuthorization, brokerCallback };
    }

    const login = formById(html, "kc-form-login");
    if (login) {
      const loginUrl = new URL(page.url);
      assert.equal(loginUrl.origin, "http://localhost:8090", "target realm exposed a local password form");
      page = await browser.submitForm(page.url, login, {
        username: mockUsername,
        password: mockPassword,
        credentialId: "",
      });
      continue;
    }

    const profile = formById(html, "kc-update-profile-form");
    if (profile) {
      page = await browser.submitForm(page.url, profile, {
        username: mockUsername,
        email: "company-user@corporate.example",
        firstName: "Company",
        lastName: "User",
      });
      continue;
    }

    const deviceCode = formById(html, "kc-user-verify-device-user-code-form");
    if (deviceCode) {
      const userCode = new URL(verificationUrl).searchParams.get("user_code");
      assert(userCode, "verification_uri_complete did not include user_code");
      page = await browser.submitForm(page.url, deviceCode, { device_user_code: userCode });
      continue;
    }

    const grant = formWithInput(html, "accept");
    if (grant?.inputs.some((input) => input.name === "code")) {
      const accept = grant.inputs.find((input) => input.name === "accept")?.value ?? "Yes";
      page = await browser.submitForm(page.url, grant, { accept });
      continue;
    }

    const formPost = formWithInput(html, "state");
    if (formPost?.inputs.some((input) => input.name === "code")) {
      page = await browser.submitForm(page.url, formPost);
      continue;
    }

    const ids = Array.from(html.matchAll(/<form\b[^>]*\bid=["']([^"']+)["']/gi))
      .map((match) => match[1])
      .join(", ");
    const parsedForms = parseForms(html)
      .map((form) => `${form.id ?? "anonymous"}[${form.inputs.map((input) => input.name).join("+")}]`)
      .join(", ");
    const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
    const visibleText = html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    const cookieSummary = Array.from(browser.cookies.values())
      .map((cookie) => `${cookie.name}@${cookie.domain}${cookie.path}${cookie.secure ? ";Secure" : ""}`)
      .join(", ");
    throw new Error(
      `Unexpected browser page at ${new URL(page.url).origin}${new URL(page.url).pathname} ` +
        `(title: ${title || "none"}; forms: ${ids || parsedForms || "none"}; text: ${visibleText || "none"}; ` +
        `cookies: ${cookieSummary || "none"}; trace: ${trace.join(" -> ")})`,
    );
  }
  throw new Error("Device approval exceeded the expected number of pages");
}

function loginThroughCli(cliEnv) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, "login", "--no-browser", "--force"], {
      cwd: cliRoot,
      env: cliEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let approvalError;
    let authorizationPromise;
    const timeout = setTimeout(() => {
      approvalError = new Error("Brokered CLI login timed out");
      child.kill("SIGTERM");
    }, 60_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const verificationUrl = stdout.match(/Open this URL in your browser:\s*(\S+)/)?.[1];
      if (verificationUrl && !authorizationPromise) {
        authorizationPromise = driveDeviceApproval(verificationUrl).catch((error) => {
          approvalError = error;
          child.kill("SIGTERM");
          throw error;
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      try {
        const approval = authorizationPromise
          ? await authorizationPromise
          : undefined;
        if (approvalError) throw approvalError;
        if (code !== 0) throw new Error(`CLI login failed (${code}): ${stderr || stdout}`);
        assert(approval, "CLI never printed a verification URL");
        resolvePromise({ stdout, ...approval });
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

function decodeClaims(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "stored access token is not a JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

async function removeExistingBrokerTestUser(admin) {
  const query = new URLSearchParams({ username: mockUsername, exact: "true" });
  const { data: users } = await admin.request(admin.realmPath(`/users?${query}`));
  for (const user of users) {
    await admin.request(admin.realmPath(`/users/${encodeURIComponent(user.id)}`), {
      method: "DELETE",
      expected: [204],
    });
  }
}

const temporaryConfig = await mkdtemp(join(tmpdir(), "authbridge-e2e-"));
let api;
let gateway;

try {
  await prepareServers();
  if (usesFormPostGateway && !usesStandaloneCompose) {
    const gatewayEnv = {
      ...process.env,
      AUTHBRIDGE_GATEWAY_PUBLIC_URL: publicBaseUrl,
      AUTHBRIDGE_GATEWAY_HOST: "127.0.0.1",
      AUTHBRIDGE_GATEWAY_PORT: "8180",
      AUTHBRIDGE_KEYCLOAK_URL: "http://localhost:8080",
    };
    gateway = spawn(process.execPath, [gatewayPath], {
      cwd: authBridgeRoot,
      env: gatewayEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let gatewayError = "";
    gateway.stderr.setEncoding("utf8");
    gateway.stderr.on("data", (chunk) => {
      gatewayError += chunk;
    });
    await waitForHealth("http://localhost:8180/healthz", gateway, "AuthBridge gateway").catch(
      (error) => {
        throw new Error(`${error.message}${gatewayError ? `: ${gatewayError}` : ""}`);
      },
    );
  }
  const provisionConfig = await loadConfig({
    profilePath: mockProfile,
    env: {
      UPSTREAM_OIDC_CLIENT_ID: mockClientId,
      UPSTREAM_OIDC_CLIENT_SECRET: mockClientSecret,
      ...(usesStandaloneCompose
        ? { AUTHBRIDGE_KEYCLOAK_ADMIN_URL: "http://localhost:8280" }
        : {}),
    },
  });
  await provision(provisionConfig);
  const admin = new KeycloakAdmin(provisionConfig, { log: { log() {} } });
  await admin.authenticate();
  await removeExistingBrokerTestUser(admin);

  const cliEnv = {
    ...process.env,
    SKILLSCTL_CONFIG_DIR: temporaryConfig,
    SKILLS_OIDC_ISSUER: issuer,
    SKILLS_OIDC_CLIENT_ID: "skills-cli",
    SKILLS_OIDC_AUDIENCE: "skills-api",
    SKILLS_MCP_AUDIENCE: "http://localhost:3200/mcp",
    SKILLS_OIDC_SCOPE: "openid profile email offline_access skills.read mcp.tools",
    SKILLS_API_URL: "http://localhost:3200",
    SKILLS_API_HOST: "127.0.0.1",
    SKILLS_API_PORT: "3200",
    SKILLS_API_PUBLIC_URL: "http://localhost:3200",
    SKILLS_MCP_ALLOWED_ORIGINS: "http://localhost:3200",
  };

  api = spawn(process.execPath, [apiPath], {
    cwd: cliRoot,
    env: cliEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let apiError = "";
  api.stderr.setEncoding("utf8");
  api.stderr.on("data", (chunk) => {
    apiError += chunk;
  });
  await waitForHealth("http://localhost:3200/health", api, "Protected API").catch((error) => {
    throw new Error(`${error.message}${apiError ? `: ${apiError}` : ""}`);
  });

  const login = await loginThroughCli(cliEnv);
  assert.match(login.stdout, /Logged in as company-user/);
  const authorization = login.upstreamAuthorization;
  assert.equal(authorization.searchParams.get("client_id"), mockClientId);
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("response_mode"), responseMode);
  assert.equal(authorization.searchParams.get("redirect_uri"), provisionConfig.callbackUrl);
  assert(authorization.searchParams.get("state"), "upstream authorization request omitted state");
  assert(authorization.searchParams.get("nonce"), "upstream authorization request omitted nonce");
  assert.equal(login.brokerCallback.method, usesFormPostGateway ? "POST" : "GET");
  assert.equal(
    `${login.brokerCallback.url.origin}${login.brokerCallback.url.pathname}`,
    provisionConfig.callbackUrl,
  );
  if (usesFormPostGateway) {
    assert.equal(login.brokerCallback.url.search, "", "form_post callback leaked values into its URL");
  } else {
    assert(login.brokerCallback.url.searchParams.get("code"), "query callback omitted code");
    assert(login.brokerCallback.url.searchParams.get("state"), "query callback omitted state");
  }

  const stored = JSON.parse(await readFile(join(temporaryConfig, "credentials.json"), "utf8"));
  const claims = decodeClaims(stored.tokenSet.access_token);
  assert.equal(claims.iss, issuer);
  assert.equal(claims.preferred_username, mockUsername);
  assert(claims.realm_access?.roles?.includes("tester"), "brokered user lacks tester role");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  assert(audiences.includes("skills-api"), "access token lacks skills-api audience");
  assert(audiences.includes("http://localhost:3200/mcp"), "access token lacks MCP audience");
  const scopes = new Set(String(claims.scope ?? "").split(/\s+/));
  for (const scope of ["openid", "offline_access", "skills.read", "mcp.tools"]) {
    assert(scopes.has(scope), `access token lacks ${scope} scope`);
  }

  const whoami = JSON.parse(await run(process.execPath, [cliPath, "whoami"], {
    cwd: cliRoot,
    env: cliEnv,
    timeout: 20_000,
  }));
  assert.equal(whoami.username, mockUsername);
  assert(whoami.roles.includes("tester"));
  const mcp = JSON.parse(await run(process.execPath, [cliPath, "mcp"], {
    cwd: cliRoot,
    env: cliEnv,
    timeout: 20_000,
  }));
  assert.equal(mcp.username, mockUsername);

  const query = new URLSearchParams({ username: mockUsername, exact: "true" });
  const { data: users } = await admin.request(admin.realmPath(`/users?${query}`));
  assert.equal(users.length, 1, "brokered Keycloak user was not created exactly once");
  const { data: links } = await admin.request(
    admin.realmPath(`/users/${encodeURIComponent(users[0].id)}/federated-identity`),
  );
  assert(links.some((link) => link.identityProvider === "company-oidc"));

  await run(process.execPath, [cliPath, "logout"], {
    cwd: cliRoot,
    env: cliEnv,
    timeout: 20_000,
  });
  await assert.rejects(readFile(join(temporaryConfig, "credentials.json")), { code: "ENOENT" });

  console.log(
    `OK: mock corporate OIDC (${responseMode}${usesStandaloneCompose ? ", standalone compose" : ""}) -> AuthBridge -> CLI Device Flow -> API/MCP -> logout succeeded.`,
  );
} finally {
  if (api && api.exitCode === null) {
    api.kill("SIGTERM");
    await new Promise((resolvePromise) => api.once("close", resolvePromise));
  }
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await new Promise((resolvePromise) => gateway.once("close", resolvePromise));
  }
  try {
    await cleanupStandaloneServers();
  } finally {
    await rm(temporaryConfig, { recursive: true, force: true });
  }
}
