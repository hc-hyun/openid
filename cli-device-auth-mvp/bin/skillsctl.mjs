#!/usr/bin/env node
import { spawn } from "node:child_process";
import { config } from "../lib/config.mjs";
import {
  deleteCredentials,
  credentialsPath,
  loadCredentials,
  saveCredentials,
  withCredentialsLock,
} from "../lib/credentials.mjs";
import {
  pollDeviceToken,
  refreshToken,
  revokeToken,
  startDeviceAuthorization,
} from "../lib/oauth.mjs";

function usage() {
  console.log(`skillsctl - API/MCP login MVP

Usage:
  skillsctl login [--no-browser] [--force] [--discard-local]
  skillsctl whoami
  skillsctl api
  skillsctl mcp
  skillsctl status
  skillsctl logout [--local]

No API key or environment variable is required for the default local setup.`);
}

async function openBrowser(url) {
  const command =
    process.platform === "darwin" ? ["open", [url]] :
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    ["xdg-open", [url]];

  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
    return await new Promise((resolve) => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}

async function validAccessToken() {
  const stored = await loadCredentials();
  if (!stored) throw new Error("Not logged in. Run: skillsctl login");

  if (stored.tokenSet?.access_token && stored.tokenSet.expires_at > Date.now() + 30_000) {
    return stored.tokenSet.access_token;
  }

  return withCredentialsLock(async () => {
    const latest = await loadCredentials();
    if (!latest) throw new Error("Not logged in. Run: skillsctl login");
    if (
      latest.tokenSet?.access_token &&
      latest.tokenSet.expires_at > Date.now() + 30_000
    ) {
      return latest.tokenSet.access_token;
    }
    if (!latest.tokenSet?.refresh_token) {
      throw new Error("Session expired. Run: skillsctl login");
    }

    const refreshed = await refreshToken({
      issuer: latest.issuer,
      clientId: latest.clientId,
      refreshToken: latest.tokenSet.refresh_token,
    });
    const tokenSet = {
      ...latest.tokenSet,
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? latest.tokenSet.refresh_token,
    };
    await saveCredentials({ ...latest, tokenSet, updatedAt: new Date().toISOString() });
    return tokenSet.access_token;
  });
}

async function apiRequest(path, options = {}) {
  const token = await validAccessToken();
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Resource server returned non-JSON data (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(data.error_description ?? data.error ?? `HTTP ${response.status}`);
  }
  return data;
}

async function login(flags) {
  if (flags.has("--discard-local") && !flags.has("--force")) {
    throw new Error("--discard-local requires --force");
  }
  const existing = await loadCredentials();
  if (!flags.has("--force") && existing) {
    console.log("A login is already stored. Use --force to authenticate again.");
    console.log(`Credentials: ${credentialsPath()}`);
    return;
  }
  if (flags.has("--force") && existing) {
    await withCredentialsLock(async () => {
      const latest = await loadCredentials();
      if (!latest) return;
      if (flags.has("--discard-local")) {
        await deleteCredentials();
        return;
      }
      const token = latest.tokenSet.refresh_token ?? latest.tokenSet.access_token;
      const hint = latest.tokenSet.refresh_token ? "refresh_token" : "access_token";
      await revokeToken({
        issuer: latest.issuer,
        clientId: latest.clientId,
        token,
        tokenTypeHint: hint,
      });
      await deleteCredentials();
    });
    if (flags.has("--discard-local")) {
      console.log("! Discarded local credentials without server-side revocation.");
    } else {
      console.log("✓ Revoked the previous login before re-authenticating.");
    }
  }

  const { metadata, authorization } = await startDeviceAuthorization(config);
  const verificationUrl =
    authorization.verification_uri_complete ?? authorization.verification_uri;

  console.log(`\n! First copy your one-time code: ${authorization.user_code}`);
  console.log(`Open this URL in your browser: ${verificationUrl}\n`);

  if (!flags.has("--no-browser")) {
    if (await openBrowser(verificationUrl)) console.log("Opening your browser...");
    else console.log("Could not open a browser automatically; use the URL above.");
  }

  console.log("Waiting for authorization");
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Login cancelled"));
  process.once("SIGINT", cancel);

  try {
    const tokenSet = await pollDeviceToken({
      metadata,
      clientId: config.clientId,
      deviceCode: authorization.device_code,
      expiresIn: authorization.expires_in,
      interval: authorization.interval,
      signal: controller.signal,
      onPoll: () => process.stdout.write("."),
    });
    process.stdout.write("\n");
    await withCredentialsLock(() =>
      saveCredentials({
        version: 1,
        issuer: config.issuer,
        clientId: config.clientId,
        audience: config.audience,
        mcpAudience: config.mcpAudience,
        scope: config.scope,
        tokenSet,
        createdAt: new Date().toISOString(),
      }),
    );
    const result = await apiRequest("/api/me");
    console.log(`✓ Logged in as ${result.user.username}`);
    console.log(`✓ Credentials saved to ${credentialsPath()}`);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

async function whoami() {
  const result = await apiRequest("/api/me");
  console.log(JSON.stringify(result.user, null, 2));
}

async function callMcp() {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
  };
  const initialized = await apiRequest("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "skillsctl", version: "1.0.0" },
      },
    }),
  });
  if (initialized.error) throw new Error(initialized.error.message);

  await apiRequest("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const result = await apiRequest("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  if (result.error) throw new Error(result.error.message);
  console.log(JSON.stringify(result.result.structuredContent, null, 2));
}

async function status() {
  const stored = await loadCredentials();
  if (!stored) {
    console.log("Not logged in.");
    return;
  }
  console.log(`Issuer: ${stored.issuer}`);
  console.log(`Client: ${stored.clientId}`);
  console.log(`Credentials: ${credentialsPath()}`);
  console.log(`Access token expires: ${new Date(stored.tokenSet.expires_at).toISOString()}`);
}

async function logout(flags) {
  await withCredentialsLock(async () => {
    const stored = await loadCredentials();
    if (!stored) {
      console.log("Already logged out.");
      return;
    }

    if (flags.has("--local")) {
      await deleteCredentials();
      console.log("! Deleted local credentials without server-side revocation.");
      return;
    }

    const token = stored.tokenSet.refresh_token ?? stored.tokenSet.access_token;
    const hint = stored.tokenSet.refresh_token ? "refresh_token" : "access_token";
    await revokeToken({
      issuer: stored.issuer,
      clientId: stored.clientId,
      token,
      tokenTypeHint: hint,
    });
    await deleteCredentials();
    console.log("✓ Logged out and deleted local credentials.");
  });
}

const [command = "help", ...arguments_] = process.argv.slice(2);
const flags = new Set(arguments_);

try {
  if (command === "login") await login(flags);
  else if (command === "whoami" || command === "api") await whoami();
  else if (command === "mcp") await callMcp();
  else if (command === "status") await status();
  else if (command === "logout") await logout(flags);
  else if (command === "help" || command === "--help" || command === "-h") usage();
  else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
