const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const cache = new Map();

async function responseJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`OAuth endpoint returned non-JSON data (${response.status})`);
  }
}

async function postForm(url, parameters, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  return { response, data: await responseJson(response) };
}

export async function discover(issuer, forceRefresh = false) {
  const cached = cache.get(issuer);
  if (!forceRefresh && cached && Date.now() - cached.loadedAt < 300_000) {
    return cached.value;
  }

  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const metadata = await responseJson(response);

  if (!response.ok) {
    throw new Error(`OIDC discovery failed (${response.status})`);
  }
  if (metadata.issuer !== issuer) {
    throw new Error(`Issuer mismatch: expected ${issuer}, received ${metadata.issuer}`);
  }
  for (const field of [
    "device_authorization_endpoint",
    "token_endpoint",
    "revocation_endpoint",
    "jwks_uri",
  ]) {
    if (typeof metadata[field] !== "string") {
      throw new Error(`OIDC discovery is missing ${field}`);
    }
  }

  cache.set(issuer, { value: metadata, loadedAt: Date.now() });
  return metadata;
}

export async function startDeviceAuthorization({ issuer, clientId, scope }) {
  const metadata = await discover(issuer);
  const { response, data } = await postForm(metadata.device_authorization_endpoint, {
    client_id: clientId,
    scope,
  });

  if (!response.ok) {
    const detail = data.error_description ?? data.error ?? response.statusText;
    throw new Error(`Device authorization failed (${response.status}): ${detail}`);
  }

  for (const field of ["device_code", "user_code", "verification_uri", "expires_in"]) {
    if (data[field] === undefined) {
      throw new Error(`Device authorization response is missing ${field}`);
    }
  }

  return { metadata, authorization: data };
}

function wait(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Device authorization cancelled"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error("Device authorization cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function pollDeviceToken({
  metadata,
  clientId,
  deviceCode,
  expiresIn,
  interval = 5,
  signal,
  onPoll,
}) {
  const deadline = Date.now() + Number(expiresIn) * 1000;
  let pollingInterval = Math.max(Number(interval) || 5, 1);

  while (Date.now() < deadline) {
    await wait(pollingInterval * 1000, signal);
    onPoll?.();

    const { response, data } = await postForm(
      metadata.token_endpoint,
      {
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: clientId,
      },
      signal,
    );

    if (response.ok) return withExpiry(data);

    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      pollingInterval += 5;
      continue;
    }
    if (data.error === "access_denied") {
      throw new Error("The user denied this login request");
    }
    if (data.error === "expired_token") {
      throw new Error("The device login code expired");
    }

    const detail = data.error_description ?? data.error ?? response.statusText;
    throw new Error(`Token request failed (${response.status}): ${detail}`);
  }

  throw new Error("The device login code expired");
}

export async function refreshToken({ issuer, clientId, refreshToken: token }) {
  const metadata = await discover(issuer);
  const { response, data } = await postForm(metadata.token_endpoint, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: token,
  });

  if (!response.ok) {
    const detail = data.error_description ?? data.error ?? response.statusText;
    throw new Error(`Token refresh failed (${response.status}): ${detail}`);
  }

  return withExpiry(data);
}

export async function revokeToken({ issuer, clientId, token, tokenTypeHint }) {
  const metadata = await discover(issuer);
  const { response, data } = await postForm(metadata.revocation_endpoint, {
    client_id: clientId,
    token,
    token_type_hint: tokenTypeHint,
  });

  if (!response.ok) {
    const detail = data.error_description ?? data.error ?? response.statusText;
    throw new Error(`Token revocation failed (${response.status}): ${detail}`);
  }
}

export function withExpiry(tokenSet) {
  return {
    ...tokenSet,
    expires_at: Date.now() + Number(tokenSet.expires_in ?? 0) * 1000,
  };
}
