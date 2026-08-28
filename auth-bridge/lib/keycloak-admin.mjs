import { maskKnownSecrets, redact } from "./redact.mjs";
import {
  apiClientRepresentation,
  audienceMapperRepresentations,
  cliClientRepresentation,
  clientScopeRepresentation,
  hardcodedTesterMapperRepresentation,
  identityProviderRepresentation,
  realmRepresentation,
  redirectorConfigRepresentation,
  testerRoleRepresentation,
  validateDiscovery,
} from "./representations.mjs";

function pathSegment(value) {
  return encodeURIComponent(value);
}

function safeDetail(data, secrets) {
  const text = typeof data === "string" ? data : JSON.stringify(redact(data));
  return maskKnownSecrets(text || "no response body", secrets);
}

export class KeycloakAdmin {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.log = options.log ?? console;
    this.accessToken = undefined;
    this.secrets = [config.keycloak.adminPassword, config.upstream.clientSecret];
  }

  async request(path, options = {}, canRetry = true) {
    const url = path.startsWith("http://") || path.startsWith("https://")
      ? path
      : `${this.config.keycloak.adminUrl}${path}`;
    const headers = new Headers(options.headers);
    if (this.accessToken && options.auth !== false) headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (options.body !== undefined && !(options.body instanceof URLSearchParams)) {
      headers.set("Content-Type", "application/json");
    }
    if (options.body instanceof URLSearchParams) {
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }

    let response;
    try {
      response = await this.fetch(url, {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined || options.body instanceof URLSearchParams
            ? options.body
            : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.config.keycloak.requestTimeoutMs),
      });
    } catch (error) {
      throw new Error(`${options.method ?? "GET"} ${url} failed: ${maskKnownSecrets(error.message, this.secrets)}`);
    }

    if (response.status === 401 && this.accessToken && options.auth !== false && canRetry) {
      await this.authenticate();
      return this.request(path, options, false);
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    const expected = options.expected ?? [200];
    if (!expected.includes(response.status)) {
      throw new Error(
        `${options.method ?? "GET"} ${url} failed (${response.status}): ${safeDetail(data, this.secrets)}`,
      );
    }
    return { data, status: response.status, headers: response.headers };
  }

  async authenticate() {
    this.accessToken = undefined;
    const tokenUrl = `/realms/${pathSegment(this.config.keycloak.adminRealm)}/protocol/openid-connect/token`;
    const { data } = await this.request(
      tokenUrl,
      {
        method: "POST",
        auth: false,
        expected: [200],
        body: new URLSearchParams({
          grant_type: "password",
          client_id: this.config.keycloak.adminClientId,
          username: this.config.keycloak.adminUsername,
          password: this.config.keycloak.adminPassword,
        }),
      },
      false,
    );
    if (typeof data?.access_token !== "string" || !data.access_token) {
      throw new Error("Keycloak admin token response did not contain access_token");
    }
    this.accessToken = data.access_token;
  }

  realmPath(suffix = "") {
    return `/admin/realms/${pathSegment(this.config.realm.name)}${suffix}`;
  }

  async getOrUndefined(path) {
    const response = await this.request(path, { expected: [200, 404] });
    return response.status === 404 ? undefined : response.data;
  }

  async ensureRealm() {
    const desired = realmRepresentation(this.config);
    const path = this.realmPath();
    const existing = await this.getOrUndefined(path);
    if (!existing) {
      await this.request("/admin/realms", { method: "POST", expected: [201], body: desired });
      this.log.log(`created realm: ${desired.realm}`);
      return;
    }
    await this.request(path, { method: "PUT", expected: [204], body: { ...existing, ...desired } });
    this.log.log(`updated realm: ${desired.realm}`);
  }

  async ensureRole() {
    const desired = testerRoleRepresentation();
    const path = this.realmPath(`/roles/${pathSegment(desired.name)}`);
    const existing = await this.getOrUndefined(path);
    if (!existing) {
      await this.request(this.realmPath("/roles"), {
        method: "POST",
        expected: [201],
        body: desired,
      });
      this.log.log(`created realm role: ${desired.name}`);
      return;
    }
    await this.request(path, {
      method: "PUT",
      expected: [204],
      body: { ...existing, ...desired },
    });
    this.log.log(`updated realm role: ${desired.name}`);
  }

  async findClient(clientId) {
    const query = new URLSearchParams({ clientId, search: "true" });
    const { data } = await this.request(this.realmPath(`/clients?${query}`));
    return data.find((client) => client.clientId === clientId);
  }

  async ensureClient(desired) {
    let existing = await this.findClient(desired.clientId);
    if (!existing) {
      await this.request(this.realmPath("/clients"), {
        method: "POST",
        expected: [201],
        body: desired,
      });
      existing = await this.findClient(desired.clientId);
      if (!existing) throw new Error(`Keycloak did not return newly created client: ${desired.clientId}`);
      this.log.log(`created client: ${desired.clientId}`);
      return existing;
    }
    await this.request(this.realmPath(`/clients/${pathSegment(existing.id)}`), {
      method: "PUT",
      expected: [204],
      body: {
        ...existing,
        ...desired,
        attributes: { ...(existing.attributes ?? {}), ...(desired.attributes ?? {}) },
      },
    });
    this.log.log(`updated client: ${desired.clientId}`);
    return existing;
  }

  async ensureClientScope(scope) {
    const desired = clientScopeRepresentation(scope);
    let { data: scopes } = await this.request(this.realmPath("/client-scopes"));
    let existing = scopes.find((candidate) => candidate.name === desired.name);
    if (!existing) {
      await this.request(this.realmPath("/client-scopes"), {
        method: "POST",
        expected: [201],
        body: desired,
      });
      ({ data: scopes } = await this.request(this.realmPath("/client-scopes")));
      existing = scopes.find((candidate) => candidate.name === desired.name);
      if (!existing) throw new Error(`Keycloak did not return newly created client scope: ${desired.name}`);
      this.log.log(`created client scope: ${desired.name}`);
      return existing;
    }
    await this.request(this.realmPath(`/client-scopes/${pathSegment(existing.id)}`), {
      method: "PUT",
      expected: [204],
      body: { ...existing, ...desired, attributes: { ...(existing.attributes ?? {}), ...desired.attributes } },
    });
    this.log.log(`updated client scope: ${desired.name}`);
    return existing;
  }

  async ensureDefaultClientScope(client, scope) {
    const { data: assigned } = await this.request(
      this.realmPath(`/clients/${pathSegment(client.id)}/default-client-scopes`),
    );
    if (!assigned.some((candidate) => candidate.id === scope.id)) {
      await this.request(
        this.realmPath(`/clients/${pathSegment(client.id)}/default-client-scopes/${pathSegment(scope.id)}`),
        { method: "PUT", expected: [204] },
      );
    }
    this.log.log(`configured default scope: ${scope.name}`);
  }

  async ensureOptionalClientScope(client, scopeName) {
    const { data: allScopes } = await this.request(this.realmPath("/client-scopes"));
    const scope = allScopes.find((candidate) => candidate.name === scopeName);
    if (!scope) throw new Error(`Required built-in client scope is missing: ${scopeName}`);
    const { data: assigned } = await this.request(
      this.realmPath(`/clients/${pathSegment(client.id)}/optional-client-scopes`),
    );
    if (!assigned.some((candidate) => candidate.id === scope.id)) {
      await this.request(
        this.realmPath(`/clients/${pathSegment(client.id)}/optional-client-scopes/${pathSegment(scope.id)}`),
        { method: "PUT", expected: [204] },
      );
    }
    this.log.log(`configured optional scope: ${scopeName}`);
  }

  async ensureProtocolMapper(client, desired) {
    const path = this.realmPath(`/clients/${pathSegment(client.id)}/protocol-mappers/models`);
    const { data: mappers } = await this.request(path);
    const existing = mappers.find((mapper) => mapper.name === desired.name);
    if (!existing) {
      await this.request(path, { method: "POST", expected: [201], body: desired });
    } else {
      await this.request(`${path}/${pathSegment(existing.id)}`, {
        method: "PUT",
        expected: [204],
        body: { ...existing, ...desired, config: { ...(existing.config ?? {}), ...desired.config } },
      });
    }
    this.log.log(`configured audience mapper: ${desired.name}`);
  }

  async ensureIdentityProvider(discovery) {
    const desired = identityProviderRepresentation(this.config, discovery);
    const instancePath = this.realmPath(`/identity-provider/instances/${pathSegment(desired.alias)}`);
    const existing = await this.getOrUndefined(instancePath);
    if (!existing) {
      await this.request(this.realmPath("/identity-provider/instances"), {
        method: "POST",
        expected: [201],
        body: desired,
      });
      this.log.log(`created identity provider: ${desired.alias}`);
      return;
    }
    await this.request(instancePath, {
      method: "PUT",
      expected: [204],
      body: { ...existing, ...desired, config: { ...(existing.config ?? {}), ...desired.config } },
    });
    this.log.log(`updated identity provider: ${desired.alias}`);
  }

  async ensureIdentityProviderMapper() {
    const desired = hardcodedTesterMapperRepresentation(this.config);
    const path = this.realmPath(
      `/identity-provider/instances/${pathSegment(this.config.upstream.alias)}/mappers`,
    );
    const { data: mappers } = await this.request(path);
    const existing = mappers.find((mapper) => mapper.name === desired.name);
    if (!existing) {
      await this.request(path, { method: "POST", expected: [201], body: desired });
    } else {
      await this.request(`${path}/${pathSegment(existing.id)}`, {
        method: "PUT",
        expected: [204],
        body: { ...existing, ...desired, config: { ...(existing.config ?? {}), ...desired.config } },
      });
    }
    this.log.log(`configured identity provider mapper: ${desired.name}`);
  }

  async ensureIdentityProviderRedirector() {
    const realm = await this.getOrUndefined(this.realmPath());
    const flowAlias = realm?.browserFlow ?? "browser";
    const flowPath = this.realmPath(`/authentication/flows/${pathSegment(flowAlias)}/executions`);
    let { data: executions } = await this.request(flowPath);
    let execution = executions.find((item) => item.providerId === "identity-provider-redirector");
    if (!execution) {
      await this.request(`${flowPath}/execution`, {
        method: "POST",
        expected: [201, 204],
        body: { provider: "identity-provider-redirector" },
      });
      ({ data: executions } = await this.request(flowPath));
      execution = executions.find((item) => item.providerId === "identity-provider-redirector");
    }
    if (!execution) throw new Error(`Browser flow ${flowAlias} has no identity-provider-redirector execution`);

    if (execution.requirement !== "ALTERNATIVE") {
      await this.request(this.realmPath(`/authentication/executions/${pathSegment(execution.id)}`), {
        method: "PUT",
        expected: [204],
        body: { ...execution, requirement: "ALTERNATIVE" },
      });
    }

    if (execution.authenticationConfig) {
      const configPath = this.realmPath(
        `/authentication/config/${pathSegment(execution.authenticationConfig)}`,
      );
      const { data: existingConfig } = await this.request(configPath);
      await this.request(configPath, {
        method: "PUT",
        expected: [204],
        body: redirectorConfigRepresentation(this.config, existingConfig),
      });
    } else {
      await this.request(
        this.realmPath(`/authentication/executions/${pathSegment(execution.id)}/config`),
        {
          method: "POST",
          expected: [201],
          body: redirectorConfigRepresentation(this.config),
        },
      );
    }
    this.log.log(`configured browser redirector: ${this.config.upstream.alias}`);
  }
}

