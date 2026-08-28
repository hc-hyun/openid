import assert from "node:assert/strict";
import test from "node:test";

import { fetchDiscovery } from "../lib/keycloak-admin.mjs";
import {
  apiClientRepresentation,
  audienceMapperRepresentations,
  cliClientRepresentation,
  hardcodedTesterMapperRepresentation,
  identityProviderRepresentation,
  realmRepresentation,
  redirectorConfigRepresentation,
  validateDiscovery,
} from "../lib/representations.mjs";

const config = {
  realm: {
    name: "authbridge",
    displayName: "AuthBridge",
    sslRequired: "external",
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 36000,
  },
  clients: { cli: "skills-cli", api: "skills-api" },
  resources: { mcpAudience: "https://service.example/mcp" },
  upstream: {
    alias: "company-oidc",
    displayName: "Company login",
    clientId: "issued-client",
    clientSecret: "issued-secret",
    clientAuthMethod: "client_secret_post",
    defaultScope: "openid profile email",
    responseMode: "query",
    syncMode: "IMPORT",
    trustEmail: false,
  },
};

const discovery = {
  issuer: "https://idp.example/adfs",
  authorization_endpoint: "https://idp.example/adfs/oauth2/authorize?api-version=1",
  token_endpoint: "https://idp.example/adfs/oauth2/token",
  jwks_uri: "https://idp.example/adfs/discovery/keys",
  userinfo_endpoint: "https://idp.example/adfs/userinfo",
  end_session_endpoint: "https://idp.example/adfs/logout",
  response_types_supported: ["code"],
  response_modes_supported: ["query", "form_post"],
};

test("realm and clients enforce dedicated Device Flow/bearer-only boundaries", () => {
  assert.equal(realmRepresentation(config).realm, "authbridge");

  const cli = cliClientRepresentation(config);
  assert.equal(cli.publicClient, true);
  assert.equal(cli.standardFlowEnabled, false);
  assert.equal(cli.directAccessGrantsEnabled, false);
  assert.equal(cli.attributes["oauth2.device.authorization.grant.enabled"], "true");

  const api = apiClientRepresentation(config);
  assert.equal(api.bearerOnly, true);
  assert.equal(api.serviceAccountsEnabled, false);
});

test("audience mappers add API and exact MCP resource audiences to access tokens", () => {
  const [api, mcp] = audienceMapperRepresentations(config);
  assert.equal(api.config["included.client.audience"], "skills-api");
  assert.equal(mcp.config["included.custom.audience"], "https://service.example/mcp");
  assert.equal(api.config["access.token.claim"], "true");
  assert.equal(mcp.config["id.token.claim"], "false");
});

test("OIDC broker representation is discovery-driven and forces query mode in authorization URL", () => {
  const representation = identityProviderRepresentation(config, discovery);
  const authorizationUrl = new URL(representation.config.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get("api-version"), "1");
  assert.equal(authorizationUrl.searchParams.get("response_mode"), "query");
  assert.equal(representation.config.tokenUrl, discovery.token_endpoint);
  assert.equal(representation.config.jwksUrl, discovery.jwks_uri);
  assert.equal(representation.config.clientSecret, "issued-secret");
  assert.equal(representation.storeToken, false);
  assert.equal(representation.config.responseMode, undefined);
});

test("mock back-channel overrides do not change issuer or browser authorization endpoint", () => {
  const mockConfig = {
    ...config,
    upstream: {
      ...config.upstream,
      allowInsecureEndpointOverrides: true,
      endpointOverrides: {
        tokenUrl: "http://corporate-oidc:8080/realms/corporate-test/protocol/openid-connect/token",
        jwksUrl: "http://corporate-oidc:8080/realms/corporate-test/protocol/openid-connect/certs",
        userInfoUrl: "http://corporate-oidc:8080/realms/corporate-test/protocol/openid-connect/userinfo",
      },
    },
  };
  const mockDiscovery = {
    ...discovery,
    issuer: "http://localhost:8090/realms/corporate-test",
    authorization_endpoint:
      "http://localhost:8090/realms/corporate-test/protocol/openid-connect/auth",
    token_endpoint: "http://localhost:8090/realms/corporate-test/protocol/openid-connect/token",
    jwks_uri: "http://localhost:8090/realms/corporate-test/protocol/openid-connect/certs",
    userinfo_endpoint:
      "http://localhost:8090/realms/corporate-test/protocol/openid-connect/userinfo",
  };

  const representation = identityProviderRepresentation(mockConfig, mockDiscovery);
  assert.equal(representation.config.issuer, mockDiscovery.issuer);
  const authorizationUrl = new URL(representation.config.authorizationUrl);
  assert.equal(authorizationUrl.origin, "http://localhost:8090");
  assert.equal(authorizationUrl.searchParams.get("response_mode"), "query");
  assert.equal(representation.config.tokenUrl, mockConfig.upstream.endpointOverrides.tokenUrl);
  assert.equal(representation.config.jwksUrl, mockConfig.upstream.endpointOverrides.jwksUrl);
  assert.equal(representation.config.userInfoUrl, mockConfig.upstream.endpointOverrides.userInfoUrl);
});

test("discovery and configured response mode are validated", () => {
  assert.equal(validateDiscovery(discovery), discovery);
  assert.throws(
    () => validateDiscovery({ ...discovery, response_types_supported: ["id_token"] }),
    /response_type=code/,
  );
  assert.throws(
    () => validateDiscovery({ ...discovery, token_endpoint: "http://idp.example/token" }),
    /token_endpoint must use HTTPS/,
  );
  assert.equal(
    validateDiscovery(
      { ...discovery, issuer: "http://localhost:8090/realms/test" },
      { allowInsecure: true },
    ).issuer,
    "http://localhost:8090/realms/test",
  );
  assert.throws(
    () =>
      identityProviderRepresentation(config, {
        ...discovery,
        response_modes_supported: ["form_post"],
      }),
    /response_mode=query/,
  );
});

test("production discovery rejects a redirect downgrade to HTTP", async () => {
  const discoveryConfig = {
    keycloak: { requestTimeoutMs: 1_000 },
    upstream: {
      discoveryUrl: "https://idp.example/.well-known/openid-configuration",
      clientSecret: "not-logged",
    },
  };
  const downgradedResponse = {
    url: "http://idp.example/.well-known/openid-configuration",
    ok: true,
    status: 200,
    text: async () => JSON.stringify(discovery),
  };

  await assert.rejects(
    fetchDiscovery(discoveryConfig, async () => downgradedResponse),
    /redirected to a non-HTTPS URL/,
  );
});

test("broker users receive tester and browser flow defaults to the upstream alias", () => {
  const mapper = hardcodedTesterMapperRepresentation(config);
  assert.equal(mapper.identityProviderMapper, "oidc-hardcoded-role-idp-mapper");
  assert.equal(mapper.config.role, "tester");

  const redirector = redirectorConfigRepresentation(config, {
    id: "existing-id",
    config: { keep: "value" },
  });
  assert.equal(redirector.id, "existing-id");
  assert.equal(redirector.config.keep, "value");
  assert.equal(redirector.config.defaultProvider, "company-oidc");
});
