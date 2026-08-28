import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { brokerCallbackUrl, loadConfig, validateProfile } from "../lib/config.mjs";
import { parseDotEnv } from "../lib/env.mjs";

const profilePath = resolve(dirname(fileURLToPath(import.meta.url)), "../config/authbridge.json");
const mockProfilePath = resolve(dirname(fileURLToPath(import.meta.url)), "../config/mock-query.json");

test("parseDotEnv supports comments, export, and quoted values", () => {
  assert.deepEqual(
    parseDotEnv(`
      # comment
      export CLIENT_ID = example-client
      CLIENT_SECRET='a # literal'
      ESCAPED="line\\nvalue"
      PLAIN=value # trailing comment
    `),
    {
      CLIENT_ID: "example-client",
      CLIENT_SECRET: "a # literal",
      ESCAPED: "line\nvalue",
      PLAIN: "value",
    },
  );
});

test("loadConfig needs only upstream client values with local Keycloak defaults", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "authbridge-config-"));
  try {
    const config = await loadConfig({
      cwd,
      profilePath,
      env: {
        UPSTREAM_OIDC_CLIENT_ID: "issued-client",
        UPSTREAM_OIDC_CLIENT_SECRET: "issued-secret",
      },
    });
    assert.equal(config.keycloak.adminUsername, "admin");
    assert.equal(config.keycloak.adminPassword, "admin-local-only");
    assert.equal(config.realm.name, "authbridge");
    assert.equal(config.upstream.responseMode, "form_post");
    assert.equal(
      config.callbackUrl,
      "https://smart-dna.sec.samsung.net/ws2/30001/realms/authbridge/broker/company-oidc/endpoint",
    );
    assert.equal(config.callbackUrl, brokerCallbackUrl(config));
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.upstream));
  } finally {
    await rm(cwd, { recursive: true });
  }
});

test("one public URL override moves callback and the default MCP audience together", async () => {
  const config = await loadConfig({
    profilePath,
    env: {
      UPSTREAM_OIDC_CLIENT_ID: "issued-client",
      UPSTREAM_OIDC_CLIENT_SECRET: "issued-secret",
      AUTHBRIDGE_PUBLIC_URL: "https://auth.example/new-prefix/",
      AUTHBRIDGE_KEYCLOAK_ADMIN_URL: "http://127.0.0.1:8280/",
    },
  });

  assert.equal(config.keycloak.publicUrl, "https://auth.example/new-prefix");
  assert.equal(config.keycloak.adminUrl, "http://127.0.0.1:8280");
  assert.equal(
    config.callbackUrl,
    "https://auth.example/new-prefix/realms/authbridge/broker/company-oidc/endpoint",
  );
  assert.equal(config.resources.mcpAudience, "https://auth.example/new-prefix/mcp");
});

test("an explicit MCP audience wins when the protected resource uses another origin", async () => {
  const config = await loadConfig({
    profilePath,
    env: {
      UPSTREAM_OIDC_CLIENT_ID: "issued-client",
      UPSTREAM_OIDC_CLIENT_SECRET: "issued-secret",
      AUTHBRIDGE_PUBLIC_URL: "https://auth.example/new-prefix",
      AUTHBRIDGE_MCP_AUDIENCE: "https://mcp.example/tools",
    },
  });

  assert.equal(config.resources.mcpAudience, "https://mcp.example/tools");
});

test(".env supplies values but explicit environment wins", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "authbridge-env-"));
  try {
    await writeFile(
      join(cwd, ".env"),
      "UPSTREAM_OIDC_CLIENT_ID=file-id\nUPSTREAM_OIDC_CLIENT_SECRET=file-secret\n",
    );
    const config = await loadConfig({
      cwd,
      profilePath,
      env: { UPSTREAM_OIDC_CLIENT_ID: "environment-id" },
    });
    assert.equal(config.upstream.clientId, "environment-id");
    assert.equal(config.upstream.clientSecret, "file-secret");
  } finally {
    await rm(cwd, { recursive: true });
  }
});

test("loadConfig fails before network access when the upstream secret is missing", async () => {
  await assert.rejects(
    loadConfig({
      profilePath,
      env: { UPSTREAM_OIDC_CLIENT_ID: "issued-client" },
    }),
    /UPSTREAM_OIDC_CLIENT_SECRET is required/,
  );
});

test("mock query profile separates host discovery/front-channel from container back-channel", async () => {
  const config = await loadConfig({
    profilePath: mockProfilePath,
    env: {
      UPSTREAM_OIDC_CLIENT_ID: "authbridge-broker",
      UPSTREAM_OIDC_CLIENT_SECRET: "mock-secret",
    },
  });

  assert.equal(config.keycloak.publicUrl, "http://localhost:8080");
  assert.equal(
    config.callbackUrl,
    "http://localhost:8080/realms/authbridge/broker/company-oidc/endpoint",
  );
  assert.equal(
    config.upstream.discoveryUrl,
    "http://localhost:8090/realms/corporate-test/.well-known/openid-configuration",
  );
  assert.equal(config.upstream.responseMode, "query");
  assert.equal(
    config.upstream.endpointOverrides.tokenUrl,
    "http://corporate-oidc:8080/realms/corporate-test/protocol/openid-connect/token",
  );
});

test("back-channel HTTP overrides require an explicit mock-only opt-in", async () => {
  const profile = JSON.parse(await readFile(mockProfilePath, "utf8"));
  profile.upstream.allowInsecureEndpointOverrides = false;
  assert.throws(
    () => validateProfile(profile),
    /upstream\.endpointOverrides\.tokenUrl must use HTTPS/,
  );

  profile.upstream.allowInsecureEndpointOverrides = true;
  profile.upstream.endpointOverrides.authorizationUrl = "http://corporate-oidc:8080/auth";
  assert.throws(
    () => validateProfile(profile),
    /upstream\.endpointOverrides\.authorizationUrl is not supported/,
  );
});

test("validateProfile reports multiple invalid fields together", () => {
  assert.throws(
    () =>
      validateProfile({
        keycloak: { adminUrl: "relative", publicUrl: "http://public.example", requestTimeoutMs: 2 },
        realm: {},
        clients: { cli: "same", api: "same" },
        resources: { mcpAudience: "nope" },
        scopes: [],
        upstream: {},
      }),
    (error) => {
      assert.match(error.message, /keycloak\.adminUrl/);
      assert.match(error.message, /keycloak\.publicUrl must use HTTPS/);
      assert.match(error.message, /clients\.cli and clients\.api must differ/);
      assert.match(error.message, /scopes must be a non-empty array/);
      return true;
    },
  );
});
