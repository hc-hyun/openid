# AuthBridge 사내 포팅 가이드

이 문서는 AuthBridge를 사내 OIDC, Nginx/Ingress, 외부 DB 및 Kubernetes 환경에 연결할 때 확인할 계약을 정리합니다. 현재 저장소에는 Docker Compose 배포가 구현되어 있으며 Kubernetes manifest/Helm chart는 아직 포함하지 않습니다.

## 결정 요약

- OIDC 응답 방식은 `query`와 `form_post`를 모두 지원합니다.
- `form_post`에서는 현재 Gateway adapter가 필요합니다.
- `query`에서도 prefix 처리와 공개 경로 제한을 위해 Gateway를 유지하는 구성이 기본입니다.
- 사내 DB 인프라는 사용할 수 있지만 Keycloak 전용 database 또는 최소 전용 schema와 계정이 필요합니다.
- Kubernetes Secret은 배포 입력값을 전달하고 회전시키는 수단이지 Keycloak DB를 대체하지 않습니다.
- 현재 프로비저너는 사내 OIDC Client Secret을 Keycloak IdP 설정으로 저장하므로 DB에도 해당 값의 사본이 남습니다.
- REST `encrypt`/`decrypt` 형태의 사내 DKMS 연동은 현재 미구현이며, 사내 환경에서 custom Keycloak Vault SPI로 개발할 TODO로 관리합니다.

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

## Resource Server JWT Access Token 검증 계약

서비스팀에는 인증 방식을 **OAuth 2.0 Bearer Access Token 검증**이라고 안내합니다. 각 서비스는 JWT 서명, exact issuer/audience, 만료시간과 endpoint scope를 로컬 검증하고 refresh token을 받거나 인증서버에 refresh 요청하지 않습니다.

서비스별 설정 양식, 정확한 `401`/`403` 계약, JWKS key rotation, downstream 호출 경계와 인수 테스트는 독립 전달 문서인 [Resource Server 연동 가이드](resource-server-integration-guide.ko.md)를 기준으로 합니다.

현재 프로비저너는 `skills-api`와 MCP audience만 생성하므로 새 서비스의 audience와 scope는 서비스 전달 전에 AuthBridge 쪽에 별도로 프로비저닝해야 합니다. 모든 서비스 audience를 하나의 token에 계속 추가하지 않고 resource별 token 경계를 유지합니다.

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

### TODO: 사내 DKMS REST Vault 연동

> **상태: 미구현.** 이 절은 사내 포팅 단계의 설계 TODO이다. 현재 Docker image, 프로비저너와 Compose에는 DKMS client나 custom Keycloak `VaultProvider`가 포함되어 있지 않다.

현재 확인된 가정은 DKMS가 Kubernetes CSI/External Secrets provider가 아닌 REST `encrypt`/`decrypt` API를 제공한다는 것이다. 사내 API 명세와 workload 인증 방식이 확정된 후 사내 환경에서 개발·보안 검토한다.

첫 범위는 Keycloak DB에 사내 OIDC Client Secret 원문을 저장하지 않고 vault reference만 남기는 것이다.

```text
Keycloak IdP config in DB
  -> ${vault.company-oidc-client-secret-v1}
  -> Custom Keycloak VaultProvider SPI
  -> mounted encrypted payload 또는 DKMS key-id 조회
  -> DKMS REST decrypt API
  -> 복호화 값을 Keycloak JVM memory에서 사용
  -> 사내 OIDC token endpoint
```

DKMS `encrypt` API는 초기 등록과 회전을 담당하는 별도 운영 Job/CLI에서 사용하고, Keycloak Vault SPI는 런타임 복호화 전용으로 구현하는 것을 기본안으로 한다. Java provider JAR은 고정된 Keycloak 버전에 맞춰 build하고 optimized Keycloak image에 포함한다.

#### 보호 대상별 경계

| 보호 대상 | 처리 방식 |
|---|---|
| 사내 OIDC Client Secret | 이 TODO의 대상. DB에 `${vault.<logical-key>}`만 저장하고 custom Vault SPI가 DKMS로 복호화 |
| DB 접속 비밀번호 | 현재는 `secretKeyRef`로 JVM 시작 시 주입. 향후 REST DKMS를 쓰면 init container가 memory-backed 공유 파일에 쓰고 시작 launcher/config source가 JVM 시작 전 읽도록 별도 설계 |
| DB row, WAL, replica, snapshot, backup | Vault SPI 범위가 아님. DB/platform TDE, volume과 backup 암호화로 보호 |
| Realm 토큰 서명·암호화 key | 현재 생성 key는 Keycloak DB에 저장하고 DB/storage 암호화로 보호. 외부 key custody가 필요하면 별도 HSM/Key Provider 설계 검토 |
| DKMS TLS CA | 공개 trust material은 ConfigMap/인증서 리소스, mTLS private key/token은 Secret 또는 workload identity |

Keycloak table의 각 row/column을 Gateway나 프로비저너에서 직접 암·복호화하지 않는다. Keycloak schema migration, index/search, HA와 버전 업그레이드를 깨뜨릴 수 있다.

#### Kubernetes 값 분리

| 저장 위치 | 값 |
|---|---|
| ConfigMap | DKMS URL, vault alias, timeout/retry, cache TTL, 비민감 key/version metadata |
| Secret 또는 projected credential | DKMS 인증 토큰, mTLS private key, 암호화된 Client Secret payload |
| 인증서 리소스/ConfigMap | DKMS 서버 CA bundle |
| Keycloak DB | `${vault.company-oidc-client-secret-v1}` reference만 저장 |

