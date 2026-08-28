import { readFile } from "node:fs/promises";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  createAuthorizationRequest,
  discover,
  exchangeAuthorizationCode,
  getUserInfo,
  randomUrlSafe,
  verifyIdToken,
} from "./lib/oidc.mjs";

const config = {
  host: process.env.APP_HOST ?? "127.0.0.1",
  port: Number.parseInt(process.env.APP_PORT ?? "3000", 10),
  issuer: (process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/oidc-test").replace(
    /\/$/,
    "",
  ),
  clientId: process.env.OIDC_CLIENT_ID ?? "oidc-mvp-web",
  redirectUri: process.env.OIDC_REDIRECT_URI ?? "http://localhost:3000/callback",
  postLogoutRedirectUri:
    process.env.OIDC_POST_LOGOUT_REDIRECT_URI ?? "http://localhost:3000/",
  scope: process.env.OIDC_SCOPE ?? "openid profile email roles",
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error("APP_PORT must be a valid TCP port");
}

const styles = await readFile(new URL("./public/styles.css", import.meta.url), "utf8");
const sessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;
const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;
const COOKIE_NAME = "oidc_mvp_session";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseCookies(request) {
  const result = {};

  for (const item of (request.headers.cookie ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    result[item.slice(0, separator).trim()] = decodeURIComponent(
      item.slice(separator + 1).trim(),
    );
  }

  return result;
}

function setSessionCookie(response, sessionId) {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
  );
}

