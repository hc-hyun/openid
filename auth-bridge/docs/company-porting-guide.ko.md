# AuthBridge 사내 포팅 가이드

이 문서는 AuthBridge를 사내 OIDC, Nginx/Ingress, 외부 DB 및 Kubernetes 환경에 연결할 때 확인할 계약을 정리합니다. 현재 저장소에는 Docker Compose 배포가 구현되어 있으며 Kubernetes manifest/Helm chart는 아직 포함하지 않습니다.

## 결정 요약

- OIDC 응답 방식은 `query`와 `form_post`를 모두 지원합니다.
- `form_post`에서는 현재 Gateway adapter가 필요합니다.
- `query`에서도 prefix 처리와 공개 경로 제한을 위해 Gateway를 유지하는 구성이 기본입니다.
- 사내 DB 인프라는 사용할 수 있지만 Keycloak 전용 database 또는 최소 전용 schema와 계정이 필요합니다.
- Kubernetes Secret은 배포 입력값을 전달하고 회전시키는 수단이지 Keycloak DB를 대체하지 않습니다.
- 현재 프로비저너는 사내 OIDC Client Secret을 Keycloak IdP 설정으로 저장하므로 DB에도 해당 값의 사본이 남습니다.

## 목표 토폴로지

```text
Browser / CLI
  -> Nginx 또는 Ingress:443 (TLS 종료)
  -> AuthBridge Gateway
  -> Keycloak
  -> 사내 외부 DB

Provision Job
  -> 사내 OIDC Discovery
  -> Keycloak Admin API
```

Gateway는 무상태이므로 복제할 수 있습니다. Keycloak과 Gateway의 관리·health 포트는 클러스터 내부에만 두고 공개 트래픽은 Nginx/Ingress를 통해서만 받습니다.

## 사내 OIDC 사전 확인 항목

다음 항목은 환경별 배포 프로필로 관리합니다.

- Discovery URL과 issuer
- Client ID와 Client Secret
- `client_secret_post` 또는 `client_secret_basic`
- `query` 또는 `form_post` response mode
- 승인된 Redirect URI 또는 redirect prefix
- `sub`, username/UPN, email, name, group/entitlement claim
- UserInfo 및 logout endpoint 제공 여부
- HTTPS 인증서의 발급 CA와 mTLS 요구 여부

기본 Redirect URI는 다음과 같습니다.

```text
https://smart-dna.sec.samsung.net/ws2/30001/realms/authbridge/broker/company-oidc/endpoint
```

운영에서는 상위 prefix 허용에만 의존하기보다 가능한 경우 정확한 URI를 등록합니다.

## OIDC response mode 선택

사내 Discovery의 `response_modes_supported`와 실제 로그인 동작을 확인해 `config/authbridge.json`의 `upstream.responseMode`를 선택합니다. Discovery가 해당 필드를 제공하지 않으면 실제 브라우저 smoke test로 확인합니다.

| 모드 | 사내 IdP callback | Gateway 처리 |
|---|---|---|
| `query` | `GET` query parameter | 변환 없이 Keycloak으로 전달 |
| `form_post` | URL-encoded `POST` body | 검증 후 내부 Keycloak `GET` callback으로 변환 |

```json
{
  "upstream": {
    "responseMode": "query"
  }
}
```

변경 후 idempotent 프로비저너를 다시 실행합니다.

```bash
npm run provision
```

Kubernetes에서는 같은 작업을 provision Job 재실행으로 구성합니다. 현재 환경변수로 response mode 하나만 덮어쓰는 기능은 없으므로 프로필 JSON을 ConfigMap으로 mount하고 `AUTHBRIDGE_CONFIG`로 경로를 지정합니다.

### Gateway 유지 또는 제거

`form_post`에서는 현재 Gateway가 정확한 callback만 검증하고 POST body를 Keycloak 26 generic OIDC broker가 처리할 수 있는 형태로 변환하므로 필수입니다.

`query`에서는 form adapter가 동작하지 않지만 Gateway를 유지하는 것을 기본으로 합니다. Gateway가 다음 공통 역할도 담당하기 때문입니다.

- `/ws2/30001` public prefix 제거
- 공개 경로를 `/realms/authbridge/*`와 `/resources/*`로 제한
- 위조 가능한 forwarded header 제거 및 공개 URL 기준 재설정
- Keycloak readiness 확인

