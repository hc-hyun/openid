# CLI Device Login MVP

API key를 발급해 환경변수에 복사하는 대신, `gh auth login`처럼 CLI가 일회용 코드를 표시하고 브라우저의 Keycloak 로그인으로 사용자 인증을 완료하는 MVP입니다.

## 사용자 경험

```bash
skillsctl login

! First copy your one-time code: ABCD-EFGH
Open this URL in your browser: http://localhost:8080/realms/oidc-test/device?user_code=ABCD-EFGH
```

브라우저에서 회사 계정으로 승인하면 CLI가 access/refresh token을 받고 이후 API와 MCP 요청에 Bearer access token을 자동으로 첨부합니다. 최종 사용자에게 API key나 환경변수를 요구하지 않습니다.

## 로컬 실행

Node.js 20.3 이상과 상위 폴더의 Keycloak 서버가 필요합니다. 외부 npm 패키지는 사용하지 않습니다.

```bash
cd ..
make up
cd cli-device-auth-mvp
npm run setup
```

보호 API와 MCP 서버를 실행합니다.

```bash
npm run api
```

다른 터미널에서 CLI를 사용합니다.

```bash
npm run cli -- login
npm run cli -- whoami
npm run cli -- mcp
npm run cli -- status
npm run cli -- logout
```

정상 `logout`은 서버가 refresh token을 폐기한 뒤에만 로컬 파일을 지웁니다. 기존 issuer가 사라져 서버 폐기가 불가능한 복구 상황에서만 `logout --local` 또는 `login --force --discard-local`을 사용할 수 있습니다. 이 옵션은 서버의 token grant를 남길 수 있으므로 CLI가 강하게 경고하며, 정상 상황에서는 사용하지 않습니다.

실행 권한이 있는 엔트리포인트를 직접 호출해도 됩니다.

```bash
./bin/skillsctl.mjs login
./bin/skillsctl.mjs mcp
```

선택적으로 이 폴더에서 `npm link`를 실행하면 이후에는 어느 경로에서든 `skillsctl login`처럼 호출할 수 있습니다.

테스트 계정은 `cli-user` / `cli-password-local-only`입니다.

API 서버가 실행 중인 상태에서 전체 흐름을 자동 검증할 수 있습니다.

```bash
npm run test:e2e
```

이 테스트는 실제 `skillsctl login --no-browser`를 실행해 Device Flow를 승인하고, JWT audience/scope/role, 파일 권한, API/MCP 호출, 강제 재로그인의 이전 grant 폐기, 여러 프로세스의 동시 access token 갱신, refresh token 폐기와 로컬 로그아웃까지 확인합니다.

## 구성 요소

- `skills-cli`: client secret이 없는 public OIDC client, Device Authorization Grant 활성화
- `skills-api`: access token의 `aud`로 검증하는 resource server audience
- `http://localhost:3200/mcp`: MCP resource URL과 일치시키는 별도 audience
- `skills.read`: `/api/me` 호출에 필요한 scope
- `mcp.tools`: `/mcp` 호출에 필요한 scope
- `/.well-known/oauth-protected-resource`: MCP/OAuth resource metadata 예시

API는 JWT 서명, issuer, audience, expiry와 scope를 검증합니다. MCP mock은 Streamable HTTP 형태의 JSON-RPC `initialize`, `tools/list`, `tools/call` 요청을 처리하며 MCP 경로 자체를 audience로 검사합니다.

두 resource server 모두 scope 외에 `tester` realm role도 요구합니다. 테스트 사용자는 setup 스크립트에서 이 역할을 받습니다. 실제 회사 환경에서는 이 자리를 조직 그룹이나 업무별 client role/entitlement 정책으로 교체해야 합니다.

MCP HTTP endpoint는 허용되지 않은 `Origin`을 403으로 거부하고 로컬 주소에만 bind하여 DNS rebinding을 막습니다. 브라우저 기반 client origin을 추가해야 할 때는 운영자가 `SKILLS_MCP_ALLOWED_ORIGINS`에 쉼표로 구분해 명시합니다.

## 토큰 저장에 관한 MVP 경계

현재 토큰은 `~/.config/skillsctl-mvp/credentials.json`에 디렉터리 `0700`, 파일 `0600` 권한으로 저장됩니다. access token은 5분 후 만료되며 CLI가 `offline_access` refresh token으로 자동 갱신합니다.

이 파일 저장은 홈 프로토타입용입니다. 회사 배포판에서는 저장 모듈을 macOS Keychain, Windows Credential Manager, Linux Secret Service 같은 OS keychain 구현으로 교체해야 합니다. client secret을 CLI 바이너리에 포함하면 안 됩니다.

## 회사 환경으로 가져갈 때

1. Keycloak을 회사 IdP/AD와 연결하고 MFA 및 조직 정책을 적용합니다.
2. 개발·스테이징·운영 audience를 분리하고 최소 scope/role만 토큰에 부여합니다.
3. API/MCP 서버는 access token을 매 요청 검증하고 refresh token은 받지 않습니다.
4. CLI는 OS keychain에 refresh token을 저장하고 로그/telemetry에 토큰을 절대 남기지 않습니다.
5. 사용자 퇴사·권한 변경·기기 분실 시 refresh token/session을 서버에서 폐기할 수 있게 운영합니다.
6. 범용 MCP client 호환은 Protected Resource Metadata와 Authorization Server Metadata를 기준으로 Authorization Code + PKCE도 함께 제공합니다.

운영 issuer와 resource URL은 반드시 HTTPS를 사용해야 합니다.

현재 Keycloak은 MCP 최신 규격이 사용하는 RFC 8707 `resource` parameter를 처리하지 않습니다. 이 MVP는 고정 audience mapper로 우회하므로 자체 CLI 테스트에는 적합하지만 범용 MCP OAuth 완전 준수 구현은 아닙니다.

특히 로컬 데모 토큰 하나에는 `skills-api`와 MCP URL audience가 함께 들어갑니다. 따라서 이 데모에서는 한 resource가 탈취한 토큰을 다른 resource에 재사용할 수 있어 운영 수준의 resource 격리가 아닙니다. 회사 적용 시 RFC 8707을 지원하는 authorization server/gateway로 resource별 access token을 발급하거나, 별도 client/token set 또는 신뢰된 backend의 token exchange로 분리해야 합니다. MCP가 받은 사용자 access token을 upstream API에 그대로 전달하는 token passthrough도 금지하고, upstream용 audience/token을 별도로 사용해야 합니다.

## 참고 규격

- [OAuth 2.0 Device Authorization Grant (RFC 8628)](https://www.rfc-editor.org/rfc/rfc8628.html)
- [Keycloak OIDC endpoint와 Device Flow](https://www.keycloak.org/securing-apps/oidc-layers)
- [MCP 2026-07-28 Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Keycloak MCP integration과 RFC 8707 지원 현황](https://www.keycloak.org/securing-apps/mcp-authz-server)
