import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

const DEFAULT_PUBLIC_URL = "https://smart-dna.sec.samsung.net/ws2/30001";
const DEFAULT_BACKEND_URL = "http://localhost:8080";
const DEFAULT_CALLBACK_PATH = "/realms/authbridge/broker/company-oidc/endpoint";
const FORM_POST_LIMIT = 8 * 1024;
const DEFAULT_PROXY_BODY_LIMIT = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const HEALTH_PATH = "/healthz";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const FORM_PARAMETERS = new Set([
  "code",
  "state",
  "iss",
  "session_state",
  "error",
  "error_description",
  "error_uri",
]);

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parsePositiveInteger(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = value === undefined ? fallback : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum || String(parsed) !== String(value ?? parsed).trim()) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function parseHttpUrl(value, label, { requirePath = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, a query, or a fragment`);
  }
  if (requirePath && (!url.pathname || url.pathname === "/")) {
    throw new Error(`${label} must include a non-root public base prefix`);
  }
  return url;
}

function normalizePrefix(pathname) {
  const prefix = pathname.replace(/\/+$/, "");
  if (!prefix.startsWith("/") || prefix === "") {
    throw new Error("The public URL must include an absolute path prefix");
  }
  if (prefix.includes("//") || prefix.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("The public URL contains an invalid path prefix");
  }
  return prefix;
}

function normalizeBackendBase(pathname) {
  if (!pathname || pathname === "/") return "";
  return pathname.replace(/\/+$/, "");
}

function callbackRealmPath(callbackPath) {
  const match = callbackPath.match(/^(\/realms\/[^/]+)\/broker\/[^/]+\/endpoint$/);
  if (!match) throw new Error("The callback path must target one Keycloak realm and broker alias");
  return match[1];
}

export function loadGatewayConfig(env = process.env) {
  const publicUrl = parseHttpUrl(
    env.AUTHBRIDGE_GATEWAY_PUBLIC_URL ?? env.AUTHBRIDGE_PUBLIC_URL ?? DEFAULT_PUBLIC_URL,
    "AUTHBRIDGE_GATEWAY_PUBLIC_URL",
    { requirePath: true },
  );
  const backendUrl = parseHttpUrl(
    env.AUTHBRIDGE_KEYCLOAK_URL ?? DEFAULT_BACKEND_URL,
    "AUTHBRIDGE_KEYCLOAK_URL",
  );
  const port = parsePositiveInteger(env.AUTHBRIDGE_GATEWAY_PORT, 30001, "AUTHBRIDGE_GATEWAY_PORT", 65_535);
  const maxProxyBodyBytes = parsePositiveInteger(
    env.AUTHBRIDGE_GATEWAY_MAX_BODY_BYTES,
    DEFAULT_PROXY_BODY_LIMIT,
    "AUTHBRIDGE_GATEWAY_MAX_BODY_BYTES",
  );
  const timeoutMs = parsePositiveInteger(
    env.AUTHBRIDGE_GATEWAY_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "AUTHBRIDGE_GATEWAY_TIMEOUT_MS",
    120_000,
  );

  return Object.freeze({
    host: env.AUTHBRIDGE_GATEWAY_HOST?.trim() || "127.0.0.1",
    port,
    publicUrl,
    publicPrefix: normalizePrefix(publicUrl.pathname),
    backendUrl,
    backendBasePath: normalizeBackendBase(backendUrl.pathname),
    callbackPath: DEFAULT_CALLBACK_PATH,
    realmPath: callbackRealmPath(DEFAULT_CALLBACK_PATH),
    formPostLimit: FORM_POST_LIMIT,
    maxProxyBodyBytes,
    timeoutMs,
  });
}

function contentLength(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new RequestError(400, "Invalid Content-Length");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new RequestError(400, "Invalid Content-Length");
  return value;
}

async function readRequestBody(request, limit) {
  const declaredLength = contentLength(request);
  if (declaredLength !== undefined && declaredLength > limit) {
    throw new RequestError(413, "Request body is too large");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      request.destroy();
      throw new RequestError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function decodeFormComponent(raw) {
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) throw new RequestError(400, "Malformed form encoding");
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    throw new RequestError(400, "Malformed form encoding");
  }
}

export function parseOidcForm(body) {
  if (!Buffer.isBuffer(body)) throw new TypeError("body must be a Buffer");
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new RequestError(400, "Malformed UTF-8 form body");
  }
  if (!source) throw new RequestError(400, "The form body is empty");

  const parameters = new Map();
  for (const field of source.split("&")) {
    if (!field) throw new RequestError(400, "Malformed form field");
    const separator = field.indexOf("=");
    const rawName = separator < 0 ? field : field.slice(0, separator);
    const rawValue = separator < 0 ? "" : field.slice(separator + 1);
    const name = decodeFormComponent(rawName);
    const value = decodeFormComponent(rawValue);

    if (!FORM_PARAMETERS.has(name)) throw new RequestError(400, "Unknown form parameter");
    if (parameters.has(name)) throw new RequestError(400, "Duplicate form parameter");
    parameters.set(name, value);
  }

  if (!parameters.get("state")) throw new RequestError(400, "state is required");
  const hasCode = parameters.has("code");
  const hasError = parameters.has("error");
  if (hasCode === hasError) {
    throw new RequestError(400, "Exactly one of code or error is required");
  }
  if (!(hasCode ? parameters.get("code") : parameters.get("error"))) {
    throw new RequestError(400, "code or error must not be empty");
  }
  if (!hasError && (parameters.has("error_description") || parameters.has("error_uri"))) {
    throw new RequestError(400, "Error metadata requires error");
  }
  return parameters;
}

function requestMediaType(request) {
  return String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function connectionHeaders(headers) {
  const named = new Set(HOP_BY_HOP_HEADERS);
  for (const item of String(headers.connection ?? "").split(",")) {
    const name = item.trim().toLowerCase();
    if (name) named.add(name);
  }
  return named;
}

function upstreamHeaders(request, config, bodyLength) {
  const blocked = connectionHeaders(request.headers);
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (blocked.has(lower) || lower === "host" || lower.startsWith("x-forwarded-") || lower === "forwarded") continue;
    if (value !== undefined) headers[lower] = value;
  }

  const publicPort = config.publicUrl.port || (config.publicUrl.protocol === "https:" ? "443" : "80");
  headers.host = config.backendUrl.host;
  headers["x-forwarded-proto"] = config.publicUrl.protocol.slice(0, -1);
  headers["x-forwarded-host"] = config.publicUrl.host;
  headers["x-forwarded-port"] = publicPort;
  headers["x-forwarded-prefix"] = config.publicPrefix;
  headers["x-forwarded-for"] = request.socket.remoteAddress || "unknown";
  headers["content-length"] = String(bodyLength);
  delete headers["transfer-encoding"];
  return headers;
}

function responseHeaders(upstreamResponse) {
  const blocked = connectionHeaders(upstreamResponse.headers);
  const headers = {};
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    if (!blocked.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  return headers;
}

function backendPath(config, strippedPath, search = "") {
  return `${config.backendBasePath}${strippedPath}${search}` || "/";
}

function requestBackend(request, response, config, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const transport = config.backendUrl.protocol === "https:" ? https : http;
    const upstream = transport.request(
      {
        protocol: config.backendUrl.protocol,
        hostname: config.backendUrl.hostname,
        port: config.backendUrl.port || undefined,
        method,
        path,
        headers: upstreamHeaders(request, config, body.length),
        timeout: config.timeoutMs,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.statusMessage,
          responseHeaders(upstreamResponse),
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", resolve);
        upstreamResponse.once("error", reject);
      },
    );

    upstream.once("timeout", () => upstream.destroy(new Error("backend timeout")));
    upstream.once("error", reject);
    response.once("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    upstream.end(body);
  });
}

function sendError(response, statusCode, message) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ error: message }));
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function stripPublicPrefix(pathname, prefix) {
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return undefined;
}

function isPublicKeycloakPath(pathname, config) {
  return (
    pathname === config.realmPath ||
    pathname.startsWith(`${config.realmPath}/`) ||
    pathname === "/resources" ||
    pathname.startsWith("/resources/")
  );
}

async function handleFormPost(request, response, config, requestUrl) {
  if (requestUrl.search) throw new RequestError(400, "Callback query parameters are not allowed");
  if (requestMediaType(request) !== "application/x-www-form-urlencoded") {
    throw new RequestError(415, "Content-Type must be application/x-www-form-urlencoded");
  }
  const body = await readRequestBody(request, config.formPostLimit);
  const parameters = parseOidcForm(body);
  const query = new URLSearchParams(parameters).toString();
  await requestBackend(request, response, config, {
    method: "GET",
    path: backendPath(config, config.callbackPath, `?${query}`),
    body: Buffer.alloc(0),
  });
}

async function handleProxy(request, response, config, requestUrl, strippedPath) {
  const body = await readRequestBody(request, config.maxProxyBodyBytes);
  await requestBackend(request, response, config, {
    method: request.method,
    path: backendPath(config, strippedPath, requestUrl.search),
    body,
  });
}

function normalizedConfig(options) {
  if (!options) return loadGatewayConfig();
  const defaults = loadGatewayConfig({});
  const publicUrl = options.publicUrl instanceof URL
    ? new URL(options.publicUrl)
    : parseHttpUrl(options.publicUrl ?? defaults.publicUrl.href, "publicUrl", { requirePath: true });
  const backendUrl = options.backendUrl instanceof URL
    ? new URL(options.backendUrl)
    : parseHttpUrl(options.backendUrl ?? defaults.backendUrl.href, "backendUrl");
  return Object.freeze({
    ...defaults,
    ...options,
    publicUrl,
    publicPrefix: options.publicPrefix ?? normalizePrefix(publicUrl.pathname),
    backendUrl,
    backendBasePath: options.backendBasePath ?? normalizeBackendBase(backendUrl.pathname),
    realmPath: options.realmPath ?? callbackRealmPath(options.callbackPath ?? defaults.callbackPath),
  });
}

export function createGateway(options) {
  const config = normalizedConfig(options);
  const logger = options?.logger ?? console;

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://gateway.invalid");
      if (requestUrl.pathname === HEALTH_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.setHeader("allow", "GET, HEAD");
          throw new RequestError(405, "Method not allowed");
        }
        const body = request.method === "HEAD" ? Buffer.alloc(0) : Buffer.from('{"status":"ok"}');
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "content-length": body.length,
        });
        response.end(body);
        return;
      }

      const strippedPath = stripPublicPrefix(requestUrl.pathname, config.publicPrefix);
      if (strippedPath === undefined) throw new RequestError(404, "Not found");
      if (!isPublicKeycloakPath(strippedPath, config)) throw new RequestError(404, "Not found");

      if (request.method === "POST" && strippedPath === config.callbackPath) {
        await handleFormPost(request, response, config, requestUrl);
      } else {
        await handleProxy(request, response, config, requestUrl, strippedPath);
      }
    } catch (error) {
      if (error instanceof RequestError) {
        sendError(response, error.statusCode, error.message);
      } else {
        logger.error?.("AuthBridge gateway request failed");
        sendError(response, 502, "Bad gateway");
      }
    }
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

export async function startGateway(env = process.env, logger = console) {
  const config = loadGatewayConfig(env);
  const server = createGateway({ ...config, logger });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  logger.info?.(`AuthBridge gateway listening on ${config.host}:${config.port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().then((server) => {
    const stop = () => server.close(() => process.exit(0));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }).catch(() => {
    console.error("AuthBridge gateway failed to start");
    process.exitCode = 1;
  });
}