`query`에서 Gateway를 제거하려면 Nginx/Ingress가 prefix 제거, forwarded header 정규화, 공개 경로 allowlist, admin/master/management 포트 차단을 모두 대신해야 합니다. Gateway 유지 구성과 prefix rewrite 구성을 혼용하면 callback 및 정적 리소스 경로가 깨집니다.

## Nginx/Ingress 계약

Gateway를 유지할 때는 `/ws2/30001` prefix를 제거하거나 재작성하지 않고 전달합니다.

```text
https://smart-dna.sec.samsung.net/ws2/30001/...
  -> http://gateway:30001/ws2/30001/...
```

다음 조건을 유지합니다.

- callback의 POST body, `Content-Type`, Cookie를 그대로 전달
- Keycloak 응답의 `Location`과 복수 `Set-Cookie`를 임의 변환하지 않음
- Keycloak `8080`, management `9000`, DB를 외부에 공개하지 않음
- `AUTHBRIDGE_PUBLIC_URL`과 실제 scheme, host, prefix를 정확히 일치시킴
- 실제 Chrome/Edge에서 cross-site `form_post`와 Secure/SameSite cookie 동작 확인

## DB는 설정 파일이 아니다

Keycloak DB 데이터는 크게 재생성 가능한 설정과 런타임 영속 상태로 나뉩니다.

| 구분 | 주요 데이터 | 재프로비저닝만으로 복구 |
|---|---|---|
| 정적 설정 | realm, client, scope, role, mapper, IdP endpoint | 대부분 가능 |
| 민감 설정 | 사내 OIDC Client Secret, realm 서명·암호화 key | 별도 보호 및 백업 필요 |
| 사용자 연결 | broker user profile, 사내 `sub`, federated identity link | 최초 로그인으로 일부 재생성되지만 동일성·권한 검토 필요 |
| 런타임 상태 | online/offline session, consent, revocation 상태 | 불가능 |

현재 설정의 데이터 경계는 다음과 같습니다.

- 사내 비밀번호는 사내 IdP 페이지에만 입력하며 AuthBridge에 저장하지 않습니다.
- `storeToken=false`이므로 사내 IdP access/refresh token을 장기 보관하지 않습니다.
- Keycloak이 발급한 JWT 원문은 CLI가 사용자 credential 파일에 저장합니다. 서버 DB는 세션과 폐기 상태를 관리합니다.
- `syncMode=IMPORT`이므로 broker user profile은 최초 로그인 시 가져오며 매 로그인마다 자동 갱신하지 않습니다.
- 현재 `tester` hardcoded role은 MVP용이므로 운영 전에 group/entitlement mapper로 교체합니다.

DB 파일뿐 아니라 WAL/redo log와 백업에도 민감정보가 포함될 수 있으므로 암호화, 최소권한, 접근감사, 보존기간과 복구 절차를 함께 적용합니다.

## 사내 외부 DB 사용

기존 DB 클러스터는 재사용할 수 있지만 기존 업무 애플리케이션의 schema/user와 공유하지 않습니다.

권장 순서는 다음과 같습니다.

1. `authbridge` 전용 database와 전용 계정
2. 불가능하면 전용 schema와 전용 계정
3. Keycloak 지원 DB 종류와 버전, UTF-8, TLS server verification 확인
4. 최초 설치와 Keycloak 업그레이드 시 schema migration 권한 및 백업 절차 확보
5. 읽기 전용 replica가 아닌 writable primary/HA endpoint 사용

현재 Compose와 optimized Keycloak image는 PostgreSQL을 전제로 합니다.

- `KC_DB=postgres`는 image build 설정입니다.
- `KC_DB_URL`은 Compose 내부의 `postgres:5432`로 고정되어 있습니다.
- DB 이름, 사용자명, 비밀번호만 `AUTHBRIDGE_DB_*` 환경변수로 바꿀 수 있습니다.

따라서 외부 사내 PostgreSQL이나 Kubernetes로 옮길 때는 내부 PostgreSQL service와 `depends_on`을 제거하고 `KC_DB_URL`, `KC_DB_SCHEMA`, 계정, TLS 설정을 Keycloak Pod에 직접 주입하는 manifest가 필요합니다. PostgreSQL 외 DB를 사용하면 DB 종류에 맞게 Keycloak image를 다시 build하고 공식 지원 버전과 JDBC driver 조건을 재검증합니다.

