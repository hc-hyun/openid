import { createPublicKey, verify as verifySignature } from "node:crypto";

const metadataCache = new Map();
const metadataRefreshes = new Map();
const jwksCache = new Map();
const jwksRefreshes = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;
const CLOCK_SKEW_SECONDS = 60;

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${url}`);
  return data;
}

async function refreshMetadata(issuer) {
  let refresh = metadataRefreshes.get(issuer);
  if (!refresh) {
    refresh = fetchJson(`${issuer}/.well-known/openid-configuration`)
      .then((value) => {
        if (value.issuer !== issuer) throw new Error("OIDC discovery issuer mismatch");
        const cached = { value, loadedAt: Date.now() };
        metadataCache.set(issuer, cached);
        return cached;
      })
      .finally(() => metadataRefreshes.delete(issuer));
    metadataRefreshes.set(issuer, refresh);
  }
  return refresh;
}

async function getMetadata(issuer) {
  let cached = metadataCache.get(issuer);
  if (!cached || Date.now() - cached.loadedAt >= CACHE_TTL_MS) {
    cached = await refreshMetadata(issuer);
  }
  return cached.value;
}

async function refreshJwks(uri) {
  let refresh = jwksRefreshes.get(uri);
  if (!refresh) {
    refresh = fetchJson(uri)
      .then((value) => {
        const cached = { value, loadedAt: Date.now() };
        jwksCache.set(uri, cached);
        return cached;
      })
      .finally(() => jwksRefreshes.delete(uri));
    jwksRefreshes.set(uri, refresh);
  }
  return refresh;
}

async function getJwk(uri, kid) {
  let cached = jwksCache.get(uri);
  if (!cached || Date.now() - cached.loadedAt >= CACHE_TTL_MS) {
    cached = await refreshJwks(uri);
  }

  let key = cached.value.keys?.find(
    (candidate) => candidate.kid === kid && candidate.kty === "RSA",
  );
  if (!key && Date.now() - cached.loadedAt >= JWKS_REFRESH_COOLDOWN_MS) {
    cached = await refreshJwks(uri);
    key = cached.value.keys?.find(
      (candidate) => candidate.kid === kid && candidate.kty === "RSA",
    );
  }
  if (!key) throw new Error(`No matching signing key for kid=${kid}`);
  return key;
}

function decodePart(value, name) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error(`JWT has an invalid ${name}`);
  }
}

export async function verifyAccessToken(token, { issuer, audience }) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Access token is not a compact JWT");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodePart(encodedHeader, "header");
  const claims = decodePart(encodedPayload, "payload");
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("Access token must use an identified RS256 signing key");
  }

  const metadata = await getMetadata(issuer);
  const jwk = await getJwk(metadata.jwks_uri, header.kid);
  const valid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!valid) throw new Error("Access token signature verification failed");

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer) throw new Error("Access token issuer validation failed");
  if (!audiences.includes(audience)) throw new Error("Access token audience validation failed");
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) {
    throw new Error("Access token is expired or has no valid expiry");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) {
    throw new Error("Access token is not active yet");
  }
  if (typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("Access token has no valid subject");
  }

  return claims;
}

export function scopesFromClaims(claims) {
  return new Set(String(claims.scope ?? "").split(/\s+/).filter(Boolean));
}