function clearSessionCookie(response) {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

function getSession(request, response, create = true) {
  const candidate = parseCookies(request)[COOKIE_NAME];
  let session = candidate ? sessions.get(candidate) : undefined;

  if (session && Date.now() - session.lastSeen < SESSION_TTL_MS) {
    session.lastSeen = Date.now();
    return { id: candidate, value: session };
  }

  if (candidate) sessions.delete(candidate);
  if (!create) return { id: undefined, value: undefined };

  const id = randomUrlSafe();
  session = { createdAt: Date.now(), lastSeen: Date.now() };
  sessions.set(id, session);
  setSessionCookie(response, id);
  return { id, value: session };
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function setSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}

function sendHtml(response, html, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

function sendJson(response, body, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function redirect(response, location) {
  response.statusCode = 302;
  response.setHeader("Location", location);
  response.end();
}

function page(title, body) {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · OIDC MVP</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <div class="ambient ambient-one"></div>
    <div class="ambient ambient-two"></div>
    <main class="shell">
      <header class="site-header">
        <a class="brand" href="/" aria-label="OIDC MVP 홈">
          <span class="brand-mark">ID</span>
          <span>OIDC Login MVP</span>
        </a>
        <span class="environment"><i></i> LOCAL</span>
      </header>
      ${body}
      <footer>Keycloak · Authorization Code + PKCE · Server-side session</footer>
    </main>
  </body>
</html>`;
}

function guestPage() {
  return page(
    "로그인",
    `<section class="hero">
      <div class="eyebrow">OPENID CONNECT DEMO</div>
      <h1>한 번의 리다이렉트로<br><span>인증 정보를 확인하세요.</span></h1>
      <p class="hero-copy">Keycloak 로그인 화면에서 인증한 뒤, 검증된 ID Token claims와 UserInfo 응답을 이 화면에서 확인합니다.</p>
      <a class="button primary" href="/login">
        <span>Keycloak으로 로그인</span><span aria-hidden="true">→</span>
      </a>
    </section>
    <section class="info-grid">
      <article class="info-card">
        <span class="info-label">ISSUER</span>
        <strong>${escapeHtml(config.issuer)}</strong>
      </article>
      <article class="info-card">
        <span class="info-label">CLIENT</span>
        <strong>${escapeHtml(config.clientId)}</strong>
      </article>
      <article class="info-card">
        <span class="info-label">FLOW</span>
        <strong>Code + PKCE S256</strong>
      </article>
    </section>`,
  );
}

function authenticatedPage(auth) {
  const displayName =
    auth.userInfo.name ??
    auth.userInfo.preferred_username ??
    auth.claims.preferred_username ??
    "Authenticated User";
  const username =
    auth.userInfo.preferred_username ?? auth.claims.preferred_username ?? "-";
  const roles = auth.claims.realm_access?.roles ?? [];
  const initial = Array.from(displayName)[0]?.toUpperCase() ?? "U";

  return page(
    "인증 완료",
    `<section class="success-banner">
      <div class="avatar">${escapeHtml(initial)}</div>
      <div class="identity">
        <span class="verified"><i>✓</i> 인증 완료</span>
        <h1>${escapeHtml(displayName)}</h1>
        <p>${escapeHtml(auth.userInfo.email ?? "email claim 없음")}</p>
      </div>
      <a class="button secondary" href="/logout">로그아웃</a>
    </section>

    <section class="claim-summary">
      <article><span>Username</span><strong>${escapeHtml(username)}</strong></article>
      <article><span>Subject</span><strong class="mono truncate" title="${escapeHtml(auth.claims.sub)}">${escapeHtml(auth.claims.sub)}</strong></article>
      <article><span>Realm roles</span><strong>${escapeHtml(roles.join(", ") || "-")}</strong></article>
      <article><span>Expires</span><strong>${escapeHtml(auth.token.expiresAt)}</strong></article>
    </section>

    <section class="payload-grid">
      <article class="payload-card">
        <div class="payload-heading">
          <div><span class="dot violet"></span><strong>ID Token claims</strong></div>
          <span>서명 검증 완료</span>
        </div>
        <pre>${escapeHtml(JSON.stringify(auth.claims, null, 2))}</pre>
      </article>
      <article class="payload-card">
        <div class="payload-heading">
          <div><span class="dot cyan"></span><strong>UserInfo</strong></div>
          <span>Bearer API 응답</span>
        </div>
        <pre>${escapeHtml(JSON.stringify(auth.userInfo, null, 2))}</pre>
      </article>
    </section>

    <section class="token-strip">
      <div><span>Token type</span><strong>${escapeHtml(auth.token.tokenType)}</strong></div>
      <div><span>Scope</span><strong>${escapeHtml(auth.token.scope)}</strong></div>
      <div><span>Refresh token</span><strong>${auth.token.hasRefreshToken ? "발급됨" : "없음"}</strong></div>
      <a href="/api/session">JSON으로 보기 →</a>
    </section>`,
  );
}

function errorPage(message) {
  return page(
    "인증 오류",
    `<section class="error-card">
      <span class="error-icon">!</span>
      <div>
        <div class="eyebrow">AUTHENTICATION ERROR</div>
        <h1>로그인을 완료하지 못했습니다.</h1>
        <p>${escapeHtml(message)}</p>
        <a class="button primary" href="/">처음으로 돌아가기</a>
      </div>
    </section>`,
  );
}

async function handleRequest(request, response) {
  setSecurityHeaders(response);
  const requestUrl = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

  if (request.method !== "GET") {
    sendJson(response, { error: "method_not_allowed" }, 405);
    return;
  }

  if (requestUrl.pathname === "/styles.css") {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/css; charset=utf-8");
    response.end(styles);
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(response, { status: "UP" });
    return;
  }

  if (requestUrl.pathname === "/") {
    const { value: session } = getSession(request, response);
    sendHtml(response, session.auth ? authenticatedPage(session.auth) : guestPage());
    return;
  }

  if (requestUrl.pathname === "/login") {
    const { value: session } = getSession(request, response);
    const configuration = await discover(config.issuer);
    const authRequest = createAuthorizationRequest(configuration, config);

    session.authRequest = {
      state: authRequest.state,
      nonce: authRequest.nonce,
      codeVerifier: authRequest.codeVerifier,
      createdAt: Date.now(),
    };

    redirect(response, authRequest.authorizationUrl);
    return;
  }

  if (requestUrl.pathname === "/callback") {
    const { value: session } = getSession(request, response, false);
    const oidcError = requestUrl.searchParams.get("error");

    if (oidcError) {
      const detail = requestUrl.searchParams.get("error_description") ?? oidcError;
      sendHtml(response, errorPage(detail), 400);
      return;
    }

    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const pending = session?.authRequest;

    if (
      !session ||
      !pending ||
      !code ||
      !safeEqual(state, pending.state) ||
      Date.now() - pending.createdAt > LOGIN_REQUEST_TTL_MS
    ) {
      if (session) delete session.authRequest;
      sendHtml(response, errorPage("로그인 요청이 만료되었거나 state가 일치하지 않습니다."), 400);
      return;
    }

    delete session.authRequest;
    const configuration = await discover(config.issuer);
    const tokenSet = await exchangeAuthorizationCode(configuration, {
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      code,
      codeVerifier: pending.codeVerifier,
    });
    const claims = await verifyIdToken(tokenSet.id_token, {
      configuration,
      issuer: config.issuer,
      clientId: config.clientId,
      nonce: pending.nonce,
    });
    const userInfo = await getUserInfo(
      configuration,
      tokenSet.access_token,
      claims.sub,
    );

    session.auth = {
      idToken: tokenSet.id_token,
      claims,
      userInfo,
      token: {
        tokenType: tokenSet.token_type ?? "Bearer",
        scope: tokenSet.scope ?? config.scope,
        hasRefreshToken: Boolean(tokenSet.refresh_token),
        expiresAt: new Date(
          Date.now() + Number(tokenSet.expires_in ?? 0) * 1000,
        ).toISOString(),
      },
    };

    redirect(response, "/");
    return;
  }

  if (requestUrl.pathname === "/api/session") {
    const { value: session } = getSession(request, response);

    if (!session.auth) {
      sendJson(response, { authenticated: false });
      return;
    }

    sendJson(response, {
      authenticated: true,
      claims: session.auth.claims,
      userInfo: session.auth.userInfo,
      token: session.auth.token,
    });
    return;
  }

  if (requestUrl.pathname === "/logout") {
    const { id, value: session } = getSession(request, response, false);
    const idToken = session?.auth?.idToken;

    if (id) sessions.delete(id);
    clearSessionCookie(response);

    if (!idToken) {
      redirect(response, "/");
      return;
    }

    const configuration = await discover(config.issuer);
    if (!configuration.end_session_endpoint) {
      redirect(response, "/");
      return;
    }

    const logoutUrl = new URL(configuration.end_session_endpoint);
    logoutUrl.search = new URLSearchParams({
      id_token_hint: idToken,
      post_logout_redirect_uri: config.postLogoutRedirectUri,
    }).toString();
    redirect(response, logoutUrl.toString());
    return;
  }

  sendHtml(response, errorPage("요청한 페이지를 찾을 수 없습니다."), 404);
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) {
      setSecurityHeaders(response);
      sendHtml(response, errorPage("인증 서버 통신 중 오류가 발생했습니다."), 500);
    } else {
      response.destroy();
    }
  });
});

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastSeen < cutoff) sessions.delete(id);
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

server.listen(config.port, config.host, () => {
  console.log(`OIDC Login MVP: http://localhost:${config.port}`);
  console.log(`Issuer: ${config.issuer}`);
  console.log(`Client: ${config.clientId}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