export async function fetchDiscovery(config, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(config.upstream.discoveryUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(config.keycloak.requestTimeoutMs),
    });
  } catch (error) {
    throw new Error(`OIDC discovery request failed: ${maskKnownSecrets(error.message, [config.upstream.clientSecret])}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OIDC discovery request failed (${response.status}): ${maskKnownSecrets(text, [config.upstream.clientSecret])}`);
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("OIDC discovery endpoint did not return valid JSON");
  }
  return validateDiscovery(document);
}

export async function provision(config, options = {}) {
  const discovery = await fetchDiscovery(config, options.fetch ?? globalThis.fetch);
  const admin = new KeycloakAdmin(config, options);
  await admin.authenticate();
  await admin.ensureRealm();
  await admin.ensureRole();

  const apiClient = await admin.ensureClient(apiClientRepresentation(config));
  const cliClient = await admin.ensureClient(cliClientRepresentation(config));
  for (const scopeConfig of config.scopes) {
    const scope = await admin.ensureClientScope(scopeConfig);
    await admin.ensureDefaultClientScope(cliClient, scope);
  }
  await admin.ensureOptionalClientScope(cliClient, "offline_access");
  for (const mapper of audienceMapperRepresentations(config)) {
    await admin.ensureProtocolMapper(cliClient, mapper);
  }

  await admin.ensureIdentityProvider(discovery);
  await admin.ensureIdentityProviderMapper();
  await admin.ensureIdentityProviderRedirector();

  return {
    realm: config.realm.name,
    cliClient: cliClient.clientId,
    apiClient: apiClient.clientId,
    identityProvider: config.upstream.alias,
    callbackUrl: config.callbackUrl,
  };
}
