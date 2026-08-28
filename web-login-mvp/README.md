# Web Login MVP

Keycloak 로그인 화면으로 사용자를 리다이렉트하고, Authorization Code + PKCE로 토큰을 교환한 뒤 검증된 인증 정보를 보여주는 독립 실행형 Node.js 앱입니다.

외부 npm 패키지를 사용하지 않으므로 Node.js 20 이상만 있으면 됩니다.

## 1. Keycloak 사용자와 client 구성

상위 디렉터리에서 인증 서버가 실행 중이어야 합니다.

```bash
cd ..
make up
cd web-login-mvp
npm run setup
```

`setup`은 여러 번 실행해도 같은 사용자와 client를 갱신합니다.

- 사용자: `mvp-user`
- 비밀번호: `mvp-password-local-only`
- Realm role: `tester`
- Client ID: `oidc-mvp-web`
- Redirect URI: `http://localhost:3000/callback`
- PKCE: `S256` 필수

## 2. 웹 앱 실행

```bash
npm start
```

브라우저에서 <http://localhost:3000>을 열고 **Keycloak으로 로그인**을 누릅니다. 위 테스트 계정으로 로그인하면 다음 정보가 표시됩니다.

- 서명, issuer, audience, 만료 시각, nonce를 검증한 ID Token claims
- access token으로 조회한 UserInfo
- realm roles, scope, token 만료 시각
- JSON 인증정보 API: <http://localhost:3000/api/session>

원본 access/refresh token은 브라우저나 JSON API에 노출하지 않고 서버 메모리에만 둡니다. 앱을 재시작하면 로그인 세션도 초기화됩니다.

## 자동 E2E 테스트

웹 앱을 실행한 상태에서 다른 터미널로 실행합니다.

```bash
npm run test:e2e
```

실제 Keycloak 로그인 폼 제출, callback, PKCE code 교환, ID Token/UserInfo 확인, RP-initiated logout까지 검증합니다.

## 환경변수

기본값은 `.env.example`에 정리되어 있습니다. 이 앱은 `.env` 파일을 자동으로 읽지 않으므로 필요한 값은 shell에서 export하거나 실행 명령 앞에 지정합니다.

```bash
APP_PORT=3000 OIDC_ISSUER=http://localhost:8080/realms/oidc-test npm start
```

상위 프로젝트에서 `make reset`으로 realm DB를 초기화한 경우 `npm run setup`을 다시 실행하면 사용자와 client가 복원됩니다.
