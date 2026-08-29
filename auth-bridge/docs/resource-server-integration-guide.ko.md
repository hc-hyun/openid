# AuthBridge Resource Server 연동 가이드

이 문서는 AuthBridge가 발급한 OAuth 2.0 JWT access token으로 사내 API를 보호할 때 서비스팀이 구현해야 할 공통 계약입니다. 서비스별 온보딩 요청과 구현 검수에 그대로 사용할 수 있습니다.

## 역할 경계

```text
Codex MCP client 또는 companyctl
  -> access token을 Authorization header에 첨부
  -> 만료 시 AuthBridge에서 refresh

Resource server
  -> access token 검증
  -> endpoint 권한 확인
  -> 성공 또는 401/403 반환

AuthBridge / Keycloak
  -> 사내 OIDC 로그인 중계
  -> access/refresh token 발급·갱신·폐기
```

서비스팀에는 다음과 같이 안내합니다.

> 모든 보호 API 요청은 `Authorization: Bearer <access_token>` 형식으로 받습니다.
> 서비스는 AuthBridge가 발급한 JWT access token을 로컬에서 검증하고 endpoint 권한을 확인합니다.
> 서비스는 refresh token을 받거나 저장하지 않으며, access token 만료 시 인증서버에 refresh 요청을 하지 않습니다.

인증은 token의 유효성과 호출자 신원을 확인하는 단계이고, 권한 부여는 scope와 합의된 role/group으로 해당 endpoint 호출 가능 여부를 결정하는 단계입니다. 서명 검증만 구현하고 권한 확인을 생략하면 안 됩니다.

## 서비스 온보딩 전에 확정할 값

| 항목 | 예시 | 책임 |
|---|---|---|
| 환경 | 개발, 스테이징, 운영 | 서비스팀·플랫폼팀 |
| Issuer | `https://smart-dna.sec.samsung.net/ws2/30001/realms/authbridge` | 플랫폼팀 |
| Discovery | `{issuer}/.well-known/openid-configuration` | Issuer에서 파생 |
| Audience | `order-api` 또는 승인된 URI | 플랫폼팀이 서비스별 고유값 할당 |
| Required scopes | `order.read`, `order.write` | 서비스팀이 endpoint별 제안, 플랫폼팀 승인 |
| 추가 권한 | role/group/entitlement와 claim 경로 | 보안·플랫폼·서비스팀 합의 |
| 허용 알고리즘 | 현재 MVP verifier 계약 `RS256` | 플랫폼팀 |
| Access token 수명 | 현재 프로필 `300`초 | 플랫폼팀 |
| Clock skew | 현재 검증 예제 `60`초 | 플랫폼팀 |
| 즉시 폐기 요구 | introspection 또는 별도 정책 필요 여부 | 서비스팀·보안팀 |

Audience는 token의 `aud` claim에 들어가는 대상 식별자이며 서비스 URL과 반드시 같을 필요는 없지만, 환경과 서비스 사이에서 충돌하지 않는 고유값이어야 합니다. Scope는 대소문자를 구분하는 권한 문자열입니다.

현재 저장소의 프로비저너는 `skills-api`와 MCP resource audience, `skills.read`와 `mcp.tools`만 생성합니다. `order-api`와 `order.read` 같은 값은 예시일 뿐 현재 자동 생성되지 않습니다. 신규 서비스 전달 전에 플랫폼팀이 다음 중 승인된 방식으로 audience와 scope 발급 경로를 먼저 구성해야 합니다.

- 서비스별 bearer-only client와 audience mapper
- 서비스별 전용 client/token set
- 향후 resource-aware token 발급 또는 token exchange

현재 MVP처럼 하나의 token에 여러 서비스 audience를 계속 추가하는 방식은 운영 기본안으로 사용하지 않습니다.

## 요청 계약

보호 endpoint는 HTTPS 요청의 `Authorization` header에서 access token 하나만 받습니다.

```http
GET /v1/orders/123 HTTP/1.1
Host: order-api.example.internal
Authorization: Bearer eyJ...
Accept: application/json
```

다음 입력은 거부합니다.

- Query parameter 또는 request body의 access token
- ID token을 API access token으로 사용한 요청
- Refresh token을 API로 보낸 요청
- 한 요청에 여러 인증 방식을 함께 보낸 요청

API는 인증 실패 시 브라우저 로그인 페이지로 redirect하지 않습니다. 기계가 처리할 수 있는 HTTP 상태와 `WWW-Authenticate` challenge를 반환합니다.

