import assert from "node:assert/strict";
import test from "node:test";

import { BrowserSession, formById, formWithInput, parseForms } from "../e2e/browser-session.mjs";

test("browser cookie jar separates Keycloak realms by cookie path", () => {
  const browser = new BrowserSession();
  const response = new Response(null, {
    headers: {
      "Set-Cookie": "AUTH_SESSION_ID=target-session; Path=/realms/authbridge/; Secure; HttpOnly",
    },
  });
  browser.updateCookies(response, new URL("http://localhost:8080/realms/authbridge/device"));

  assert.match(
    browser.cookieHeader(new URL("http://localhost:8080/realms/authbridge/login-actions/authenticate")),
    /AUTH_SESSION_ID=target-session/,
  );
  assert.equal(
    browser.cookieHeader(new URL("http://localhost:8090/realms/corporate-test/login-actions/authenticate")),
    "",
  );
});

test("secure cookies are usable on browser loopback origins", () => {
  const browser = new BrowserSession();
  const response = new Response(null, {
    headers: { "Set-Cookie": "KC_RESTART=value; Path=/; Secure" },
  });
  browser.updateCookies(response, new URL("http://localhost:8080/"));
  assert.equal(browser.cookieHeader(new URL("http://localhost:8080/next")), "KC_RESTART=value");
  assert.equal(browser.cookieHeader(new URL("http://example.test/next")), "");
});

test("form parser handles Keycloak input and button submit controls", () => {
  const html = `
    <form id="kc-form-login" method="post" action="/login?a=1&amp;b=2">
      <input type="hidden" name="code" value="device-code">
      <button type="submit" name="accept" value="Yes">Yes</button>
    </form>`;
  const forms = parseForms(html);
  assert.equal(forms.length, 1);
  assert.equal(formById(html, "kc-form-login").action, "/login?a=1&b=2");
  assert.equal(formWithInput(html, "accept").inputs.at(-1).value, "Yes");
});
