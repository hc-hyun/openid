# AuthBridge

웹 Authorization Code 로그인만 지원하는 사내 OIDC와 CLI Device Flow 사이를 연결하는 독립 프로젝트입니다. Keycloak 26, PostgreSQL, prefix-aware gateway를 자체 Compose로 실행하며 기존 저장소의 다른 MVP 폴더에 의존하지 않습니다.

```text
CLI Device Flow
  → AuthBridge Keycloak
  → 사내 OIDC 웹 로그인
  → form_post callback
  → AuthBridge gateway
  → Keycloak token
  → Skills API / MCP
```

기본 공개 주소는 현재 임시 주소인 `https://smart-dna.sec.samsung.net/ws2/30001`입니다. prefix는 단일 `AUTHBRIDGE_PUBLIC_URL`로 바꿀 수 있으며 issuer, callback, 기본 MCP audience가 함께 이동합니다.

## 최초 설정

사내 OIDC의 Discovery URL은 비밀값이 아니므로 배포 프로필에 한 번 고정합니다. 현재 예시 주소를 실제 주소로 바꾸거나 `.env`에서 덮어씁니다.

```text
config/authbridge.json
  upstream.discoveryUrl
```

그 뒤 발급을 갱신할 때 바꿀 값은 Client ID와 Client Secret 두 개뿐입니다.

```bash
cd auth-bridge
cp .env.example .env
chmod 600 .env
```

```dotenv
UPSTREAM_OIDC_CLIENT_ID=발급받은-client-id
UPSTREAM_OIDC_CLIENT_SECRET=발급받은-client-secret

# 프로필에 실제 주소를 넣지 않을 때만 사용
# UPSTREAM_OIDC_DISCOVERY_URL=https://company-idp.example/adfs/.well-known/openid-configuration
```

기본 공개 callback은 다음과 같습니다.

```text
https://smart-dna.sec.samsung.net/ws2/30001/realms/authbridge/broker/company-oidc/endpoint
```

사내 OIDC에는 현재 확인한 redirect-prefix 허용 동작을 전제로 `https://smart-dna.sec.samsung.net/` 또는 승인된 상위 prefix가 등록돼 있어야 합니다. 가능하면 운영 전에는 위 callback을 정확히 등록하는 편이 안전합니다.

## 실행

사내 인증서가 공인 CA 체인이면 다음 한 명령으로 PostgreSQL, production-mode Keycloak, gateway를 시작하고 realm을 프로비저닝합니다.

```bash
npm run setup
```

사설 CA라면 CA와 intermediate를 합친 PEM bundle의 절대 경로를 `.env`에 추가한 뒤 CA overlay를 사용합니다.

```dotenv
AUTHBRIDGE_CA_CERTIFICATE=/absolute/path/company-ca-chain.pem
```

```bash
npm run setup:ca
```

이 경로는 Keycloak의 `KC_TRUSTSTORE_PATHS`와 프로비저너 자식 프로세스의 `NODE_EXTRA_CA_CERTS`에 동시에 적용됩니다. TLS hostname 검증을 끄거나 `NODE_TLS_REJECT_UNAUTHORIZED=0`을 사용하지 않습니다.

첫 Keycloak production image build는 최적화 단계 때문에 1~2분 정도 걸릴 수 있습니다. 이후 컨테이너는 `start --optimized`로 실행됩니다. 프로비저너는 idempotent하므로 Client Secret 회전이나 설정 변경 후에도 안전하게 다시 실행할 수 있습니다.

```bash
npm run provision
npm run logs
npm run down
```

`down`은 PostgreSQL volume을 보존합니다.

## smart-dna reverse proxy 계약

외부 HTTPS proxy는 다음 계약을 지켜야 합니다.

- TLS는 `smart-dna.sec.samsung.net` 앞단에서 종료합니다.
- `/ws2/30001` prefix를 제거하지 않고 gateway의 `127.0.0.1:30001`로 전달합니다.
- Keycloak의 내부 `8080`과 management `9000`은 외부에 공개하지 않습니다.
- gateway 외부에는 `/realms/authbridge/*`와 `/resources/*`만 보이며 `/admin`, `master` realm, metrics와 `TRACE`는 404/405입니다.

Compose가 Keycloak에 적용하는 핵심값은 다음과 같습니다.

```dotenv
KC_HOSTNAME=https://smart-dna.sec.samsung.net/ws2/30001
KC_HTTP_ENABLED=true
KC_PROXY_HEADERS=xforwarded
```

`KC_HTTP_RELATIVE_PATH`는 설정하지 않습니다. Gateway가 공개 prefix를 제거한 뒤 Keycloak root로 전달하기 때문입니다.

## form_post 호환

운영 프로필은 현재 확인한 사내 동작에 맞춰 `responseMode=form_post`를 기본으로 사용합니다. Keycloak 26 generic OIDC broker callback은 `GET`만 처리하므로 gateway가 정확한 broker callback의 URL-encoded `POST`만 검증해 내부 `GET`으로 전달합니다.

