#!/usr/bin/env bash
# Verify the built Vue dashboard is served correctly from the Fastify server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WEB_SMOKE_PORT:-8790}"
TOKEN="web-smoke-token"
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
pnpm --filter @zhunzou/web build >/dev/null

if [[ ! -f "$ROOT/packages/web/dist/index.html" ]]; then
  echo "web build missing at packages/web/dist/index.html"
  exit 1
fi

echo "starting server on port $PORT..."
if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "port $PORT already serves a hub; set WEB_SMOKE_PORT to a free port"
  exit 1
fi

(
  cd "$ROOT/packages/server"
  NODE_ENV=test \
  PORT="$PORT" \
  HOST=127.0.0.1 \
  HUB_SECRET_TOKEN="$TOKEN" \
  DATABASE_PATH="$TMP_DIR/web-smoke.db" \
  GLOBAL_RULES_PATH="$ROOT/GLOBAL_RULES.md" \
  META_AGENT_ENABLED=false \
  SERVE_WEB=true \
  LOG_LEVEL=warn \
  exec node dist/main.js >"$LOG_FILE" 2>&1
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

# A stale server on the same port would answer /healthz and silently make the
# checks below pass against the wrong build.
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "port $PORT is already in use by another process (set WEB_SMOKE_PORT)"
  cat "$LOG_FILE"
  exit 1
fi

BASE="http://127.0.0.1:$PORT"

echo "checking dashboard shell..."
INDEX="$(curl -fsS "$BASE/")"
grep -q '准奏' <<<"$INDEX"
grep -q 'id="app"' <<<"$INDEX"
echo "  ok - / serves the dashboard"

ASSET="$(grep -o '/assets/[^"]*\.js' <<<"$INDEX" | head -1)"
if [[ -z "$ASSET" ]]; then
  echo "could not find a hashed JS asset in index.html"
  exit 1
fi
curl -fsS "$BASE$ASSET" >/dev/null
echo "  ok - hashed asset $ASSET served"

curl -fsS "$BASE/tickets/104" | grep -q 'id="app"'
echo "  ok - SPA fallback works"

echo "checking PWA assets..."
curl -fsS "$BASE/manifest.webmanifest" | grep -q '"start_url": "/"'
curl -fsSI "$BASE/manifest.webmanifest" | grep -qi 'cache-control: no-cache'
curl -fsSI "$BASE/sw.js" | grep -qi 'cache-control: no-cache'
curl -fsS "$BASE/offline.html" | grep -qi 'offline'
curl -fsS "$BASE/icons/icon-192.png" >/dev/null
echo "  ok - manifest, service worker, offline page and icons served"

curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/status" | grep -q '"envs"'
echo "  ok - API still served on the same port"

if curl -fsS -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$BASE/api/tickets" \
  -d '{
    "env": "smoke-web",
    "projectName": "web-smoke",
    "doneSummary": "验证看板单端口部署",
    "blockerQuestion": "页面与 API 是否同源？",
    "nextStepPlan": "通过则完成 M4",
    "options": [{"key":"A","label":"同源"},{"key":"B","label":"不同源"}],
    "recommendedOption": "A"
  }' | grep -q '"ticket"'; then
  echo "  ok - ticket creation works without CORS"
else
  echo "ticket creation failed (did you pass the bearer token?)"
  exit 1
fi

echo
echo "WEB SMOKE TEST PASSED"
