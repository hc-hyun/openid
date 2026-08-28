import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";

import { createGateway, loadGatewayConfig, parseOidcForm } from "../server.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, { method = "GET", path = "/", headers = {}, body = "" } = {}) {
  const payload = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        ...headers,
        ...(headers["content-length"] === undefined && body !== "" ? { "content-length": payload.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
}

describe("gateway configuration and parser", () => {
  test("uses the temporary prefix and local backend defaults", () => {
    const config = loadGatewayConfig({});
    assert.equal(config.publicPrefix, "/ws2/30001");
    assert.equal(config.backendUrl.href, "http://localhost:8080/");
    assert.equal(config.formPostLimit, 8192);
  });

  test("accepts an OIDC error response and rejects duplicate fields", () => {
    assert.deepEqual(
      Object.fromEntries(parseOidcForm(Buffer.from("error=access_denied&state=s1&error_description=no"))),
      { error: "access_denied", state: "s1", error_description: "no" },
    );
    assert.throws(
      () => parseOidcForm(Buffer.from("code=a&state=s1&state=s2")),
      /Duplicate form parameter/,
    );
    assert.deepEqual(
      Object.fromEntries(
        parseOidcForm(Buffer.from("code=a&state=s1&iss=https%3A%2F%2Fissuer.test&session_state=session-1")),
      ),
      {
        code: "a",
        state: "s1",
        iss: "https://issuer.test",
        session_state: "session-1",
      },
    );
  });
});

describe("AuthBridge gateway", () => {
  let backend;
  let gateway;
  let gatewayPort;
  let observations;
  let logs;

  before(async () => {
    observations = [];
    backend = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      observations.push({ method: request.method, url: request.url, headers: request.headers, body });

      if (request.url.startsWith("/realms/authbridge/broker/company-oidc/endpoint?")) {
        response.writeHead(303, {
          location: "https://smart-dna.sec.samsung.net/ws2/30001/complete",
          "set-cookie": [
            "AUTH_SESSION_ID=one; Path=/ws2/30001/; HttpOnly; Secure",
            "KC_RESTART=two; Path=/ws2/30001/; HttpOnly; Secure",
          ],
          "content-type": "text/plain",
        });
        response.end("broker complete");
        return;
      }

      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ method: request.method, url: request.url, body }));
    });
    const backendPort = await listen(backend);
    logs = [];
    gateway = createGateway({
      publicUrl: "https://smart-dna.sec.samsung.net/ws2/30001",
      backendUrl: `http://127.0.0.1:${backendPort}`,
      logger: {
        info: (...values) => logs.push(values.join(" ")),
        error: (...values) => logs.push(values.join(" ")),
      },
    });
    gatewayPort = await listen(gateway);
  });

  after(async () => {
    await close(gateway);
    await close(backend);
  });

  test("strips the public prefix, proxies ordinary methods/body, and overwrites forwarded headers", async () => {
    const result = await request(gatewayPort, {
      method: "PUT",
      path: "/ws2/30001/realms/authbridge/resource?keep=yes",
      headers: {
        "content-type": "text/plain",
        "x-forwarded-proto": "http",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-prefix": "/wrong",
        "x-forwarded-for": "203.0.113.9",
      },
      body: "ordinary payload",
    });

    assert.equal(result.statusCode, 201);
    const seen = observations.at(-1);
    assert.equal(seen.method, "PUT");
    assert.equal(seen.url, "/realms/authbridge/resource?keep=yes");
    assert.equal(seen.body, "ordinary payload");
    assert.equal(seen.headers["x-forwarded-proto"], "https");
    assert.equal(seen.headers["x-forwarded-host"], "smart-dna.sec.samsung.net");
    assert.equal(seen.headers["x-forwarded-port"], "443");
    assert.equal(seen.headers["x-forwarded-prefix"], "/ws2/30001");
    assert.notEqual(seen.headers["x-forwarded-for"], "203.0.113.9");
  });

  test("translates a validated form_post internally and forwards status, location, cookies, and body", async () => {
    const secretCode = "code-that-must-not-be-logged";
    const secretState = "state-that-must-not-be-logged";
    const result = await request(gatewayPort, {
      method: "POST",
      path: "/ws2/30001/realms/authbridge/broker/company-oidc/endpoint",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: `code=${secretCode}&state=${secretState}`,
    });

    assert.equal(result.statusCode, 303);
    assert.equal(result.headers.location, "https://smart-dna.sec.samsung.net/ws2/30001/complete");
    assert.deepEqual(result.headers["set-cookie"], [
      "AUTH_SESSION_ID=one; Path=/ws2/30001/; HttpOnly; Secure",
      "KC_RESTART=two; Path=/ws2/30001/; HttpOnly; Secure",
    ]);
    assert.equal(result.body, "broker complete");
    const seen = observations.at(-1);
    assert.equal(seen.method, "GET");
    const callback = new URL(seen.url, "http://backend.invalid");
    assert.equal(callback.pathname, "/realms/authbridge/broker/company-oidc/endpoint");
    assert.equal(callback.searchParams.get("code"), secretCode);
    assert.equal(callback.searchParams.get("state"), secretState);
    assert.equal(seen.body, "");
    assert.equal(logs.join("\n").includes(secretCode), false);
    assert.equal(logs.join("\n").includes(secretState), false);
  });

  test("rejects invalid adapter requests before contacting the backend", async () => {
    const cases = [
      { body: "code=a&state=s", contentType: "application/json", status: 415 },
      { body: "code=a", status: 400 },
      { body: "state=s", status: 400 },
      { body: "code=a&error=denied&state=s", status: 400 },
      { body: "code=&error=denied&state=s", status: 400 },
      { body: "code=&state=s", status: 400 },
      { body: "code=a&state=s&unknown=x", status: 400 },
      { body: "code=a&state=s&state=again", status: 400 },
      { body: "code=a&state=%ZZ", status: 400 },
      { body: `code=${"a".repeat(8192)}&state=s`, status: 413 },
    ];
    const initialCount = observations.length;

    for (const item of cases) {
      const result = await request(gatewayPort, {
        method: "POST",
        path: "/ws2/30001/realms/authbridge/broker/company-oidc/endpoint",
        headers: { "content-type": item.contentType ?? "application/x-www-form-urlencoded" },
        body: item.body,
      });
      assert.equal(result.statusCode, item.status, item.body.slice(0, 50));
    }
    assert.equal(observations.length, initialCount);
  });

  test("exposes health outside the prefix and does not proxy unrelated paths", async () => {
    const health = await request(gatewayPort, { path: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok" });

    const missing = await request(gatewayPort, { path: "/not-keycloak" });
    assert.equal(missing.statusCode, 404);

    const initialCount = observations.length;
    for (const path of [
      "/ws2/30001/admin/",
      "/ws2/30001/realms/master/protocol/openid-connect/auth",
      "/ws2/30001/metrics",
    ]) {
      const blocked = await request(gatewayPort, { path });
      assert.equal(blocked.statusCode, 404, path);
    }
    assert.equal(observations.length, initialCount);
  });

  test("caps ordinary proxy request bodies", async () => {
    const limited = createGateway({
      publicUrl: "https://example.test/ws2/30001",
      backendUrl: `http://127.0.0.1:${backend.address().port}`,
      maxProxyBodyBytes: 5,
      logger: { error() {} },
    });
    const port = await listen(limited);
    try {
      const result = await request(port, {
        method: "POST",
        path: "/ws2/30001/realms/authbridge/test",
        body: "123456",
      });
      assert.equal(result.statusCode, 413);
    } finally {
      await close(limited);
    }
  });
});
