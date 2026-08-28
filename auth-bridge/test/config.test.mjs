import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { brokerCallbackUrl, loadConfig, validateProfile } from "../lib/config.mjs";
import { parseDotEnv } from "../lib/env.mjs";

const profilePath = resolve(dirname(fileURLToPath(import.meta.url)), "../config/authbridge.json");

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
