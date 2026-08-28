const keycloakUrl = (process.env.KEYCLOAK_URL ?? "http://localhost:8080").replace(
  /\/$/,
  "",
);
const realm = process.env.KEYCLOAK_REALM ?? "oidc-test";
const adminUsername = process.env.KEYCLOAK_ADMIN ?? "admin";
const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD ?? "admin-local-only";
const appOrigin = (process.env.APP_ORIGIN ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const clientId = process.env.OIDC_CLIENT_ID ?? "oidc-mvp-web";
const testUsername = process.env.MVP_TEST_USERNAME ?? "mvp-user";
const testPassword = process.env.MVP_TEST_PASSWORD ?? "mvp-password-local-only";

async function request(url, options = {}, acceptedStatuses = []) {
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

  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    const detail = data?.error_description ?? data?.errorMessage ?? data?.error ?? text;
    throw new Error(`${options.method ?? "GET"} ${url} failed (${response.status}): ${detail}`);
  }

  return { response, data };
}

const tokenBody = new URLSearchParams({
  grant_type: "password",
  client_id: "admin-cli",
  username: adminUsername,
  password: adminPassword,
});
const { data: adminTokenSet } = await request(
  `${keycloakUrl}/realms/master/protocol/openid-connect/token`,
  {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  },
);
const adminHeaders = {
  Authorization: `Bearer ${adminTokenSet.access_token}`,
  "Content-Type": "application/json",
};
const adminBase = `${keycloakUrl}/admin/realms/${encodeURIComponent(realm)}`;

const clientRepresentation = {
  clientId,
  name: "Web Login MVP",
  description: "Authorization Code + PKCE client for the standalone login MVP",
  enabled: true,
  protocol: "openid-connect",
  publicClient: true,
  standardFlowEnabled: true,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  frontchannelLogout: true,
  rootUrl: appOrigin,
  baseUrl: "/",
  redirectUris: [`${appOrigin}/callback`],
  webOrigins: [appOrigin],
  attributes: {
    "pkce.code.challenge.method": "S256",
    "post.logout.redirect.uris": `${appOrigin}/*`,
  },
};

const clientQuery = new URLSearchParams({ clientId });
let { data: clients } = await request(`${adminBase}/clients?${clientQuery}`, {
  headers: adminHeaders,
});

if (clients.length === 0) {
  await request(`${adminBase}/clients`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify(clientRepresentation),
  });
  ({ data: clients } = await request(`${adminBase}/clients?${clientQuery}`, {
    headers: adminHeaders,
  }));
  console.log(`Created OIDC client: ${clientId}`);
} else {
  const existing = clients[0];
  await request(`${adminBase}/clients/${existing.id}`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      ...existing,
      ...clientRepresentation,
      attributes: {
        ...(existing.attributes ?? {}),
        ...clientRepresentation.attributes,
      },
    }),
  });
  console.log(`Updated OIDC client: ${clientId}`);
}

const userQuery = new URLSearchParams({
  username: testUsername,
  exact: "true",
});
let { data: users } = await request(`${adminBase}/users?${userQuery}`, {
  headers: adminHeaders,
});

const userRepresentation = {
  username: testUsername,
  enabled: true,
  emailVerified: true,
  firstName: "MVP",
  lastName: "Tester",
  email: "mvp-user@example.local",
};

if (users.length === 0) {
  await request(`${adminBase}/users`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify(userRepresentation),
  });
  ({ data: users } = await request(`${adminBase}/users?${userQuery}`, {
    headers: adminHeaders,
  }));
  console.log(`Created test user: ${testUsername}`);
} else {
  await request(`${adminBase}/users/${users[0].id}`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ ...users[0], ...userRepresentation }),
  });
  console.log(`Updated test user: ${testUsername}`);
}

const userId = users[0].id;
await request(`${adminBase}/users/${userId}/reset-password`, {
  method: "PUT",
  headers: adminHeaders,
  body: JSON.stringify({
    type: "password",
    value: testPassword,
    temporary: false,
  }),
});

const { data: testerRole } = await request(`${adminBase}/roles/tester`, {
  headers: adminHeaders,
});
await request(`${adminBase}/users/${userId}/role-mappings/realm`, {
  method: "POST",
  headers: adminHeaders,
  body: JSON.stringify([testerRole]),
});

console.log(`Reset password and assigned role: tester`);
console.log(`Ready: ${appOrigin} (${testUsername} / ${testPassword})`);
