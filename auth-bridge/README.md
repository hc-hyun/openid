# AuthBridge — Stage A

Keycloak 26을 사내 웹 OIDC와 CLI Device Flow 사이의 인증 브리지로 구성하는 무의존성 Node.js 프로비저너입니다. 기존 MVP 폴더와 독립적으로 동작합니다.

## 준비

Node.js 20 이상과 실행 중인 Keycloak 26이 필요합니다. 기본 관리자 주소와 계정은 상위 저장소의 로컬 Compose 설정(`http://localhost:8080`, `admin` / `admin-local-only`)에 맞춰져 있습니다.

비밀값 파일을 만들고 발급받은 두 값만 바꿉니다.

```bash
cd auth-bridge
cp .env.example .env
```

```dotenv
UPSTREAM_OIDC_CLIENT_ID=발급받은-client-id
UPSTREAM_OIDC_CLIENT_SECRET=발급받은-client-secret
```

사내 Discovery URL은 비밀값이 아니므로 [`config/authbridge.json`](config/authbridge.json)의 `upstream.discoveryUrl`에 둡니다. 현재 공개 URL의 `/ws2/30001`은 임시값이며 `.env`의 `AUTHBRIDGE_PUBLIC_URL`로 코드 변경 없이 덮어쓸 수 있습니다.

## 실행

```bash
npm run provision
```

프로비저너는 매번 같은 결과가 되도록 생성 또는 갱신합니다.

- 전용 `authbridge` realm과 `tester` realm role
- Device Authorization Grant가 활성화된 public `skills-cli`
- bearer-only `skills-api`
- 기본 `skills.read`, `mcp.tools` scope와 선택적 `offline_access`
- Skills API 및 MCP access-token audience mapper
- Discovery 문서 기반 `company-oidc` OIDC Identity Provider
- 모든 broker 사용자에게 `tester`를 부여하는 hardcoded role mapper
- 로그인 폼을 건너뛰고 사내 OIDC로 보내는 Browser Flow Identity Provider Redirector

성공 시 사내 OIDC에 사용될 callback을 출력합니다. 기본값은 다음과 같습니다.

```text
https://smart-dna.sec.samsung.net/ws2/30001/realms/authbridge/broker/company-oidc/endpoint
```

등록된 루트 Redirect URI가 하위 경로를 허용한다는 현재 테스트 전제를 사용합니다. Keycloak 26 generic OIDC broker는 별도 `responseMode` 설정을 적용하지 않으므로, 프로비저너가 Discovery의 authorization endpoint에 `response_mode=query`를 명시합니다. 인증 흐름은 Authorization Code 방식이며 callback에는 `code`와 `state`가 전달됩니다.

> Keycloak 26.7.2의 기본 OIDC broker callback은 `GET`만 처리합니다. 사내 서버가 `form_post`를 강제한다면 이 단계의 설정만으로는 동작하지 않으며, 이 프로젝트의 다음 단계에서 제공하는 제한된 POST callback adapter를 함께 사용해야 합니다. 기존 테스트 앱이 `form_post`를 요청했을 뿐 서버가 강제하지 않는 경우에는 현재 `query` 구성이 그대로 동작합니다.

## 구성과 보안

- 비밀값은 `.env`/환경변수에서만 읽으며 `.env`는 Git에서 제외됩니다.
- 프로비저너는 Client Secret, 관리자 비밀번호 또는 토큰을 출력하지 않으며 오류 응답도 마스킹합니다.
- 실제 Client Secret이나 인증서/private key를 JSON 프로필 또는 저장소에 넣지 마세요.
- 운영 Keycloak 관리 계정이 다르면 `KEYCLOAK_ADMIN_USERNAME`과 `KEYCLOAK_ADMIN_PASSWORD`를 환경변수로 설정하세요.
- HTTPS 사내 인증서가 사설 CA라면 Node 실행 환경과 Keycloak 양쪽 truststore에 해당 CA를 신뢰시키세요. TLS 검증을 끄는 방식은 지원하지 않습니다.

프로필 전체 필드와 URL, 이름, 시간값, scope 중복을 네트워크 요청 전에 검증합니다. Discovery도 `issuer`, Authorization Code endpoint, token endpoint, JWKS endpoint를 검증합니다.

## 테스트

```bash
npm test
```

실제 서버 없이 설정 로딩/검증, callback 계산, 비밀 마스킹, Keycloak realm/client/IdP/mapper 표현식을 `node:test`로 확인합니다.
