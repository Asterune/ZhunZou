#!/usr/bin/env bash
# Boot the built server on a throwaway database, run the HTTP smoke test,
# then always shut it down.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-8788}"
TOKEN="smoke-token"
TMP_DIR="$(mktemp -d)"
LOG_FILE="$TMP_DIR/server.log"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "building packages..."
pnpm --filter @zhunzou/shared build >/dev/null
pnpm --filter @zhunzou/server build >/dev/null

echo "starting server on port $PORT..."
(
  cd "$ROOT/packages/server"
  NODE_ENV=test \
  PORT="$PORT" \
  HOST=127.0.0.1 \
  HUB_SECRET_TOKEN="$TOKEN" \
  DATABASE_PATH="$TMP_DIR/smoke.db" \
  GLOBAL_RULES_PATH="$ROOT/GLOBAL_RULES.md" \
  META_AGENT_ENABLED=false \
  LOG_LEVEL=warn \
  node dist/main.js >"$LOG_FILE" 2>&1
) &
SERVER_PID=$!

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited unexpectedly:"
    cat "$LOG_FILE"
    exit 1
  fi
  sleep 0.1
done

if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "server did not become ready:"
  cat "$LOG_FILE"
  exit 1
fi

HUB_URL="http://127.0.0.1:$PORT" HUB_TOKEN="$TOKEN" node "$ROOT/scripts/smoke-test.mjs"
