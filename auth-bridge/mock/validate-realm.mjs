import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const realmPath = new URL("./corporate-test-realm.json", import.meta.url);
const realm = JSON.parse(await readFile(realmPath, "utf8"));

assert.equal(realm.realm, "corporate-test", "unexpected realm name");
assert.equal(realm.enabled, true, "mock realm must be enabled");

const clients = realm.clients.filter(
  ({ clientId }) => clientId === "authbridge-broker",
);
assert.equal(clients.length, 1, "authbridge-broker client must exist exactly once");

const [client] = clients;
assert.equal(client.protocol, "openid-connect");
assert.equal(client.publicClient, false, "broker client must be confidential");
assert.equal(client.bearerOnly, false);
assert.equal(client.clientAuthenticatorType, "client-secret");
assert.equal(client.secret, "mock-corporate-secret");
assert.equal(client.standardFlowEnabled, true, "authorization code flow must be enabled");
assert.equal(client.implicitFlowEnabled, false, "implicit flow must stay disabled");
assert.equal(client.directAccessGrantsEnabled, false, "password grant must stay disabled");
assert.equal(client.serviceAccountsEnabled, false);

const brokerEndpoint =
  "http://localhost:8080/realms/authbridge/broker/company-oidc/endpoint";
assert(client.redirectUris.includes(brokerEndpoint), "exact broker callback is missing");
assert(
  client.redirectUris.includes(
    "http://localhost:8080/realms/authbridge/broker/company-oidc/*",
  ),
  "broker callback prefix is missing",
);
assert(
  client.redirectUris.includes(
    "http://localhost:8180/ws2/30001/realms/authbridge/broker/company-oidc/*",
  ),
  "temporary public-prefix callback is missing",
);

const requiredClaimMappers = new Map([
  ["preferred_username", "oidc-usermodel-property-mapper"],
  ["email", "oidc-usermodel-property-mapper"],
  ["name", "oidc-full-name-mapper"],
]);

for (const [claimName, mapperType] of requiredClaimMappers) {
  const mapper = client.protocolMappers.find(({ protocolMapper, config }) => {
    if (protocolMapper !== mapperType) return false;
    return mapperType === "oidc-full-name-mapper"
      ? true
      : config["claim.name"] === claimName;
  });

  assert(mapper, `${claimName} mapper is missing`);
  assert.equal(mapper.protocol, "openid-connect");
  assert.equal(mapper.config["id.token.claim"], "true", `${claimName} must be in ID tokens`);
}

const users = realm.users.filter(({ username }) => username === "company-user");
assert.equal(users.length, 1, "company-user must exist exactly once");

const [user] = users;
assert.equal(user.enabled, true);
assert.equal(user.emailVerified, true, "test user's email must be verified");
assert.equal(user.firstName, "Company");
assert.equal(user.lastName, "User");
assert.equal(user.email, "company-user@corporate.example");
assert.deepEqual(user.credentials, [
  {
    type: "password",
    value: "company-password-local-only",
    temporary: false,
  },
]);

console.log("Mock corporate OIDC realm validation passed.");