## 필수 JWT 검증

검증은 직접 작성한 parser보다 각 언어 생태계에서 유지보수되는 OAuth 2.0 resource server/JWT 라이브러리를 사용합니다. 최소 검증 계약은 다음과 같습니다.

1. Compact JWT 형식과 Bearer header 형식을 검사합니다.
2. 설정된 exact issuer의 Discovery에서 `jwks_uri`를 얻습니다.
3. Discovery/JWKS URL과 redirect가 HTTPS를 유지하고 TLS CA·hostname 검증을 통과하는지 확인합니다.
4. 플랫폼팀이 허용한 알고리즘만 허용하고 현재 MVP verifier 계약에서는 `RS256`을 사용합니다. Token header의 `alg` 값을 그대로 신뢰해 알고리즘을 선택하거나 `none`을 허용하지 않습니다.
5. `kid`에 해당하는 issuer 소유 공개키로 서명을 검증합니다.
6. RFC access-token type 또는 Keycloak access-token marker를 확인해 ID token과 refresh token을 배타적으로 거부합니다.
7. `iss`가 configured issuer와 문자열로 정확히 일치하는지 확인합니다.
8. `aud`가 문자열 또는 배열인 경우 모두 처리하고, 자기 서비스 audience가 정확히 포함돼 있는지 확인합니다.
9. 숫자형 `exp`가 존재하고 만료되지 않았는지, `nbf`가 있다면 아직 이르지 않은지 확인합니다. Clock skew는 플랫폼 기준 이내로 제한합니다.
10. 사용자 주체가 필요한 API는 비어 있지 않은 `sub`를 사용합니다. Email이나 표시 이름을 영구 사용자 key로 사용하지 않습니다.
11. Endpoint에 필요한 scope가 token의 공백 구분 `scope` 집합에 모두 포함돼 있는지 확인합니다.
12. 합의된 endpoint에만 확정된 claim 경로의 role/group/entitlement를 추가 확인합니다.

Token의 `jku`, `x5u` 같은 header가 가리키는 임의 URL에서 key를 가져오지 않습니다. 공개키 출처는 configured issuer Discovery의 `jwks_uri`로만 제한해 SSRF와 신뢰 우회를 막습니다.

현재 `tester` realm role과 `realm_access.roles` 경로는 MVP 검증용입니다. 운영 group/entitlement claim 계약이 확정되기 전에는 이를 모든 서비스의 공통 권한 계약으로 하드코딩하지 않습니다.

## 공개키와 인증서버 통신

API 서비스는 JWT 서명을 검증할 공개키만이 아니라 exact issuer, 자기 audience, endpoint별 required scope와 허용 알고리즘도 설정해야 합니다. 반대로 일반적인 JWT resource server에는 redirect URI, OIDC client secret 또는 refresh token이 필요하지 않습니다.

```text
시작·cache 갱신·key rotation
  API 서비스 -> AuthBridge Discovery/JWKS 공개 endpoint

일반 API 요청
  Client -> Bearer access token -> API 서비스
                                -> cache한 공개키로 로컬 검증
```

정상 요청마다 AuthBridge에 token 유효 여부를 묻지 않습니다. API 서비스가 인증서버와 통신하는 시점은 보통 시작 또는 최초 검증 시 Discovery/JWKS를 가져올 때, cache 갱신 시점, 그리고 모르는 `kid`를 받아 signing key 교체를 확인할 때뿐입니다. JWKS의 공개키는 secret이 아니지만 출처를 configured issuer로 고정하고 cache해야 합니다.

공개키 파일을 서비스에 고정 배포해 인증서버 통신을 완전히 없애는 것도 기술적으로 가능하지만 운영 기본안으로 권장하지 않습니다. Realm signing key가 교체될 때 모든 서비스의 key 교체와 재배포가 필요하고, 누락된 서비스는 정상 token을 거부하게 됩니다. 특별한 망 분리 요구가 없다면 Discovery/JWKS 자동 갱신 방식을 사용합니다.

인증서버와 요청 단위 또는 별도 token 통신이 필요한 경우는 다음과 같은 예외입니다. 적용할 때는 플랫폼·보안팀과 client 인증, 장애 및 cache 정책을 별도로 정합니다.

- Opaque access token을 사용하는 경우의 token introspection
- 로그아웃, 계정 차단 또는 권한 회수를 즉시 반영하기 위한 introspection/정책 조회
- Downstream 서비스용 token을 새로 받기 위한 token exchange

