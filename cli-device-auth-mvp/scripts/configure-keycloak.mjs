const keycloakUrl = (process.env.KEYCLOAK_URL ?? "http://localhost:8080").replace(
  /\/$/,
  "",
);
const realm = process.env.KEYCLOAK_REALM ?? "oidc-test";
const adminUsername = process.env.KEYCLOAK_ADMIN ?? "admin";
const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD ?? "admin-local-only";
const cliClientId = process.env.SKILLS_OIDC_CLIENT_ID ?? "skills-cli";
const apiClientId = process.env.SKILLS_OIDC_AUDIENCE ?? "skills-api";
const mcpResource = process.env.SKILLS_MCP_AUDIENCE ?? "http://localhost:3200/mcp";
const testUsername = process.env.CLI_TEST_USERNAME ?? "cli-user";
const testPassword = process.env.CLI_TEST_PASSWORD ?? "cli-password-local-only";

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail = data?.error_description ?? data?.errorMessage ?? data?.error ?? text;
    throw new Error(`${options.method ?? "GET"} ${url} failed (${response.status}): ${detail}`);
  }
  return data;
}

const tokenSet = await request(
  `${keycloakUrl}/realms/master/protocol/openid-connect/token`,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: adminUsername,
      password: adminPassword,
    }),
  },
);
const headers = {
  Authorization: `Bearer ${tokenSet.access_token}`,
  "Content-Type": "application/json",
};
const base = `${keycloakUrl}/admin/realms/${encodeURIComponent(realm)}`;

async function upsertClient(representation) {
  let clients = await request(
    `${base}/clients?${new URLSearchParams({ clientId: representation.clientId })}`,
    { headers },
  );
  if (clients.length === 0) {
    await request(`${base}/clients`, {
      method: "POST",
      headers,
      body: JSON.stringify(representation),
    });
    clients = await request(
      `${base}/clients?${new URLSearchParams({ clientId: representation.clientId })}`,
      { headers },
    );
    console.log(`Created client: ${representation.clientId}`);
  } else {
    const existing = clients[0];
    await request(`${base}/clients/${existing.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ...existing,
        ...representation,
        attributes: { ...(existing.attributes ?? {}), ...(representation.attributes ?? {}) },
      }),
    });
    console.log(`Updated client: ${representation.clientId}`);
  }
  return clients[0];
}

const apiClient = await upsertClient({
  clientId: apiClientId,
  name: "Skills API Resource Server",
  description: "Audience representing protected Skills API and MCP resources",
  enabled: true,
  protocol: "openid-connect",
  bearerOnly: true,
  publicClient: false,
  standardFlowEnabled: false,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
});

const cliClient = await upsertClient({
  clientId: cliClientId,
  name: "Skills CLI",
  description: "Public CLI client using OAuth 2.0 Device Authorization Grant",
  enabled: true,
  protocol: "openid-connect",
  publicClient: true,
  bearerOnly: false,
  standardFlowEnabled: false,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  consentRequired: false,
  attributes: {
    "oauth2.device.authorization.grant.enabled": "true",
    "use.refresh.tokens": "true",
  },
});

const audienceMappers = [
  {
    name: `${apiClientId}-audience`,
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    consentRequired: false,
    config: {
      "included.client.audience": apiClientId,
      "access.token.claim": "true",
      "id.token.claim": "false",
      "introspection.token.claim": "true",
      "lightweight.claim": "false",
    },
  },
  {
    name: "mcp-resource-audience",
    protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper",
    consentRequired: false,
    config: {
      "included.custom.audience": mcpResource,
      "access.token.claim": "true",
      "id.token.claim": "false",
      "introspection.token.claim": "true",
      "lightweight.claim": "false",
    },
  },
];
const mappers = await request(`${base}/clients/${cliClient.id}/protocol-mappers/models`, {
  headers,
});
for (const audienceMapper of audienceMappers) {
  const existingMapper = mappers.find((mapper) => mapper.name === audienceMapper.name);
  if (existingMapper) {
    await request(
      `${base}/clients/${cliClient.id}/protocol-mappers/models/${existingMapper.id}`,
      { method: "PUT", headers, body: JSON.stringify({ ...existingMapper, ...audienceMapper }) },
    );
  } else {
    await request(`${base}/clients/${cliClient.id}/protocol-mappers/models`, {
      method: "POST",
      headers,
      body: JSON.stringify(audienceMapper),
    });
  }
  console.log(`Configured audience mapper: ${audienceMapper.name}`);
}

const allScopes = await request(`${base}/client-scopes`, { headers });
for (const scope of [
  ["skills.read", "Read the protected Skills API"],
  ["mcp.tools", "Call protected MCP tools"],
]) {
  const [name, consentText] = scope;
  const representation = {
    name,
    description: consentText,
    protocol: "openid-connect",
    attributes: {
      "display.on.consent.screen": "true",
      "consent.screen.text": consentText,
      "include.in.token.scope": "true",
    },
  };
  let current = allScopes.find((candidate) => candidate.name === name);
  if (!current) {
    await request(`${base}/client-scopes`, {
      method: "POST",
      headers,
      body: JSON.stringify(representation),
    });
    const refreshedScopes = await request(`${base}/client-scopes`, { headers });
    current = refreshedScopes.find((candidate) => candidate.name === name);
  } else {
    await request(`${base}/client-scopes/${current.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...current, ...representation }),
    });
  }
  await request(`${base}/clients/${cliClient.id}/optional-client-scopes/${current.id}`, {
    method: "PUT",
    headers,
  });
  console.log(`Configured optional scope: ${name}`);
}

const offlineAccessScope = (await request(`${base}/client-scopes`, { headers })).find(
  (candidate) => candidate.name === "offline_access",
);
if (offlineAccessScope) {
  await request(
    `${base}/clients/${cliClient.id}/optional-client-scopes/${offlineAccessScope.id}`,
    { method: "PUT", headers },
  );
  console.log("Configured optional scope: offline_access");
}

const userQuery = new URLSearchParams({ username: testUsername, exact: "true" });
let users = await request(`${base}/users?${userQuery}`, { headers });
const userRepresentation = {
  username: testUsername,
  enabled: true,
  emailVerified: true,
  firstName: "CLI",
  lastName: "Tester",
  email: "cli-user@example.local",
};
if (users.length === 0) {
  await request(`${base}/users`, {
    method: "POST",
    headers,
    body: JSON.stringify(userRepresentation),
  });
  users = await request(`${base}/users?${userQuery}`, { headers });
  console.log(`Created test user: ${testUsername}`);
} else {
  await request(`${base}/users/${users[0].id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...users[0], ...userRepresentation }),
  });
  console.log(`Updated test user: ${testUsername}`);
}

await request(`${base}/users/${users[0].id}/reset-password`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ type: "password", value: testPassword, temporary: false }),
});
const testerRole = await request(`${base}/roles/tester`, { headers });
await request(`${base}/users/${users[0].id}/role-mappings/realm`, {
  method: "POST",
  headers,
  body: JSON.stringify([testerRole]),
});

console.log(`Ready: ${testUsername} / ${testPassword}`);
