#!/usr/bin/env bash
# Start a throwaway Asterius API server (fresh SQLite database, empty CONFIG_DIR) for the acceptance tests, create the
# admin account (admin of the default organization), mint an API token, and print the environment the tests need:
#
#   eval "$(scripts/local-server.sh start)"   # exports ASTERIUS_ENDPOINT, ASTERIUS_TOKEN, ASTERIUS_ORG, TF_ACC
#   make testacc
#   scripts/local-server.sh stop
#
# Requires `npm install` at the repository root. Port: ASTERIUS_TEST_PORT (default 18480). Data: ASTERIUS_TEST_DIR
# (default $TMPDIR/asterius-tf-acc, wiped on start). The config directory contains one managed blueprint
# (`tf-managed`) so the tests can check the diagnostic of a 409 on a resource managed by configuration.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PORT="${ASTERIUS_TEST_PORT:-18480}"
DIR="${ASTERIUS_TEST_DIR:-${TMPDIR:-/tmp}/asterius-tf-acc}"
URL="http://127.0.0.1:${PORT}"
# The default organization (it reads CONFIG_DIR itself); the account joins it as admin (AUTO_JOIN_DEFAULT_ORG).
ORG="default"
EMAIL="tf-admin@example.com"
PASSWORD="correct-horse-battery-staple"

stop() {
  if [[ -f "$DIR/server.pid" ]]; then
    # Its own process group (setsid): npx, tsx and node stop together.
    kill -- "-$(cat "$DIR/server.pid")" 2>/dev/null || true
    rm -f "$DIR/server.pid"
  fi
}

start() {
  stop
  rm -rf "$DIR"
  mkdir -p "$DIR/data" "$DIR/config"
  cat >"$DIR/config/managed.yaml" <<'YAML'
blueprints:
  - identifier: tf-managed
    title: Managed by configuration
YAML
  (
    cd "$REPO/apps/server"
    PORT="$PORT" DATABASE_URL='' DATA_DIR="$DIR/data" CONFIG_DIR="$DIR/config" PUBLIC_URL="http://localhost:${PORT}" \
      LOG_LEVEL=warn AUTH_PROVIDERS=local ALLOW_REGISTRATION=true AUTO_JOIN_DEFAULT_ORG=true \
      setsid nohup npx tsx src/index.ts >"$DIR/server.log" 2>&1 &
    echo $! >"$DIR/server.pid"
  )
  for _ in $(seq 1 120); do
    curl -fsS "$URL/healthz" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS "$URL/healthz" >/dev/null || { echo "server did not start, see $DIR/server.log" >&2; exit 1; }

  session=$(curl -fsS -H 'content-type: application/json' "$URL/api/auth/register" \
    -d "{\"email\":\"$EMAIL\",\"name\":\"Terraform\",\"password\":\"$PASSWORD\"}" | json token)
  token=$(curl -fsS -H "authorization: Bearer $session" -H "x-asterius-org: $ORG" -H 'content-type: application/json' \
    "$URL/api/v1/tokens" -d '{"name":"terraform-acc","expiresInDays":1}' | json token)

  echo "export ASTERIUS_ENDPOINT=$URL"
  echo "export ASTERIUS_TOKEN=$token"
  echo "export ASTERIUS_ORG=$ORG"
  echo "export TF_ACC=1"
}

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['$1']))"; }

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
