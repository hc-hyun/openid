import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "./env.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROFILE = resolve(PROJECT_ROOT, "config/authbridge.json");
const NAME = /^[A-Za-z0-9._-]+$/;
const SCOPE = /^[A-Za-z0-9._:-]+$/;
const PLACEHOLDER = /^(?:replace-|changeme$|example$)/i;

function requiredString(value, label, errors, pattern) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (pattern && !pattern.test(value)) errors.push(`${label} contains unsupported characters`);
}

function parseUrl(value, label, errors, { https = false } = {}) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (https && url.protocol !== "https:" && !loopback) {
      errors.push(`${label} must use HTTPS unless it points to loopback`);
    }
    if (url.username || url.password || url.search || url.hash) {
      errors.push(`${label} must not contain credentials, query parameters, or a fragment`);
    }
    return url;
  } catch {
    errors.push(`${label} must be an absolute HTTP(S) URL`);
    return undefined;
  }
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

export function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Configuration profile must be a JSON object");
  }

  const { keycloak = {}, realm = {}, clients = {}, resources = {}, upstream = {} } = profile;
  parseUrl(keycloak.adminUrl, "keycloak.adminUrl", errors);
  parseUrl(keycloak.publicUrl, "keycloak.publicUrl", errors, { https: true });
  requiredString(keycloak.adminRealm, "keycloak.adminRealm", errors, NAME);
  requiredString(keycloak.adminClientId, "keycloak.adminClientId", errors, NAME);
  if (!Number.isInteger(keycloak.requestTimeoutMs) || keycloak.requestTimeoutMs < 1_000 || keycloak.requestTimeoutMs > 120_000) {
    errors.push("keycloak.requestTimeoutMs must be an integer between 1000 and 120000");
  }

  requiredString(realm.name, "realm.name", errors, NAME);
  requiredString(realm.displayName, "realm.displayName", errors);
  if (!["all", "external", "none"].includes(realm.sslRequired)) {
    errors.push("realm.sslRequired must be one of: all, external, none");
  }
  for (const key of ["accessTokenLifespan", "ssoSessionIdleTimeout", "ssoSessionMaxLifespan"]) {
    if (!Number.isInteger(realm[key]) || realm[key] <= 0) errors.push(`realm.${key} must be a positive integer`);
  }

  requiredString(clients.cli, "clients.cli", errors, NAME);
  requiredString(clients.api, "clients.api", errors, NAME);
  if (clients.cli === clients.api) errors.push("clients.cli and clients.api must differ");
  parseUrl(resources.mcpAudience, "resources.mcpAudience", errors, { https: true });

  if (!Array.isArray(profile.scopes) || profile.scopes.length === 0) {
    errors.push("scopes must be a non-empty array");
  } else {
    const names = new Set();
    for (const [index, scope] of profile.scopes.entries()) {
      requiredString(scope?.name, `scopes[${index}].name`, errors, SCOPE);
      requiredString(scope?.description, `scopes[${index}].description`, errors);
      if (names.has(scope?.name)) errors.push(`scopes contains duplicate name: ${scope.name}`);
      names.add(scope?.name);
    }
  }

  requiredString(upstream.alias, "upstream.alias", errors, NAME);
  requiredString(upstream.displayName, "upstream.displayName", errors);
  parseUrl(upstream.discoveryUrl, "upstream.discoveryUrl", errors, { https: true });
  requiredString(upstream.defaultScope, "upstream.defaultScope", errors);
  if (!["client_secret_post", "client_secret_basic"].includes(upstream.clientAuthMethod)) {
    errors.push("upstream.clientAuthMethod must be client_secret_post or client_secret_basic");
  }
  if (!["query", "form_post"].includes(upstream.responseMode)) {
    errors.push("upstream.responseMode must be query or form_post");
  }
  if (!["IMPORT", "FORCE", "LEGACY", "INHERIT"].includes(upstream.syncMode)) {
    errors.push("upstream.syncMode is unsupported");
  }
  if (typeof upstream.trustEmail !== "boolean") errors.push("upstream.trustEmail must be boolean");

  const endpointOverrides = upstream.endpointOverrides;
  if (endpointOverrides !== undefined) {
    if (!endpointOverrides || typeof endpointOverrides !== "object" || Array.isArray(endpointOverrides)) {
      errors.push("upstream.endpointOverrides must be an object");
    } else {
      const supportedOverrides = new Set(["tokenUrl", "jwksUrl", "userInfoUrl"]);
      for (const key of Object.keys(endpointOverrides)) {
        if (!supportedOverrides.has(key)) {
          errors.push(`upstream.endpointOverrides.${key} is not supported`);
        }
      }
      const allowInsecure = upstream.allowInsecureEndpointOverrides === true;
      for (const key of supportedOverrides) {
        if (endpointOverrides[key] !== undefined) {
          parseUrl(
            endpointOverrides[key],
            `upstream.endpointOverrides.${key}`,
            errors,
            { https: !allowInsecure },
          );
        }
      }
    }
  }
  if (
    upstream.allowInsecureEndpointOverrides !== undefined &&
    typeof upstream.allowInsecureEndpointOverrides !== "boolean"
  ) {
    errors.push("upstream.allowInsecureEndpointOverrides must be boolean");
  }

  if (errors.length) throw new Error(`Invalid AuthBridge configuration:\n- ${errors.join("\n- ")}`);
  return profile;
}