## Kubernetes ConfigMap과 Secret 분류

다음 분류는 권장 기준입니다. 회사 보안정책에 따라 비밀이 아닌 식별자도 Secret에 함께 둘 수 있습니다.

| 저장 위치 | 값 |
|---|---|
| ConfigMap | public URL, Discovery URL, response mode, realm/client ID, scope, audience, `KC_DB`, credential 없는 `KC_DB_URL`, `KC_DB_SCHEMA`, gateway timeout |
| Secret | OIDC Client Secret, DB password, bootstrap/provision admin password, truststore/keystore password, private key 또는 client certificate |
| ConfigMap 또는 인증서 전용 리소스 | 공개 CA root/intermediate PEM bundle |

Kubernetes Pod에서는 Compose용 `AUTHBRIDGE_DB_PASSWORD`보다 Keycloak 공식 환경변수인 `KC_DB_PASSWORD`를 직접 `secretKeyRef`로 주입하는 편이 명확합니다. 프로비저너 Job에는 `UPSTREAM_OIDC_CLIENT_ID`, `UPSTREAM_OIDC_CLIENT_SECRET`, `KEYCLOAK_ADMIN_USERNAME`, `KEYCLOAK_ADMIN_PASSWORD`가 필요합니다.

Kubernetes Secret은 기본적으로 base64 encoding일 뿐입니다. etcd encryption at rest, RBAC 최소권한, audit, namespace 격리 또는 사내 External Secrets/Vault 연계를 별도로 적용합니다. 환경변수 대신 Secret volume을 직접 읽으려면 현재 프로비저너에 file-based secret 입력 기능을 추가해야 합니다.

### Client Secret의 DB 사본

현재 흐름은 다음과 같습니다.

```text
Kubernetes Secret
  -> provision Job environment
  -> Keycloak Admin API
  -> Keycloak IdP config in DB
```

따라서 Kubernetes Secret으로 관리하더라도 DB, backup 및 DB 접근자는 Client Secret의 보호 범위에 포함됩니다. Secret 회전 절차는 다음과 같습니다.

1. 사내 IdP에서 새 Client Secret 발급
2. Kubernetes Secret 갱신
3. provision Job 재실행
4. 실제 웹 로그인과 code 교환 확인
5. 이전 Secret 폐기

DB에 literal Client Secret을 남기지 않으려면 Keycloak file Vault와 Kubernetes Secret volume을 연동하고 IdP 설정에는 vault reference만 저장하도록 프로비저너를 확장해야 합니다. 이는 현재 Compose 구현에는 포함되지 않은 운영 하드닝 항목입니다.

bootstrap admin Secret을 바꾼다고 이미 생성된 Keycloak admin 비밀번호가 자동 회전되는 것도 아닙니다. 최초 bootstrap 이후에는 전용 최소권한 프로비저닝 자격증명과 명시적인 회전 절차를 마련합니다.

## Kubernetes 포팅 체크리스트

- [ ] Keycloak 지원 사내 DB와 전용 database/schema/user 확보
- [ ] Keycloak 및 Gateway Deployment/Service 구성
- [ ] Nginx/Ingress prefix 및 공개 경로 계약 반영
- [ ] profile ConfigMap과 credential Secret 분리
- [ ] idempotent provision Job 구성
- [ ] DB/IdP TLS CA mount와 hostname verification 적용
- [ ] Keycloak admin/management/DB NetworkPolicy 적용
- [ ] readiness/liveness probe 적용
- [ ] 실제 사내 계정의 claim과 권한 mapper 확정
- [ ] `query`와 `form_post` 중 선택한 모드로 실제 브라우저 로그인 확인
- [ ] CLI Device Flow, refresh, logout/revocation 확인
- [ ] DB backup/restore 및 Secret 회전 리허설

## 참고 문서

- [Keycloak database 구성](https://www.keycloak.org/server/db)
- [Keycloak Vault 구성](https://www.keycloak.org/server/vault)
- [Keycloak production 구성](https://www.keycloak.org/server/configuration-production)
- [Kubernetes Secret](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Kubernetes Secret 운영 권장사항](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
