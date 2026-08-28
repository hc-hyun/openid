import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";

const discoveryCache = new Map();
const jwksCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export function randomUrlSafe(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OIDC endpoint returned non-JSON data (${response.status})`);
  }

  if (!response.ok) {
    const detail = data.error_description ?? data.error ?? response.statusText;
    throw new Error(`OIDC request failed (${response.status}): ${detail}`);
  }

  return data;
}

export async function discover(issuer, forceRefresh = false) {
  const normalizedIssuer = issuer.replace(/\/$/, "");
  const cached = discoveryCache.get(normalizedIssuer);

  if (!forceRefresh && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const configuration = await fetchJson(
    `${normalizedIssuer}/.well-known/openid-configuration`,
  );

  if (configuration.issuer !== normalizedIssuer) {
    throw new Error(
      `OIDC issuer mismatch: expected ${normalizedIssuer}, received ${configuration.issuer}`,
    );
  }

  for (const field of [
    "authorization_endpoint",
    "token_endpoint",
    "userinfo_endpoint",
    "jwks_uri",
  ]) {
    if (typeof configuration[field] !== "string") {
      throw new Error(`OIDC discovery is missing ${field}`);
    }
  }

  discoveryCache.set(normalizedIssuer, {
    value: configuration,
    loadedAt: Date.now(),
  });

  return configuration;
}

export function createAuthorizationRequest(configuration, options) {
  const state = randomUrlSafe();
  const nonce = randomUrlSafe();
  const codeVerifier = randomUrlSafe(64);
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const authorizationUrl = new URL(configuration.authorization_endpoint);

  authorizationUrl.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: options.scope,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    nonce,
    codeVerifier,
  };
}

export async function exchangeAuthorizationCode(configuration, options) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options.clientId,
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });

  const tokenSet = await fetchJson(configuration.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!tokenSet.id_token || !tokenSet.access_token) {
    throw new Error("Token response did not include an ID Token and access token");
  }

  return tokenSet;
}

function decodeJwtPart(value, label) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error(`ID Token contains an invalid ${label}`);
  }
}

async function getSigningKey(jwksUri, kid, forceRefresh = false) {
  let cached = jwksCache.get(jwksUri);

  if (forceRefresh || !cached || Date.now() - cached.loadedAt >= CACHE_TTL_MS) {
    cached = {
      value: await fetchJson(jwksUri),
      loadedAt: Date.now(),
    };
    jwksCache.set(jwksUri, cached);
  }

  let key = cached.value.keys?.find(
    (candidate) => candidate.kid === kid && candidate.kty === "RSA",
  );

  if (!key && !forceRefresh) {
    return getSigningKey(jwksUri, kid, true);
  }

  if (!key) {
    throw new Error(`No matching signing key was found for kid=${kid}`);
  }

  return key;
}

export async function verifyIdToken(idToken, options) {
  const parts = idToken.split(".");

  if (parts.length !== 3) {
    throw new Error("ID Token is not a compact JWT");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader, "header");
  const claims = decodeJwtPart(encodedPayload, "payload");

  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("ID Token must use an identified RS256 signing key");
  }

  const jwk = await getSigningKey(options.configuration.jwks_uri, header.kid);
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signatureValid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    Buffer.from(encodedSignature, "base64url"),
  );

  if (!signatureValid) {
    throw new Error("ID Token signature verification failed");
  }

  const now = Math.floor(Date.now() / 1000);

  if (claims.iss !== options.issuer) {
    throw new Error("ID Token issuer validation failed");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.clientId)) {
    throw new Error("ID Token audience validation failed");
  }

  if (
    audiences.length > 1 &&
    typeof claims.azp === "string" &&
    claims.azp !== options.clientId
  ) {
    throw new Error("ID Token authorized-party validation failed");
  }

  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) {
    throw new Error("ID Token is expired or has no valid expiry");
  }

  if (typeof claims.iat !== "number" || claims.iat > now + CLOCK_SKEW_SECONDS) {
    throw new Error("ID Token issued-at time is invalid");
  }

  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) {
    throw new Error("ID Token is not active yet");
  }

  if (claims.nonce !== options.nonce) {
    throw new Error("ID Token nonce validation failed");
  }

  if (typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("ID Token does not contain a valid subject");
  }

  return claims;
}

export async function getUserInfo(configuration, accessToken, expectedSubject) {
  const userInfo = await fetchJson(configuration.userinfo_endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (userInfo.sub !== expectedSubject) {
    throw new Error("UserInfo subject does not match the ID Token subject");
  }

  return userInfo;
}
