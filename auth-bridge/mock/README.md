# Mock corporate OIDC server

This folder contains a standalone Keycloak realm that behaves like the corporate
web-based OIDC provider used by AuthBridge. It exists only for local end-to-end
tests; every password and secret in this folder is intentionally non-production.

## Start it

From this folder:

```bash
node validate-realm.mjs
docker compose up -d --wait
```

전체 AuthBridge/CLI 흐름은 상위 폴더에서 한 번에 실행하는 편이 간단합니다.

```bash
cd ..
npm run test:e2e
```

The imported provider is then available at:

```text
Issuer:        http://localhost:8090/realms/corporate-test
Discovery:     http://localhost:8090/realms/corporate-test/.well-known/openid-configuration
Client ID:     authbridge-broker
Client secret: mock-corporate-secret
Username:      company-user
Password:      company-password-local-only
```

The Keycloak administration console is `http://localhost:8090/admin/`. Its local
defaults are `admin` / `admin-local-only`; override them with
`MOCK_CORPORATE_ADMIN` and `MOCK_CORPORATE_ADMIN_PASSWORD` if needed.

Stop the standalone provider with:

```bash
docker compose down
```

## Broker contract

The confidential `authbridge-broker` client enables only the Authorization Code
flow. Password, implicit, service-account, device, and CIBA grants are disabled.
It accepts the exact local Keycloak broker callback and its callback prefix:

```text
http://localhost:8080/realms/authbridge/broker/company-oidc/endpoint
http://localhost:8080/realms/authbridge/broker/company-oidc/*
http://localhost:8180/ws2/30001/realms/authbridge/broker/company-oidc/endpoint
http://localhost:8180/ws2/30001/realms/authbridge/broker/company-oidc/*
```

The prefix mirrors the current corporate redirect-prefix behavior. The exact
endpoint remains registered as documentation and for providers that require an
exact redirect match. Keycloak's OIDC authorization endpoint supports
`response_mode=form_post`; the client needs no mock-specific setting for it.

The client has explicit protocol mappers so its ID token contains
`preferred_username`, `email`, and `name`. The test account has a verified email
and resolves those claims to `company-user`, `company-user@corporate.example`,
and `Company User` respectively.

The mock Compose project creates the shared Docker network `authbridge-mock`.
The main Keycloak joins it through `main-keycloak.override.yaml`: browsers use
`http://localhost:8090`, while Keycloak uses `http://corporate-oidc:8080` only
for token, JWKS, and UserInfo back-channel calls. The token issuer remains the
browser-visible `http://localhost:8090/realms/corporate-test`.

Never copy the mock secret or password into a real environment.
