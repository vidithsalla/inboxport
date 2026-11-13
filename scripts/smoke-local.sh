#!/usr/bin/env bash
set -euo pipefail

log_file="${TMPDIR:-/tmp}/relay-mail-smoke.log"
RELAY_APP_URL=http://127.0.0.1:3000 npm run start -- --hostname 127.0.0.1 >"$log_file" 2>&1 &
server_pid=$!
cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 40); do
  if curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null; then
    ready=true
    break
  fi
  sleep 0.5
done

if [[ "${ready:-false}" != "true" ]]; then
  printf '%s\n' "Local server did not become ready; recent log output follows:" >&2
  tail -n 40 "$log_file" >&2
  exit 1
fi

health="$(curl --fail --silent http://127.0.0.1:3000/api/health)"
accounts_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/accounts)"
page_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/)"
oauth_status="$(curl --silent --output /dev/null --write-out '%{http_code}' 'http://127.0.0.1:3000/api/oauth/google/start?return_to=/')"

node -e '
  const health = JSON.parse(process.argv[1]);
  if (health.service !== "Relay Mail" || health.gmail.credential_ready !== true) process.exit(1);
' "$health"

test "$page_status" = "200"
test "$accounts_status" = "401"
test "$oauth_status" = "401"
printf '%s\n' "Local smoke passed: health, page render, and unauthenticated API denial"
