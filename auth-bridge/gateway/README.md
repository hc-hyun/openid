# AuthBridge Gateway

Keycloak 앞에서 `/ws2/30001` 같은 공개 prefix를 제거하고, 사내 OIDC가 반환하는 `form_post` callback을 Keycloak이 처리할 수 있는 내부 `GET` callback으로 바꾸는 무의존성 Node.js 20 게이트웨이입니다.

## 실행

기본값은 현재 운영 테스트 주소와 로컬 Keycloak에 맞춰져 있습니다.

```bash
cd auth-bridge/gateway
npm start
```

```text
public URL       https://smart-dna.sec.samsung.net/ws2/30001
listen           127.0.0.1:30001
Keycloak backend http://localhost:8080
health           http://127.0.0.1:30001/healthz
```

임시 prefix나 배포 주소가 바뀌면 전체 공개 URL 하나만 바꿉니다.

```bash
AUTHBRIDGE_GATEWAY_PUBLIC_URL=https://example.internal/new-prefix \
AUTHBRIDGE_GATEWAY_PORT=30001 \
AUTHBRIDGE_KEYCLOAK_URL=http://localhost:8080 \
npm start
```

`AUTHBRIDGE_PUBLIC_URL`도 공개 URL의 호환 환경변수로 인식합니다. Keycloak에는 `proxy-headers=xforwarded`를 활성화해야 합니다. 게이트웨이는 클라이언트가 보낸 `Forwarded` 및 `X-Forwarded-*` 값을 신뢰하지 않고 공개 URL 기준으로 덮어씁니다.

## form_post adapter

아래 공개 callback의 `POST` 요청만 adapter가 처리합니다.

```text
https://smart-dna.sec.samsung.net/ws2/30001/realms/authbridge/broker/company-oidc/endpoint
```

- `application/x-www-form-urlencoded`만 허용
- 본문 최대 8 KiB
- 비어 있지 않은 `state` 필수
- 비어 있지 않은 `code` 또는 `error` 중 정확히 하나만 허용
- `code`, `state`, `iss`, `session_state`, `error`, `error_description`, `error_uri` 외 모든 필드 거부
- 중복 필드와 잘못된 form encoding 거부

검증을 통과하면 브라우저를 code가 포함된 URL로 redirect하지 않습니다. 게이트웨이가 Keycloak backend callback을 내부 `GET`으로 호출하고, Keycloak의 status, `Location`, `Set-Cookie`, body를 브라우저에 그대로 전달합니다. 요청 본문, query, code 및 token은 로그에 남기지 않습니다.

같은 prefix 안에서도 `authbridge` realm과 Keycloak 정적 리소스만 프록시합니다. `/admin`, `master` realm, metrics/management 경로는 공개하지 않으며 관리 작업은 내부 Keycloak 주소로만 수행합니다. 허용된 일반 요청은 메서드와 query를 유지합니다. 요청 본문 제한은 기본 10 MiB이며 `AUTHBRIDGE_GATEWAY_MAX_BODY_BYTES`로 바꿀 수 있습니다. Backend timeout은 기본 30초이며 `AUTHBRIDGE_GATEWAY_TIMEOUT_MS`로 설정합니다.

## 테스트

실제 Keycloak 없이 가짜 backend로 검증합니다.

```bash
npm test
```