DKMS API가 key-id로 secret을 조회하는 방식인지, 암호문 전체를 받아 복호화하는 방식인지 먼저 확인한다. 후자라면 versioned 암호문의 저장 위치와 무결성 검증 방식을 추가로 정한다. 암호문도 접근정책과 회전 이력 보호를 위해 Secret으로 취급한다.

평문 Client Secret은 ConfigMap, Pod 환경변수, DB, log, metric 또는 영구 volume에 남기지 않는다. DKMS 인증은 정적 API token보다 Kubernetes workload identity 또는 mTLS를 우선한다.

#### 장애·cache 정책

- DKMS TLS hostname과 CA를 검증하고 승인된 workload credential로만 호출한다.
- timeout, `401`/`403`, `404`, `429`, `5xx`, 비정상 응답 또는 복호화 실패 시 평문 fallback 없이 해당 신규 로그인을 실패시킨다.
- retry는 짧고 제한적으로 적용하며 authorization code 수명을 넘는 무한 재시도를 하지 않는다.
- 기본은 평문 cache를 두지 않고 token code 교환마다 DKMS에서 복호화한다. 암호문, key/version metadata만 cache할 수 있다.
- DKMS SLA/QPS 때문에 평문 cache가 필요하면 별도 보안 승인 후 JVM memory에 짧고 제한된 TTL로만 두고 heap dump를 금지한다. 이 모드에서 평문은 TTL 동안 memory에 남으며, 완전한 zeroization은 보장할 수 없다.
- DKMS 장애 시 만료된 평문을 계속 사용하는 정책은 별도 보안 승인 없이 허용하지 않는다.
- Client Secret, 암호문, DKMS 응답 body와 인증 header를 log, trace 또는 오류 응답에 출력하지 않는다.
- 복호화 값은 최소한 token code 교환 중 Keycloak JVM memory에 존재하며, 승인된 평문 cache를 쓰면 해당 TTL 동안 더 오래 존재한다.

#### Secret 회전 기본안

1. 사내 IdP에서 새 Client Secret을 발급한다.
2. 별도 운영 Job/CLI가 DKMS `encrypt` API로 새 암호문과 key/version 정보를 생성한다.
3. Kubernetes Secret을 원자적으로 갱신한다.
4. Vault provider cache를 무효화하거나 TTL 만료를 기다린다.
5. 실제 웹 로그인과 authorization code 교환을 확인한다.
6. 정해진 rollback 기간 후 이전 Secret과 DKMS key version을 폐기한다.

전환 전 DB/WAL/snapshot/backup에 남은 과거 평문은 vault reference로 바꾼다고 소급해 사라지지 않는다. 전환 시 새 Client Secret으로 회전해 이전 값을 무효화하고, 과거 artifact는 DB/platform 암호화·접근통제·보존기간 만료 절차로 관리한다.

#### 수용 테스트

- [ ] 전환 후 현재 IdP 설정, 신규 logical dump, realm export와 Pod 환경변수에 현재 평문 Client Secret이 없음
- [ ] 전환 전·후 physical DB/WAL/snapshot/backup의 이전 Secret은 무효화되었고 암호화·접근통제·보존기간 정책으로 관리됨
- [ ] DKMS 복호화 후 `query`/`form_post` broker 로그인과 code 교환 성공
- [ ] DKMS timeout/4xx/5xx/비정상 응답 시 평문 fallback 없이 fail-closed
- [ ] DKMS 인증정보, 평문, 암호문과 응답 body가 log/trace에 노출되지 않음
- [ ] Secret 회전 후 문서화된 rollout 절차로 새 값 적용
- [ ] 이전 버전 rollback과 폐기 절차 검증
- [ ] 다중 Keycloak replica에서 cache·회전 동작 검증
- [ ] 부하 상황에서 DKMS rate limit, retry와 장애 전파 범위 확인

#### 개발 전 확정 항목

- `encrypt`/`decrypt` 요청·응답 형식과 key-id/version model
- workload 인증 방식: mTLS, service token 또는 Kubernetes identity
- CA chain, endpoint HA, SLA, timeout과 rate limit
- 암호문 저장 위치와 무결성 검증 방식
- key rotation, 이전 버전 허용 기간과 폐기 API
- audit event와 민감정보 masking 규칙
- DKMS 장애 시 cache 사용 허용 여부와 최대 TTL

bootstrap admin Secret을 바꾼다고 이미 생성된 Keycloak admin 비밀번호가 자동 회전되는 것도 아닙니다. 최초 bootstrap 이후에는 전용 최소권한 프로비저닝 자격증명과 명시적인 회전 절차를 마련합니다.

## Kubernetes 포팅 체크리스트

- [ ] Keycloak 지원 사내 DB와 전용 database/schema/user 확보
- [ ] Keycloak 및 Gateway Deployment/Service 구성
- [ ] Nginx/Ingress prefix 및 공개 경로 계약 반영
- [ ] profile ConfigMap과 credential Secret 분리
- [ ] 사내 DKMS REST Vault SPI 구현·보안 검토 및 Client Secret 평문 DB 제거
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
- [Keycloak custom Vault SPI](https://www.keycloak.org/docs/latest/server_development/index.html#_vault_spi)
- [Keycloak provider 구성](https://www.keycloak.org/server/configuration-provider)
- [Keycloak production 구성](https://www.keycloak.org/server/configuration-production)
- [Kubernetes Secret](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Kubernetes Secret 운영 권장사항](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
