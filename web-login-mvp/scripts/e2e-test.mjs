const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const username = process.env.MVP_TEST_USERNAME ?? "mvp-user";
const password = process.env.MVP_TEST_PASSWORD ?? "mvp-password-local-only";
const cookies = new Map();

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
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = {};
    }
  }

  throw new Error("Too many redirects");
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

const health = await fetch(`${appUrl}/health`, { signal: AbortSignal.timeout(3_000) });
if (!health.ok) throw new Error("MVP server health check failed");

const loginPage = await browserRequest(`${appUrl}/login`);
const loginHtml = await loginPage.text();
const formMatch = loginHtml.match(
  /<form[^>]+id=["']kc-form-login["'][^>]+action=["']([^"']+)["']/i,
);

if (!formMatch) {
  throw new Error(`Could not find the Keycloak login form at ${loginPage.url}`);
}

const credentials = new URLSearchParams({
  username,
  password,
  credentialId: "",
});
const authenticatedPage = await browserRequest(decodeHtmlAttribute(formMatch[1]), {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: credentials,
});
await authenticatedPage.arrayBuffer();

const sessionResponse = await browserRequest(`${appUrl}/api/session`);
const session = await sessionResponse.json();

if (!session.authenticated) throw new Error("The application session is not authenticated");
if (session.userInfo.preferred_username !== username) {
  throw new Error(`Unexpected user: ${session.userInfo.preferred_username}`);
}
if (session.claims.azp !== "oidc-mvp-web") {
  throw new Error(`Unexpected authorized party: ${session.claims.azp}`);
}

await (await browserRequest(`${appUrl}/logout`)).arrayBuffer();
const loggedOutSession = await (await browserRequest(`${appUrl}/api/session`)).json();
if (loggedOutSession.authenticated) throw new Error("The application session survived logout");

console.log("OK: browser redirect, PKCE code exchange, ID Token, UserInfo, and logout succeeded.");