이러한 예외가 없으면 API 서비스는 token endpoint를 호출하거나 access token을 refresh하지 않습니다. AuthBridge/JWKS 장애 중에도 사용할 수 있는 key cache가 있으면 합의된 cache 정책 안에서 로컬 검증을 계속할 수 있고, usable key가 없으면 fail-closed 합니다.

## Discovery와 JWKS cache

- Discovery와 JWKS는 process 또는 공용 middleware cache에 보관하며 매 요청마다 AuthBridge를 호출하지 않습니다.
- Cache TTL과 HTTP cache header를 존중하고 key rotation 동안 기존 key도 합리적인 기간 유지합니다.
- 알 수 없는 `kid`를 받으면 JWKS를 한 번 갱신한 뒤 다시 검증합니다.
- Unknown `kid`를 이용한 외부 요청이 JWKS fetch 폭주를 만들지 않도록 refresh를 단일화하고 rate limit/cooldown을 둡니다.
- TLS CA와 hostname을 검증합니다.
- 정상적으로 JWKS를 갱신한 뒤에도 key가 없으면 `401 invalid_token`으로 거부합니다.
- 시작 시 usable key cache가 없고 Discovery/JWKS 자체가 장애라면 token을 임의로 허용하지 않고 fail-closed 합니다. 이 경우 사용자 token 오류와 구분할 수 있도록 `503 Service Unavailable` 적용 여부를 공통 middleware 정책으로 정합니다.

저장소의 예제 verifier는 `RS256`, exact issuer/audience, 60초 clock skew, Discovery/JWKS cache와 unknown `kid` refresh cooldown을 구현합니다. 예제는 [`cli-device-auth-mvp/lib/jwt.mjs`](../../cli-device-auth-mvp/lib/jwt.mjs)를 참고하되 운영 서비스는 검증된 framework middleware를 우선합니다.

## 오류 응답 계약

### Token이 없는 경우

사내 공통 오류 계약은 token 누락도 `invalid_token`으로 정규화합니다. RFC 6750의 일반 권고는
인증정보가 전혀 없을 때 `error`를 생략하는 것이지만, 이 연동에서는 client가 같은 복구 분기를
사용하도록 다음 exact challenge를 적용합니다.

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token"
```

### Token이 유효하지 않은 경우

Token 형식, 서명, issuer, audience, 만료시간 또는 활성시간 검증에 실패하면 다음과 같이 반환합니다.

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token"
```

응답 body와 `error_description`에는 token 원문, claim, key 정보나 내부 검증 stack을 포함하지 않습니다.

### 권한이 부족한 경우

Token 자체는 유효하지만 필요한 scope 또는 합의된 role/group이 없으면 `403`을 반환합니다.

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope"
```

`401`을 받은 client는 조건이 맞으면 token을 한 번 갱신한 후 요청을 한 번만 재시도할 수 있습니다. `403`은 refresh로 해결하지 않으며 반복 재시도하지 않습니다.

## Refresh와 폐기 경계

Resource server는 다음 작업을 하지 않습니다.

- Refresh token 수신·저장·log 기록
- Access token 만료 시 Keycloak token endpoint 호출
- 사용자 브라우저 로그인 시작
- Refresh 실패 복구 또는 로그아웃 처리

Refresh token을 소유한 Codex MCP client, `companyctl` 또는 사용자 session을 소유한 BFF가 access token 만료 전에 AuthBridge token endpoint에서 새 token을 받고 회전된 refresh token을 저장합니다.

JWT 로컬 검증만으로는 로그아웃, 계정 비활성화나 권한 회수를 access token 만료 전에 즉시 알 수 없습니다. 현재 5분 access token이면 최장 해당 잔여시간만큼 이전 권한이 남을 수 있습니다. 더 빠른 폐기가 필요한 고위험 서비스는 플랫폼·보안팀과 다음을 별도로 설계합니다.

- Confidential resource client를 이용한 token introspection
- 더 짧은 access token 수명
- Gateway/정책 서버 또는 revocation event 연동

Introspection을 추가하더라도 resource server가 refresh token을 보관하거나 갱신하는 것은 아닙니다.

## 다른 서비스 호출

서비스 A가 받은 A용 access token을 서비스 B에 그대로 전달하지 않습니다. B는 자기 audience가 없는 token을 거부해야 합니다.

- 사용자 위임이 필요하면 B audience와 최소 scope를 가진 token exchange를 사용합니다.
- 사용자 위임이 필요하지 않은 background 호출은 서비스별 workload identity 또는 client credentials를 사용합니다.
- 같은 token을 여러 서비스가 받도록 multi-audience를 넓히는 방식은 최소권한과 사고 격리를 약화하므로 예외 승인을 받습니다.

현재 AuthBridge에는 범용 resource별 token exchange가 완성되어 있지 않습니다. Downstream 호출이 필요한 서비스는 구현 전에 플랫폼팀과 별도 token 계약을 확정해야 합니다.

## Logging과 운영 보안

- Access/refresh/ID token과 `Authorization` header를 application, proxy, APM, trace와 오류 응답에서 redaction 합니다.
- Token의 raw claims 전체를 log에 남기지 않습니다. 필요한 경우 `iss`, 해시 또는 비식별 처리한 `sub`, 검증 결과, 정책 ID처럼 승인된 최소 필드만 기록합니다.
- Token을 URL에 넣지 않습니다. URL은 browser history, proxy와 access log에 남을 수 있습니다.
- 검증 실패 횟수, 원인 분류, JWKS refresh 결과는 token 원문 없이 metric으로 수집합니다.
- 서비스가 Gateway 뒤에 있어도 직접 접근을 막는 network policy/mTLS가 없다면 서비스 자체 검증을 생략하지 않습니다.

## 서비스팀 전달 템플릿

플랫폼팀은 서비스마다 다음 양식을 채워 전달합니다.

```text
[AuthBridge Resource Server 연동 정보]

