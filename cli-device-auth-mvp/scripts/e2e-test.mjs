import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "../lib/config.mjs";
import { loadCredentials, saveCredentials } from "../lib/credentials.mjs";
import {
  discover,
  refreshToken,
  revokeToken,
} from "../lib/oauth.mjs";

const username = process.env.CLI_TEST_USERNAME ?? "cli-user";
const password = process.env.CLI_TEST_PASSWORD ?? "cli-password-local-only";
const cookies = new Map();
const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../bin/skillsctl.mjs", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function updateCookies(response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const expired = attributes.some((attribute) =>
      /^\s*Max-Age=0\s*$/i.test(attribute),
    );

    if (expired || !value) cookies.delete(name);
    else cookies.set(name, value);
  }
}

async function browserRequest(initialUrl, initialOptions = {}) {
  let url = initialUrl;
  let method = initialOptions.method ?? "GET";
  let body = initialOptions.body;
  let headers = { ...(initialOptions.headers ?? {}) };

  for (let redirects = 0; redirects < 20; redirects += 1) {
    if (cookies.size) {
      headers.Cookie = Array.from(cookies, ([name, value]) => `${name}=${value}`).join(
        "; ",
      );
    }

    const response = await fetch(url, {
      method,
      body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    updateCookies(response);

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    url = new URL(response.headers.get("location"), url).toString();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
      headers = {};
    }
  }

  throw new Error("Too many browser redirects");
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function formAction(html, id) {
  const form = html.match(new RegExp(`<form\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"));
  const action = form?.[0].match(/\baction=["']([^"']+)["']/i)?.[1];
  return action ? decodeHtml(action) : undefined;
}

function oauthGrant(html) {
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi)?.find((candidate) =>
    /\bname=["']accept["']/i.test(candidate),
  );
  if (!form) return undefined;

  const action = form.match(/\baction=["']([^"']+)["']/i)?.[1];
  const code = form.match(
    /<input\b(?=[^>]*\bname=["']code["'])(?=[^>]*\bvalue=["']([^"']*)["'])[^>]*>/i,
  )?.[1];
  const accept = form.match(
    /<input\b(?=[^>]*\bname=["']accept["'])(?=[^>]*\bvalue=["']([^"']*)["'])[^>]*>/i,
  )?.[1];
  return action && code
    ? { action: decodeHtml(action), code: decodeHtml(code), accept: decodeHtml(accept ?? "Yes") }
    : undefined;
}

async function approveInBrowser(authorization) {
  const verificationUrl =
    authorization.verification_uri_complete ?? authorization.verification_uri;
  let page = await browserRequest(verificationUrl);
  let html = await page.text();

  const loginAction = formAction(html, "kc-form-login");
  if (loginAction) {
    page = await browserRequest(new URL(loginAction, page.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, credentialId: "" }),
    });
    html = await page.text();
  }

  const codeAction = formAction(html, "kc-user-verify-device-user-code-form");
  if (codeAction) {
    page = await browserRequest(new URL(codeAction, page.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ device_user_code: authorization.user_code }),
    });
    html = await page.text();
  }

  const grant = oauthGrant(html);
  if (grant) {
    page = await browserRequest(new URL(grant.action, page.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: grant.code, accept: grant.accept }),
    });
    html = await page.text();
  }

  assert(
    !formAction(html, "kc-form-login") && !html.includes("login-error"),
    `Keycloak did not approve the device login at ${page.url}`,
  );
  if (!html.includes("Device Login Successful")) {
    const formIds = Array.from(html.matchAll(/<form\b[^>]*\bid=["']([^"']+)["']/gi))
      .map((match) => match[1])
      .join(", ");
    throw new Error(
      `Unexpected Keycloak device page at ${page.url} (forms: ${formIds || "none"})`,
    );
  }
}

function jwtClaims(token) {
  const parts = token.split(".");
  assert(parts.length === 3, "Access token is not a JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

async function resourceRequest(path, token, options = {}) {
  return fetch(`${config.apiUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

async function runCli(...arguments_) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...arguments_], {
    env: process.env,
    timeout: 15_000,
  });
  return stdout;
}

function loginThroughCli() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, "login", "--no-browser", "--force"],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let approvalError;
    let approvalStarted = false;

    const timeout = setTimeout(() => {
      approvalError = new Error("CLI login timed out");
      child.kill("SIGTERM");
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const verificationUrl = stdout.match(/Open this URL in your browser:\s*(\S+)/)?.[1];
      if (!verificationUrl || approvalStarted) return;
      approvalStarted = true;
      approveInBrowser({
        verification_uri_complete: verificationUrl,
        user_code: new URL(verificationUrl).searchParams.get("user_code"),
      }).catch((error) => {
        approvalError = error;
        child.kill("SIGTERM");
      });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (approvalError) reject(approvalError);
      else if (code !== 0) reject(new Error(`CLI login failed (${code}): ${stderr || stdout}`));
      else resolve(stdout);
    });
  });
}

const temporaryConfig = await mkdtemp(join(tmpdir(), "skillsctl-e2e-"));
process.env.SKILLSCTL_CONFIG_DIR = temporaryConfig;
let refreshTokenForCleanup;

