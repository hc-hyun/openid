import assert from "node:assert/strict";
import test from "node:test";

import { KeycloakAdmin } from "../lib/keycloak-admin.mjs";
import { maskKnownSecrets, redact, redactText, REDACTED } from "../lib/redact.mjs";

const secret = "never-show-this-secret";

function config() {
  return {
    keycloak: {
      adminUrl: "http://localhost:8080",
      adminRealm: "master",
      adminClientId: "admin-cli",
      adminUsername: "admin",
      adminPassword: "admin-password",
      requestTimeoutMs: 10_000,
    },
    realm: { name: "authbridge" },
    upstream: {
      alias: "company-oidc",
      displayName: "Company login",
      clientId: "issued-client",
      clientSecret: secret,
      clientAuthMethod: "client_secret_post",
      defaultScope: "openid profile email",
      responseMode: "form_post",
      syncMode: "IMPORT",
      trustEmail: false,
    },
  };
}

test("redact recursively masks sensitive fields and bearer/form tokens", () => {
  const value = {
    clientId: "safe",
    clientSecret: secret,
    nested: {
      Authorization: "Bearer abc.def.ghi",
      message: "client_secret=visible&other=true",
    },
  };
  const result = redact(value);
  assert.equal(result.clientId, "safe");
  assert.equal(result.clientSecret, REDACTED);
  assert.equal(result.nested.Authorization, REDACTED);
  assert.doesNotMatch(result.nested.message, /visible/);
  assert.doesNotMatch(JSON.stringify(result), /abc\.def|never-show/);
});

test("known secret masking catches a server reflection without a field name", () => {
  assert.equal(maskKnownSecrets(`upstream rejected ${secret}`, [secret]), `upstream rejected ${REDACTED}`);
  assert.equal(redactText("Authorization: Bearer token-value"), `Authorization: Bearer ${REDACTED}`);
});

test("Keycloak REST errors never expose configured secrets", async () => {
  const admin = new KeycloakAdmin(config(), {
    fetch: async () =>
      new Response(JSON.stringify({ error: `invalid ${secret}`, clientSecret: secret }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    log: { log() {} },
  });

  await assert.rejects(admin.request("/admin/test"), (error) => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
});

test("identity provider provisioning logs only the non-secret alias", async () => {
  const messages = [];
  const responses = [new Response(null, { status: 404 }), new Response(null, { status: 201 })];
  const admin = new KeycloakAdmin(config(), {
    fetch: async () => responses.shift(),
    log: { log(message) { messages.push(message); } },
  });
  await admin.ensureIdentityProvider({
    issuer: "https://idp.example/adfs",
    authorization_endpoint: "https://idp.example/adfs/authorize",
    token_endpoint: "https://idp.example/adfs/token",
    jwks_uri: "https://idp.example/adfs/keys",
    response_types_supported: ["code"],
    response_modes_supported: ["form_post"],
  });
  assert.deepEqual(messages, ["created identity provider: company-oidc"]);
  assert.doesNotMatch(messages.join("\n"), new RegExp(secret));
});
