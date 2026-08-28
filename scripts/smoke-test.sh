#!/usr/bin/env bash
set -euo pipefail

base_url="${KEYCLOAK_URL:-http://localhost:8080}"
realm="${KEYCLOAK_REALM:-oidc-test}"
username="${KEYCLOAK_TEST_USER:-test-user}"
password="${KEYCLOAK_TEST_PASSWORD:-test-password-local-only}"
public_client="${KEYCLOAK_PUBLIC_CLIENT:-oidc-test-app}"
service_client="${KEYCLOAK_SERVICE_CLIENT:-oidc-test-service}"
service_secret="${KEYCLOAK_SERVICE_SECRET:-test-service-secret-local-only}"
issuer="${base_url}/realms/${realm}"
token_endpoint="${issuer}/protocol/openid-connect/token"

json_value() {
  local key="$1"
  python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$key"
}

echo "[1/4] OIDC discovery"
discovery=""
for _ in {1..30}; do
  if discovery="$(curl --fail --silent \
    "${issuer}/.well-known/openid-configuration" 2>/dev/null)"; then
    break
  fi
  sleep 2
done

if [[ -z "$discovery" ]]; then
  echo "Keycloak did not become ready at ${issuer}" >&2
  exit 1
fi

discovered_issuer="$(json_value issuer <<<"$discovery")"

if [[ "$discovered_issuer" != "$issuer" ]]; then
  echo "Unexpected issuer: ${discovered_issuer}" >&2
  exit 1
fi

echo "[2/4] Password grant (local smoke test only)"
password_response="$(curl --fail-with-body --silent --show-error \
  --request POST "$token_endpoint" \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=password' \
  --data-urlencode "client_id=${public_client}" \
  --data-urlencode "username=${username}" \
  --data-urlencode "password=${password}" \
  --data-urlencode 'scope=openid profile email')"
access_token="$(json_value access_token <<<"$password_response")"
id_token="$(json_value id_token <<<"$password_response")"

[[ -n "$access_token" && -n "$id_token" ]]

echo "[3/4] UserInfo"
userinfo_subject="$(curl --fail --silent --show-error \
  --header "Authorization: Bearer ${access_token}" \
  "${issuer}/protocol/openid-connect/userinfo" | json_value sub)"

[[ -n "$userinfo_subject" ]]

echo "[4/4] Client credentials"
service_access_token="$(curl --fail-with-body --silent --show-error \
  --request POST "$token_endpoint" \
  --user "${service_client}:${service_secret}" \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' | json_value access_token)"

[[ -n "$service_access_token" ]]

echo "OK: discovery, user token, ID token, UserInfo, and service token all succeeded."
