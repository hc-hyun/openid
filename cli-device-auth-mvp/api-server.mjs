import http from "node:http";
import { config } from "./lib/config.mjs";
import { scopesFromClaims, verifyAccessToken } from "./lib/jwt.mjs";

const host = process.env.SKILLS_API_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.SKILLS_API_PORT ?? "3200", 10);
const publicUrl = (process.env.SKILLS_API_PUBLIC_URL ?? `http://localhost:${port}`).replace(
  /\/$/,
  "",
);
const apiMetadataUrl = `${publicUrl}/.well-known/oauth-protected-resource`;
const mcpMetadataUrl = `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
const MCP_PROTOCOL_VERSION = "2026-07-28";
const allowedMcpOrigins = new Set(
  (process.env.SKILLS_MCP_ALLOWED_ORIGINS ?? new URL(publicUrl).origin)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function bearerToken(request) {
  const match = request.headers.authorization?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1];
}

function validateMcpOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin || allowedMcpOrigins.has(origin)) return true;
  sendJson(response, 403, {
    error: "invalid_origin",
    error_description: "The Origin header is not allowed for this MCP server",
  });
  return false;
}

function challenge(response, status, error, description, scope, resourceMetadata) {
  const parameters = [
    `realm="skills-api"`,
    `resource_metadata="${resourceMetadata}"`,
    `error="${error}"`,
    `error_description="${description.replaceAll('"', "'")}"`,
  ];
  if (scope) parameters.push(`scope="${scope}"`);
  sendJson(
    response,
    status,
    { error, error_description: description },
    { "WWW-Authenticate": `Bearer ${parameters.join(", ")}` },
  );
}

async function authorize(
  request,
  response,
  { requiredScope, requiredRole, audience, resourceMetadata },
) {
  const token = bearerToken(request);
  if (!token) {
    challenge(
      response,
      401,
      "invalid_token",
      "A Bearer access token is required",
      requiredScope,
      resourceMetadata,
    );
    return undefined;
  }

  let claims;
  try {
    claims = await verifyAccessToken(token, { issuer: config.issuer, audience });
  } catch (error) {
    challenge(response, 401, "invalid_token", error.message, requiredScope, resourceMetadata);
    return undefined;
  }

  if (!scopesFromClaims(claims).has(requiredScope)) {
    challenge(
      response,
      403,
      "insufficient_scope",
      `Required scope: ${requiredScope}`,
      requiredScope,
      resourceMetadata,
    );
    return undefined;
  }

  const roles = new Set(claims.realm_access?.roles ?? []);
  if (requiredRole && !roles.has(requiredRole)) {
    challenge(
      response,
      403,
      "insufficient_scope",
      `Required realm role: ${requiredRole}`,
      requiredScope,
      resourceMetadata,
    );
    return undefined;
  }

  return claims;
}

function identity(claims) {
  return {
    subject: claims.sub,
    username: claims.preferred_username,
    name: claims.name,
    email: claims.email,
    roles: claims.realm_access?.roles ?? [],
    scopes: Array.from(scopesFromClaims(claims)),
    clientId: claims.azp,
    audience: claims.aud,
    issuer: claims.iss,
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function mcpResult(message, claims) {
  const id = message?.id ?? null;
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
  if (message.method === "initialize") {
    if (typeof message.params?.protocolVersion !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "initialize requires params.protocolVersion" },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "skills-auth-mvp", version: "1.0.0" },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "whoami",
            description: "Return the identity authorized for this MCP request",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    };
  }
  if (message.method === "tools/call" && message.params?.name === "whoami") {
    const value = identity(claims);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, publicUrl);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "UP" });
      return;
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      const isMcpMetadata = url.pathname.endsWith("/mcp");
      sendJson(response, 200, {
        resource: isMcpMetadata ? `${publicUrl}/mcp` : publicUrl,
        authorization_servers: [config.issuer],
        scopes_supported: isMcpMetadata ? ["mcp.tools"] : ["skills.read"],
        bearer_methods_supported: ["header"],
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/me") {
      const claims = await authorize(request, response, {
        requiredScope: "skills.read",
        requiredRole: "tester",
        audience: config.audience,
        resourceMetadata: apiMetadataUrl,
      });
      if (claims) sendJson(response, 200, { authenticated: true, user: identity(claims) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/mcp") {
      if (!validateMcpOrigin(request, response)) return;
      sendJson(
        response,
        405,
        { error: "method_not_allowed", error_description: "SSE is not supported" },
        { Allow: "POST" },
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      if (!validateMcpOrigin(request, response)) return;
      const claims = await authorize(request, response, {
        requiredScope: "mcp.tools",
        requiredRole: "tester",
        audience: config.mcpAudience,
        resourceMetadata: mcpMetadataUrl,
      });
      if (!claims) return;
      if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") {
        sendJson(response, 415, { error: "unsupported_media_type" });
        return;
      }
      const message = await readJson(request);
      const protocolVersion = request.headers["mcp-protocol-version"];
      if (message?.method !== "initialize" && protocolVersion !== MCP_PROTOCOL_VERSION) {
        sendJson(response, 400, {
          error: "invalid_protocol_version",
          error_description: `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`,
        });
        return;
      }
      if (message?.method?.startsWith("notifications/") && message.id === undefined) {
        response.writeHead(202, { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION }).end();
        return;
      }
      sendJson(response, 200, mcpResult(message, claims), {
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, 400, { error: "bad_request", error_description: error.message });
    } else {
      response.destroy();
    }
  }
});

server.listen(port, host, () => {
  console.log(`Protected API + MCP: ${publicUrl}`);
  console.log(`Issuer: ${config.issuer}`);
  console.log(`Audience: ${config.audience}`);
  console.log(`MCP audience: ${config.mcpAudience}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
