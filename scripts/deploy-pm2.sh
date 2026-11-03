#!/usr/bin/env bash
# Build and (re)start 准奏 under PM2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not found. Install it first: npm i -g pm2"
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "warning: .env not found; set HUB_SECRET_TOKEN before exposing the service." >&2
fi

echo "installing dependencies..."
pnpm install --frozen-lockfile

echo "building shared / server / bridge / web..."
pnpm build

mkdir -p logs

if pm2 describe zhunzou >/dev/null 2>&1; then
  echo "reloading zhunzou..."
  pm2 reload ecosystem.config.cjs --update-env
else
  echo "starting zhunzou..."
  pm2 start ecosystem.config.cjs
fi

pm2 save
echo
echo "dashboard: http://127.0.0.1:8787  (put a reverse proxy in front for HTTPS)"
echo "logs:      pm2 logs zhunzou"