- 최대 8 KiB 및 내부 query 재인코딩 후 길이 재검사
- `state` 필수, `code` 또는 `error` 중 정확히 하나
- 표준 필드 allowlist와 중복/잘못된 encoding 거부
- 브라우저 URL에 code를 다시 노출하지 않음
- callback 내부 요청에는 Cookie, Accept 계열, User-Agent만 전달
- code, state, token을 gateway log에 기록하지 않음

사내 서버가 `query`를 지원하는 것으로 확정되면 `config/authbridge.json`의 `responseMode`를 `query`로 바꿀 수 있습니다. 두 모드 모두 실제 mock OIDC 전체 E2E로 검증됩니다.

## CLI 설정

최종 사용자는 Client Secret이나 API key를 받지 않습니다. CLI에는 공개 issuer와 public client ID만 배포합니다.

```dotenv
SKILLS_OIDC_ISSUER=https://smart-dna.sec.samsung.net/ws2/30001/realms/authbridge
SKILLS_OIDC_CLIENT_ID=skills-cli
SKILLS_OIDC_AUDIENCE=skills-api
SKILLS_MCP_AUDIENCE=https://smart-dna.sec.samsung.net/ws2/30001/mcp
SKILLS_OIDC_SCOPE=openid profile email offline_access skills.read mcp.tools
```

이 저장소의 MVP CLI로 로그인할 때는 다음과 같습니다.

```bash
cd ../cli-device-auth-mvp
node bin/skillsctl.mjs login --no-browser
```

표시된 URL을 브라우저에서 열어 사내 인증을 완료하면 CLI가 access/refresh token을 자체 credential 파일에 저장합니다.

Gateway는 Keycloak 인증 경로 전용이므로 `/mcp` API 자체를 대신 서비스하지 않습니다. 운영 proxy는 `/ws2/30001/mcp`를 실제 MCP resource server로 별도 라우팅해야 합니다. MCP가 다른 주소라면 `.env`의 `AUTHBRIDGE_MCP_AUDIENCE`로 정확한 resource identifier를 지정하세요.

## 프로비저닝 결과

`npm run provision`은 다음 항목을 생성 또는 갱신합니다.

- 전용 `authbridge` realm
- Device Authorization Grant public client `skills-cli`
- bearer-only resource client `skills-api`
- `skills.read`, `mcp.tools`, `offline_access` scope
- Skills API와 정확한 MCP resource audience mapper
- Discovery 기반 `company-oidc` Identity Provider
- 브라우저 로그인 폼을 건너뛰는 사내 IdP redirector
- broker 사용자용 `tester` realm role과 mapper

마지막 `tester` hardcoded role은 MVP 검증용입니다. 실제 배포 전에는 사내 group/entitlement claim allowlist mapper로 교체하고, AD FS가 제공하는 `upn`, email, group claim 이름도 실제 토큰 기준으로 확정해야 합니다. `offline_access`를 유지하면 퇴사·분실·계정 비활성화 시 Keycloak offline session 폐기 정책도 함께 운영해야 합니다.

## 보안 메모

- `.env`, 실제 secret, private key와 인증서는 Git에 넣지 않습니다.
- Compose의 기본 DB/admin 비밀번호는 로컬 MVP 전용입니다. 회사 배포에서는 `.env` 또는 secret manager로 반드시 교체합니다.
- 운영 Discovery의 issuer, authorization, token, JWKS, UserInfo, logout endpoint는 모두 HTTPS만 허용합니다. HTTP 예외는 mock 프로필에서만 명시적으로 활성화됩니다.
- 사내 TLS CA bundle은 Node와 Keycloak truststore에 사용합니다. AD FS token-signing 인증서는 Discovery의 `jwks_uri`를 통해 회전됩니다.
- 제공받은 인증서가 TLS client PFX/private key이고 사내 서버가 mTLS client authentication을 요구한다면 현재의 Client ID/Secret 구성과 다른 계약이므로 별도 구현이 필요합니다.
- 내부 callback `GET`에는 일회용 code/state query가 불가피하므로 Keycloak, sidecar, APM에서 query-string access log를 끕니다.

## 테스트

네트워크 없이 설정, secret 마스킹, HTTPS 경계, Keycloak 표현식, gateway 공격 경계를 검사합니다.

```bash
npm test
npm run test:mock
```

Docker가 실행 중이면 query와 form_post 두 전체 흐름을 직렬로 검증합니다.

```bash
npm run test:e2e
```

각 테스트는 다음을 실제 HTTP와 서명된 JWT로 확인합니다.

- mock 사내 OIDC Authorization Code 로그인
- 정확한 Client ID, redirect URI, state, nonce와 response mode
- 공개 prefix callback이 query에서는 `GET`, form_post에서는 실제 `POST`인지
- Keycloak broker code 교환과 broker 사용자 연결
- AuthBridge issuer, `tester` role, scope, API/MCP audience
- CLI `whoami`, 보호 API, MCP 호출과 logout/revocation

mock 상세는 [`mock/README.md`](mock/README.md), gateway 상세는 [`gateway/README.md`](gateway/README.md)에 있습니다.
