# Local OpenID Connect test server

Keycloak과 PostgreSQL로 구성한 로컬 OIDC/OAuth 2.0 테스트 서버입니다. realm, client, 사용자는 첫 실행 시 자동으로 생성됩니다.

> 이 구성의 계정과 secret은 공개된 테스트 값입니다. 개발 PC의 로컬 테스트에만 사용하고 운영 환경에는 사용하지 마세요.

## 실행

필요한 것은 Docker와 Docker Compose입니다.

```bash
docker compose up -d --wait
./scripts/smoke-test.sh
```

또는 다음 단축 명령을 사용할 수 있습니다.

```bash
make up
make test
make logs
make down
```

## 접속 정보

| 항목 | 값 |
|---|---|
| Admin Console | <http://localhost:8080/admin/> |
| Admin 계정 | `admin` / `admin-local-only` |
| Realm | `oidc-test` |
| Issuer | `http://localhost:8080/realms/oidc-test` |
| Discovery | <http://localhost:8080/realms/oidc-test/.well-known/openid-configuration> |
| 테스트 사용자 | `test-user` / `test-password-local-only` |

### 브라우저/SPA용 public client

- Client ID: `oidc-test-app`
- Flow: Authorization Code + PKCE (`S256` 필수)
- Client secret: 없음
- Redirect URI: `localhost` 또는 `127.0.0.1`의 포트 `3000`, `8081`
- Scope 예시: `openid profile email`

애플리케이션에는 보통 아래 값만 설정하면 됩니다.

```text
OIDC_ISSUER=http://localhost:8080/realms/oidc-test
OIDC_CLIENT_ID=oidc-test-app
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URI=http://localhost:3000/callback
```

## 실행 가능한 MVP

- [`web-login-mvp`](./web-login-mvp): 브라우저 Authorization Code + PKCE 로그인
- [`cli-device-auth-mvp`](./cli-device-auth-mvp): `gh auth login` 형태의 CLI Device Flow와 보호 API/MCP 호출
- [`auth-bridge`](./auth-bridge): 웹 OIDC만 지원하는 사내 IdP를 Keycloak Device Flow에 연결하는 독립 프로젝트

CLI MVP는 최종 사용자에게 API key나 환경변수를 요구하지 않습니다. CLI가 일회용 코드를 표시하고 브라우저에서 로그인·승인한 뒤 access/refresh token을 자체 관리합니다.

### 서버 간 통신용 confidential client

- Client ID: `oidc-test-service`
- Client secret: `test-service-secret-local-only`
- Flow: Client Credentials

```bash
curl --fail-with-body \
  --user 'oidc-test-service:test-service-secret-local-only' \
  --data-urlencode 'grant_type=client_credentials' \
  http://localhost:8080/realms/oidc-test/protocol/openid-connect/token
```

## 종료 및 초기화

일반 종료는 DB 데이터를 보존합니다.

```bash
docker compose down
```

realm JSON을 수정한 뒤 다시 import하려면 이 프로젝트의 PostgreSQL 볼륨을 삭제해야 합니다. 아래 명령은 저장된 로컬 테스트 데이터를 모두 지웁니다.

```bash
make reset
```

포트나 관리자/DB 비밀번호는 `.env.example`을 `.env`로 복사한 뒤 변경할 수 있습니다. `KEYCLOAK_URL`을 변경했다면 public client의 redirect URI도 Admin Console에서 맞춰 주세요.