서비스명 / 환경:
Issuer:
Discovery URL:
Exact audience:
허용 서명 알고리즘:
Access token 수명:
Clock skew:
공개키 방식: Discovery/JWKS cache
인증서버 통신 예외: 없음 또는 introspection/token exchange 정책

Endpoint -> required scopes:
- GET  /v1/orders/{id} -> order.read
- POST /v1/orders      -> order.write

추가 role/group 정책과 claim 경로:
즉시 폐기 요구 여부:
Downstream 서비스 호출 여부:
공용 middleware/예제 위치:
플랫폼 지원 담당:
```

서비스팀은 redirect URI, OIDC Client Secret 또는 refresh token을 요청하지 않습니다. 이 값들은 로그인 client/AuthBridge 영역의 값이며 일반 resource server의 로컬 JWT 검증에는 필요하지 않습니다.

## 인수 테스트

| 시나리오 | 기대 결과 |
|---|---|
| 유효한 issuer/audience/scope의 access token | 업무 응답 `2xx` |
| Authorization header 없음 | `401 invalid_token` |
| Token 형식 오류 또는 잘못된 서명 | `401 invalid_token` |
| 만료 또는 아직 활성화되지 않은 token | `401 invalid_token` |
| 잘못된 issuer | `401 invalid_token` |
| 다른 서비스 audience | `401 invalid_token` |
| ID token을 Bearer로 사용 | `401 invalid_token` |
| 필요한 scope/role/group 누락 | `403 insufficient_scope` |
| Realm signing key rotation | JWKS 갱신 후 정상 검증 |
| AuthBridge/JWKS 장애와 빈 cache | Fail-closed, 합의된 `503` 정책 |
| Application/proxy/APM log 검사 | Token과 Authorization header 없음 |
| 만료 token 이후 client refresh·1회 재시도 | 새 access token으로 성공 |

## 서비스 구현 완료 체크리스트

- [ ] Header-only Bearer access token 계약 적용
- [ ] 검증된 JWT/resource server library 사용
- [ ] 허용 알고리즘, exact issuer와 exact audience 검증
- [ ] `exp`, optional `nbf`, `sub` 검증
- [ ] Endpoint별 scope와 합의된 추가 권한 검증
- [ ] 요청마다 인증서버를 호출하지 않고 cache한 공개키로 로컬 검증
- [ ] Discovery/JWKS cache, rotation과 unknown `kid` 보호
- [ ] 정확한 `401`/`403` challenge 계약 적용
- [ ] Refresh token과 client secret을 서비스에 배포하지 않음
- [ ] Token, Authorization header와 raw claims log redaction
- [ ] Downstream token 전달 방식 별도 검토
- [ ] 위 인수 테스트 통과

## 기준 문서

- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)
- [RFC 8725: JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html)
- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://www.rfc-editor.org/rfc/rfc9068.html)
- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html)
- [Keycloak OIDC endpoints](https://www.keycloak.org/securing-apps/oidc-layers)