try {
  const health = await fetch(`${config.apiUrl}/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert(health.ok, `Protected API is not running at ${config.apiUrl}`);

  const challenge = await fetch(`${config.apiUrl}/api/me`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert(challenge.status === 401, "API without a token must return 401");
  assert(
    challenge.headers.get("www-authenticate")?.includes("resource_metadata="),
    "API challenge is missing OAuth Protected Resource Metadata",
  );
  const unsupportedMcpSse = await fetch(`${config.apiUrl}/mcp`, {
    signal: AbortSignal.timeout(3_000),
  });
  assert(unsupportedMcpSse.status === 405, "MCP GET without SSE support must return 405");
  const rejectedOrigin = await fetch(`${config.apiUrl}/mcp`, {
    headers: { Origin: "https://untrusted.example" },
    signal: AbortSignal.timeout(3_000),
  });
  assert(rejectedOrigin.status === 403, "MCP must reject an untrusted Origin");

  const metadata = await discover(config.issuer);
  assert(
    metadata.device_authorization_endpoint.startsWith(config.issuer),
    "Discovery returned an unexpected Device Authorization endpoint",
  );

  const loginOutput = await loginThroughCli();
  assert(loginOutput.includes(`Logged in as ${username}`), "CLI login returned the wrong user");
  const stored = await loadCredentials();
  assert(stored?.tokenSet?.access_token, "CLI login did not store an access token");
  const tokenSet = stored.tokenSet;
  refreshTokenForCleanup = tokenSet.refresh_token;

  const claims = jwtClaims(tokenSet.access_token);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const scopes = new Set(claims.scope?.split(/\s+/) ?? []);
  assert(claims.preferred_username === username, "Access token contains the wrong user");
  assert(audiences.includes(config.audience), `Access token is missing ${config.audience}`);
  assert(audiences.includes(config.mcpAudience), "Access token is missing the MCP audience");
  assert(scopes.has("skills.read"), "Access token is missing skills.read");
  assert(scopes.has("mcp.tools"), "Access token is missing mcp.tools");
  assert(claims.realm_access?.roles?.includes("tester"), "Access token is missing tester");
  assert(tokenSet.refresh_token, "offline_access did not issue a refresh token");
  const rejectedIdToken = await resourceRequest("/api/me", tokenSet.id_token);
  assert(rejectedIdToken.status === 401, "API accepted an ID token as an access token");

  const directoryMode = (await stat(temporaryConfig)).mode & 0o777;
  const fileMode = (await stat(join(temporaryConfig, "credentials.json"))).mode & 0o777;
  assert(directoryMode === 0o700, "Credential directory mode must be 0700");
  assert(fileMode === 0o600, "Credential file mode must be 0600");

  const statusOutput = await runCli("status");
  assert(statusOutput.includes(config.issuer), "CLI status did not load stored credentials");

  const apiResponse = await resourceRequest("/api/me", tokenSet.access_token);
  const apiResult = await apiResponse.json();
  assert(apiResponse.ok, `Protected API failed: ${JSON.stringify(apiResult)}`);
  assert(apiResult.user.username === username, "Protected API returned the wrong user");
  const whoamiOutput = await runCli("whoami");
  assert(whoamiOutput.includes(username), "CLI whoami returned the wrong user");

  const mcpResponse = await resourceRequest("/mcp", tokenSet.access_token, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  const mcpResult = await mcpResponse.json();
  assert(mcpResponse.ok, `Protected MCP failed: ${JSON.stringify(mcpResult)}`);
  assert(
    mcpResult.result?.structuredContent?.username === username,
    "Protected MCP returned the wrong user",
  );
  const mcpOutput = await runCli("mcp");
  assert(mcpOutput.includes(username), "CLI MCP call returned the wrong user");

  const previousRefreshToken = tokenSet.refresh_token;
  const forcedLoginOutput = await loginThroughCli();
  assert(
    forcedLoginOutput.includes("Revoked the previous login"),
    "CLI --force did not revoke the previous login",
  );
  let previousLoginRevoked = false;
  try {
    await refreshToken({
      issuer: config.issuer,
      clientId: config.clientId,
      refreshToken: previousRefreshToken,
    });
  } catch {
    previousLoginRevoked = true;
  }
  assert(previousLoginRevoked, "CLI --force left the previous refresh token active");
  const reauthenticated = await loadCredentials();
  refreshTokenForCleanup = reauthenticated.tokenSet.refresh_token;

  await saveCredentials({
    ...reauthenticated,
    tokenSet: { ...reauthenticated.tokenSet, expires_at: 0 },
  });
  const refreshedWhoamiOutputs = await Promise.all(
    Array.from({ length: 5 }, () => runCli("whoami")),
  );
  assert(
    refreshedWhoamiOutputs.every((output) => output.includes(username)),
    "Concurrent CLI automatic token refresh failed",
  );
  const refreshedStored = await loadCredentials();
  assert(refreshedStored.tokenSet.expires_at > Date.now(), "CLI did not persist refreshed tokens");
  try {
    await stat(join(temporaryConfig, "credentials.json.lock"));
    throw new Error("Credential refresh lock was not removed");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  refreshTokenForCleanup = refreshedStored.tokenSet.refresh_token;

  const revokedRefreshToken = refreshTokenForCleanup;
  const logoutOutput = await runCli("logout");
  assert(logoutOutput.includes("Logged out"), "CLI logout did not complete");
  let revoked = false;
  try {
    await refreshToken({
      issuer: config.issuer,
      clientId: config.clientId,
      refreshToken: revokedRefreshToken,
    });
  } catch {
    revoked = true;
  }
  assert(revoked, "CLI logout did not revoke the server-side refresh token");
  refreshTokenForCleanup = undefined;
  assert(!(await loadCredentials()), "Logout did not delete local credentials");

  console.log(
    "OK: CLI Device Flow, JWT authorization, API/MCP, forced re-login, concurrent refresh, and revocation succeeded.",
  );
} finally {
  if (refreshTokenForCleanup) {
    try {
      await revokeToken({
        issuer: config.issuer,
        clientId: config.clientId,
        token: refreshTokenForCleanup,
        tokenTypeHint: "refresh_token",
      });
    } catch {
      // Preserve the original test failure.
    }
  }
  await rm(temporaryConfig, { recursive: true, force: true });
}
