function absoluteHttpUrl(value, label, options = {}) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    if (!options.allowInsecure && url.protocol !== "https:") {
      throw new Error(`OIDC discovery field ${label} must use HTTPS`);
    }
    return url.toString();
  } catch (error) {
    if (error?.message?.includes("must use HTTPS")) throw error;
    throw new Error(`OIDC discovery field ${label} must be an absolute HTTP(S) URL`);
  }
}

export function validateDiscovery(document, options = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("OIDC discovery response must be a JSON object");
  }
  for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    absoluteHttpUrl(document[field], field, options);
  }
  for (const field of ["userinfo_endpoint", "end_session_endpoint"]) {
    if (document[field] !== undefined) absoluteHttpUrl(document[field], field, options);
  }
  if (document.response_types_supported && !document.response_types_supported.includes("code")) {
    throw new Error("Upstream OIDC provider does not advertise response_type=code");
  }
  return document;
}

export function realmRepresentation(config) {
  return {
    realm: config.realm.name,
    displayName: config.realm.displayName,
    enabled: true,
    sslRequired: config.realm.sslRequired,
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: true,
    verifyEmail: false,
    accessTokenLifespan: config.realm.accessTokenLifespan,
    ssoSessionIdleTimeout: config.realm.ssoSessionIdleTimeout,
    ssoSessionMaxLifespan: config.realm.ssoSessionMaxLifespan,
  };
}

export function testerRoleRepresentation() {
  return {
    name: "tester",
    description: "Allows brokered test users to call AuthBridge-protected resources",
  };
}

export function cliClientRepresentation(config) {
  return {
    clientId: config.clients.cli,
    name: "AuthBridge Skills CLI",
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
  };
}

export function apiClientRepresentation(config) {
  return {
    clientId: config.clients.api,
    name: "AuthBridge Skills API",
    description: "Bearer-only resource server for Skills API access tokens",
    enabled: true,
    protocol: "openid-connect",
    bearerOnly: true,
    publicClient: false,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
  };
}

export function clientScopeRepresentation(scope) {
  return {
    name: scope.name,
    description: scope.description,
    protocol: "openid-connect",
    attributes: {
      "display.on.consent.screen": "true",
      "consent.screen.text": scope.description,
      "include.in.token.scope": "true",
    },
  };
}

export function audienceMapperRepresentations(config) {
  return [
    {
      name: `${config.clients.api}-audience`,
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      consentRequired: false,
      config: {
        "included.client.audience": config.clients.api,
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
        "included.custom.audience": config.resources.mcpAudience,
        "access.token.claim": "true",
        "id.token.claim": "false",
        "introspection.token.claim": "true",
        "lightweight.claim": "false",
      },
    },
  ];
}

export function identityProviderRepresentation(config, discoveryDocument) {
  const discovery = validateDiscovery(discoveryDocument, {
    allowInsecure: config.upstream.allowInsecureEndpointOverrides === true,
  });
  if (
    Array.isArray(discovery.response_modes_supported) &&
    !discovery.response_modes_supported.includes(config.upstream.responseMode)
  ) {
    throw new Error(`Upstream OIDC provider does not advertise response_mode=${config.upstream.responseMode}`);
  }
  // Keycloak 26's generic OIDC broker does not act on a standalone
  // config.responseMode value. Put the requested mode on the authorization
  // endpoint itself so the upstream server returns a deterministic response.
  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.searchParams.set("response_mode", config.upstream.responseMode);
  const endpointOverrides = config.upstream.endpointOverrides ?? {};
  const userInfoUrl = endpointOverrides.userInfoUrl ?? discovery.userinfo_endpoint;
  return {
    alias: config.upstream.alias,
    displayName: config.upstream.displayName,
    providerId: "oidc",
    enabled: true,
    updateProfileFirstLoginMode: "off",
    trustEmail: config.upstream.trustEmail,
    storeToken: false,
    addReadTokenRoleOnCreate: false,
    authenticateByDefault: false,
    linkOnly: false,
    firstBrokerLoginFlowAlias: "first broker login",
    config: {
      syncMode: config.upstream.syncMode,
      clientId: config.upstream.clientId,
      clientSecret: config.upstream.clientSecret,
      clientAuthMethod: config.upstream.clientAuthMethod,
      defaultScope: config.upstream.defaultScope,
      issuer: discovery.issuer,
      authorizationUrl: authorizationUrl.toString(),
      tokenUrl: endpointOverrides.tokenUrl ?? discovery.token_endpoint,
      jwksUrl: endpointOverrides.jwksUrl ?? discovery.jwks_uri,
      useJwksUrl: "true",
      validateSignature: "true",
      disableUserInfo: String(!userInfoUrl),
      ...(userInfoUrl ? { userInfoUrl } : {}),
      ...(discovery.end_session_endpoint ? { logoutUrl: discovery.end_session_endpoint } : {}),
    },
  };
}

export function hardcodedTesterMapperRepresentation(config) {
  return {
    name: "grant-tester-role",
    identityProviderAlias: config.upstream.alias,
    identityProviderMapper: "oidc-hardcoded-role-idp-mapper",
    config: {
      role: "tester",
      syncMode: "INHERIT",
    },
  };
}

export function redirectorConfigRepresentation(config, existing = {}) {
  return {
    ...existing,
    alias: "authbridge-default-identity-provider",
    config: {
      ...(existing.config ?? {}),
      defaultProvider: config.upstream.alias,
    },
  };
}