function requireSecret(env, name) {
  const value = env[name]?.trim();
  if (!value || PLACEHOLDER.test(value)) {
    throw new Error(`${name} is required; set it in auth-bridge/.env`);
  }
  return value;
}

function valueOrDefault(env, name, fallback) {
  const value = env[name]?.trim();
  return value || fallback;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function brokerCallbackUrl(config) {
  return `${normalizeBaseUrl(config.keycloak.publicUrl)}/realms/${encodeURIComponent(config.realm.name)}/broker/${encodeURIComponent(config.upstream.alias)}/endpoint`;
}

export async function loadConfig(options = {}) {
  const cwd = options.cwd ?? PROJECT_ROOT;
  const env = options.env ?? { ...process.env };
  await loadDotEnv(resolve(cwd, ".env"), env);

  const requestedPath = options.profilePath ?? env.AUTHBRIDGE_CONFIG ?? DEFAULT_PROFILE;
  const profilePath = isAbsolute(requestedPath) ? requestedPath : resolve(cwd, requestedPath);
  let profile;
  try {
    profile = JSON.parse(await readFile(profilePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in configuration profile: ${profilePath}`);
    throw error;
  }

  profile.keycloak ??= {};
  profile.resources ??= {};
  profile.upstream ??= {};
  if (env.AUTHBRIDGE_KEYCLOAK_ADMIN_URL) {
    profile.keycloak.adminUrl = env.AUTHBRIDGE_KEYCLOAK_ADMIN_URL;
  }
  if (env.AUTHBRIDGE_PUBLIC_URL) profile.keycloak.publicUrl = env.AUTHBRIDGE_PUBLIC_URL;
  if (env.AUTHBRIDGE_MCP_AUDIENCE) {
    profile.resources.mcpAudience = env.AUTHBRIDGE_MCP_AUDIENCE;
  } else if (env.AUTHBRIDGE_PUBLIC_URL) {
    profile.resources.mcpAudience = `${normalizeBaseUrl(env.AUTHBRIDGE_PUBLIC_URL)}/mcp`;
  }
  if (env.UPSTREAM_OIDC_DISCOVERY_URL) profile.upstream.discoveryUrl = env.UPSTREAM_OIDC_DISCOVERY_URL;
  validateProfile(profile);

  const config = {
    ...profile,
    keycloak: {
      ...profile.keycloak,
      adminUrl: normalizeBaseUrl(profile.keycloak.adminUrl),
      publicUrl: normalizeBaseUrl(profile.keycloak.publicUrl),
      adminUsername: valueOrDefault(env, "KEYCLOAK_ADMIN_USERNAME", "admin"),
      adminPassword: valueOrDefault(env, "KEYCLOAK_ADMIN_PASSWORD", "admin-local-only"),
    },
    upstream: {
      ...profile.upstream,
      discoveryUrl: normalizeBaseUrl(profile.upstream.discoveryUrl),
      clientId: requireSecret(env, "UPSTREAM_OIDC_CLIENT_ID"),
      clientSecret: requireSecret(env, "UPSTREAM_OIDC_CLIENT_SECRET"),
    },
    profilePath,
  };
  config.callbackUrl = brokerCallbackUrl(config);
  return deepFreeze(config);
}
