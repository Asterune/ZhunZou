#!/usr/bin/env bash
#
# 准奏 · 服务器端部署脚本（Ubuntu / Debian）
#
# 通常由 deploy/deploy.sh 远程调用，也可以登录服务器后手动执行：
#   sudo APP_DIR=/opt/zhunzou DOMAIN=hub.l1uqi.com bash deploy/setup.sh
#
# 可选环境变量：
#   APP_DIR=/opt/zhunzou        部署目录
#   PORT=8899                     Node 监听端口
#   BIND_HOST=127.0.0.1           监听地址（有 nginx 时只监听回环）
#   RUN_USER=agenthub             运行服务的系统用户
#   DOMAIN=hub.l1uqi.com          nginx server_name
#   INSTALL_NGINX=1               首次写入 nginx 反向代理配置
#   PNPM_VERSION=9.15.4           pnpm 版本（与 package.json 保持一致）
#   PTE_ENV_FILE=/opt/pte-dojo/server/.env  复用其中的 AI_* 配置
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

APP_DIR="${APP_DIR:-$REPO_DIR}"
PORT="${PORT:-8899}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"
RUN_USER="${RUN_USER:-agenthub}"
DOMAIN="${DOMAIN:-hub.l1uqi.com}"
INSTALL_NGINX="${INSTALL_NGINX:-1}"
PNPM_VERSION="${PNPM_VERSION:-9.15.4}"
PTE_ENV_FILE="${PTE_ENV_FILE:-/opt/pte-dojo/server/.env}"

SERVICE_NAME="zhunzou"
log()  { printf '\033[1;36m[zhunzou]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# Friendly page for the seconds node restarts during a deploy. Safe to call on
# every run: it only inserts one include the first time and never touches
# certbot's 443 settings.
install_maintenance_page() {
  local conf="/etc/nginx/conf.d/${SERVICE_NAME}.conf"
  local snippet="/etc/nginx/snippets/zhunzou-maintenance.conf"
  [ -f "$conf" ] || return 0
  [ -f "${APP_DIR}/deploy/nginx-maintenance.conf" ] || return 0

  mkdir -p /etc/nginx/snippets
  sed -e "s#__APP_DIR__#${APP_DIR}#g" \
      "${APP_DIR}/deploy/nginx-maintenance.conf" > "$snippet"

  if grep -q 'zhunzou-maintenance.conf' "$conf"; then
    return 0
  fi

  local tmp
  tmp="$(mktemp)"
  awk -v inc="        include ${snippet};" '
    { print }
    /^[[:space:]]*server[[:space:]]*\{[[:space:]]*$/ { print inc }
  ' "$conf" > "$tmp"
  mv "$tmp" "$conf"
  log "已启用更新维护页（502 → 自动重试）"
}

[ "$(id -u)" -eq 0 ] || die "请使用 root 或 sudo 运行本脚本"

APT_GET=(apt-get -o DPkg::Lock::Timeout=300)

# ---------------------------------------------------------------- Node.js / pnpm
if ! command -v node >/dev/null 2>&1; then
  log "安装 Node.js 22.x ..."
  export DEBIAN_FRONTEND=noninteractive
  "${APT_GET[@]}" update -y
  "${APT_GET[@]}" install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  "${APT_GET[@]}" install -y nodejs
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "需要 Node.js >= 20，当前 $(node -v)"
log "Node.js $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  log "启用 pnpm ${PNPM_VERSION} ..."
  corepack enable
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
fi
log "pnpm $(pnpm --version)"

# ---------------------------------------------------------------- 运行用户
if ! id "$RUN_USER" >/dev/null 2>&1; then
  log "创建系统用户 ${RUN_USER} ..."
  useradd --system --create-home --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
    || useradd --system --create-home --shell /sbin/nologin "$RUN_USER"
fi

# ---------------------------------------------------------------- 依赖 + 构建
cd "$APP_DIR"

log "安装依赖（目录：${APP_DIR}）..."
if ! pnpm install --frozen-lockfile; then
  warn "依赖安装失败，尝试安装编译工具后重试（better-sqlite3 可能需要本地编译）..."
  export DEBIAN_FRONTEND=noninteractive
  "${APT_GET[@]}" update -y
  "${APT_GET[@]}" install -y python3 make g++
  pnpm install --frozen-lockfile
fi

log "构建 shared / server / bridge / web ..."
WEB_DIR="${APP_DIR}/packages/web"
WEB_STAGE="${WEB_DIR}/dist.next"
rm -rf "$WEB_STAGE"
# Build next to the live directory, then swap. Building straight into dist/
# empties it first, so an open dashboard (or a reload during the deploy) would
# hit missing hashed assets until the new build finishes.
ZHUNZOU_WEB_OUT_DIR=dist.next pnpm build

log "原子切换 Web 静态资源（保留上一版 hashed chunk，避免旧页面 404）..."
mkdir -p "${WEB_STAGE}/assets"
if [ -d "${WEB_DIR}/dist/assets" ]; then
  cp -a -n "${WEB_DIR}/dist/assets/." "${WEB_STAGE}/assets/" 2>/dev/null || true
fi
# Chunks are only referenced by pages from the last month at most; the update
# prompt moves everyone to the newest index.html long before this.
find "${WEB_STAGE}/assets" -type f -mtime +30 -delete 2>/dev/null || true
rm -rf "${WEB_DIR}/dist.old"
if [ -d "${WEB_DIR}/dist" ]; then
  mv "${WEB_DIR}/dist" "${WEB_DIR}/dist.old"
fi
mv "$WEB_STAGE" "${WEB_DIR}/dist"

# ---------------------------------------------------------------- 运行时配置
mkdir -p "${APP_DIR}/data"

ENV_FILE="${APP_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  log ".env 已存在，保留现有配置（不会覆盖 Token 与 AI Key）"
  TOKEN="$(grep -E '^HUB_SECRET_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
else
  log "生成 .env ..."
  TOKEN="$(openssl rand -hex 32)"

  AI_KEY="${OPENAI_API_KEY:-}"
  AI_BASE="${OPENAI_BASE_URL:-}"
  AI_MODEL="${META_AGENT_MODEL:-}"
  if [ -f "$PTE_ENV_FILE" ]; then
    [ -n "$AI_KEY" ] || AI_KEY="$(grep -E '^AI_API_KEY=' "$PTE_ENV_FILE" | head -1 | cut -d= -f2- || true)"
    [ -n "$AI_BASE" ] || AI_BASE="$(grep -E '^AI_BASE_URL=' "$PTE_ENV_FILE" | head -1 | cut -d= -f2- || true)"
    [ -n "$AI_MODEL" ] || AI_MODEL="$(grep -E '^AI_MODEL=' "$PTE_ENV_FILE" | head -1 | cut -d= -f2- || true)"
  fi

  META_ENABLED=false
  [ -n "$AI_KEY" ] && META_ENABLED=true

  cat > "$ENV_FILE" <<EOF
# 准奏 生产配置（由 deploy/setup.sh 生成）
NODE_ENV=production
PORT=${PORT}
HOST=${BIND_HOST}
HUB_SECRET_TOKEN=${TOKEN}

# SQLite 与规则文件（持久化目录，升级代码不会覆盖）
DATABASE_PATH=${APP_DIR}/data/zhunzou.db
GLOBAL_RULES_PATH=${APP_DIR}/data/GLOBAL_RULES.md

# Web 看板（同端口托管）
SERVE_WEB=true
WEB_DIST_PATH=${APP_DIR}/packages/web/dist

# 长轮询
WAIT_TIMEOUT_MS=40000

# 通知里的签名审批链接（HTTPS 生效后即可直接点开）
PUBLIC_BASE_URL=https://${DOMAIN}
APPROVAL_LINK_TTL_MS=1800000

# 日志
LOG_LEVEL=info

# Meta-Agent 预审（OpenAI 兼容；也支持 META_AGENT_PROVIDER=http/none）
META_AGENT_PROVIDER=openai
META_AGENT_ENABLED=${META_ENABLED}
OPENAI_API_KEY=${AI_KEY}
OPENAI_BASE_URL=${AI_BASE:-https://api.deepseek.com/v1}
META_AGENT_MODEL=${AI_MODEL:-deepseek-chat}
EOF
  chmod 600 "$ENV_FILE"
fi

# 老部署升级：补上签名审批链接的公开地址
if ! grep -q '^PUBLIC_BASE_URL=' "$ENV_FILE"; then
  printf '\n# 通知里的签名审批链接\nPUBLIC_BASE_URL=https://%s\n' "$DOMAIN" >> "$ENV_FILE"
  log "补充 PUBLIC_BASE_URL=https://${DOMAIN}"
fi

# 规则文件是线上可编辑的数据：仅首次从仓库模板复制
if [ ! -f "${APP_DIR}/data/GLOBAL_RULES.md" ]; then
  cp "${APP_DIR}/GLOBAL_RULES.md" "${APP_DIR}/data/GLOBAL_RULES.md"
  log "初始化 data/GLOBAL_RULES.md"
fi

chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}/data"
chmod 750 "${APP_DIR}/data"

# ---------------------------------------------------------------- systemd
NODE_BIN="$(command -v node)"
UNIT_SRC="${APP_DIR}/deploy/${SERVICE_NAME}.service"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"

[ -f "$UNIT_SRC" ] || die "缺少 ${UNIT_SRC}"

log "安装 systemd 服务 ${SERVICE_NAME} ..."
sed -e "s#/opt/zhunzou#${APP_DIR}#g" \
    -e "s#/usr/bin/node#${NODE_BIN}#g" \
    -e "s#^User=.*#User=${RUN_USER}#" \
    -e "s#^Group=.*#Group=${RUN_USER}#" \
    "$UNIT_SRC" > "$UNIT_DST"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null

# Put the maintenance page in front of the existing nginx *before* the bounce,
# so even this rollout never shows a raw 502. Fresh installs are handled in the
# nginx section below, after the config exists.
if [ "$INSTALL_NGINX" = "1" ] && command -v nginx >/dev/null 2>&1; then
  install_maintenance_page
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx || warn "nginx 重载失败，将在重启后重试"
  else
    warn "维护页配置未通过 nginx -t，继续部署并稍后重试"
  fi
fi

systemctl restart "$SERVICE_NAME"

# ---------------------------------------------------------------- 健康检查
ok=0
health=''
for _ in $(seq 1 40); do
  if health="$(curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null)"; then
    ok=1
    break
  fi
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    break
  fi
  sleep 0.5
done

if [ "$ok" -ne 1 ]; then
  journalctl -u "$SERVICE_NAME" -n 60 --no-pager || true
  die "健康检查失败：http://127.0.0.1:${PORT}/healthz"
fi
# The running build's version and start time: proof this rollout took effect.
log "健康检查通过：http://127.0.0.1:${PORT}/healthz ${health}"

# ---------------------------------------------------------------- nginx
if [ "$INSTALL_NGINX" = "1" ]; then
  if ! command -v nginx >/dev/null 2>&1; then
    log "安装 nginx ..."
    export DEBIAN_FRONTEND=noninteractive
    "${APT_GET[@]}" update -y
    "${APT_GET[@]}" install -y nginx
  fi

  NGINX_CONF="/etc/nginx/conf.d/${SERVICE_NAME}.conf"

  # 首次才写；certbot 之后会改写该文件（增加 443 / 跳转），不能覆盖
  if [ ! -f "$NGINX_CONF" ]; then
    log "写入 nginx 反向代理：${DOMAIN} -> 127.0.0.1:${PORT}"
    sed -e "s#__DOMAIN__#${DOMAIN}#g" \
        -e "s#__PORT__#${PORT}#g" \
        "${APP_DIR}/deploy/nginx.conf" > "$NGINX_CONF"
  else
    log "nginx 配置已存在，保留：${NGINX_CONF}"
  fi

  # Certbot rewrites this file, so setup.sh cannot replace it wholesale.
  # Add the WebSocket upgrade headers and their map in place when missing.
  if ! grep -q 'proxy_set_header Upgrade' "$NGINX_CONF"; then
    if grep -q 'proxy_http_version 1.1;' "$NGINX_CONF"; then
      sed -i '/proxy_http_version 1.1;/a\        proxy_set_header Upgrade $http_upgrade;' "$NGINX_CONF"
      sed -i '/proxy_set_header Upgrade $http_upgrade;/a\        proxy_set_header Connection $zhunzou_connection_upgrade;' "$NGINX_CONF"
      log "已补充 WebSocket Upgrade 头"
    else
      warn "nginx 配置缺少 proxy_http_version 1.1，请手工添加 WebSocket Upgrade 头"
    fi
  fi

  if ! grep -q 'map $http_upgrade $zhunzou_connection_upgrade' "$NGINX_CONF"; then
    NGINX_TMP="$(mktemp)"
    {
      printf '%s\n' 'map $http_upgrade $zhunzou_connection_upgrade {' '    default upgrade;' "    '' close;" '}' ''
      cat "$NGINX_CONF"
    } > "$NGINX_TMP"
    mv "$NGINX_TMP" "$NGINX_CONF"
    log "已补充 WebSocket upgrade map"
  fi

  # First installs only: the pre-restart hook above covers upgrades.
  install_maintenance_page

  if nginx -t; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload nginx
    log "nginx 已重载"
  else
    die "nginx 配置检查失败，请修复 ${NGINX_CONF}"
  fi
fi

# ---------------------------------------------------------------- 完成
META_STATE="$(grep -E '^META_AGENT_ENABLED=' "$ENV_FILE" | head -1 | cut -d= -f2- || echo false)"

log "部署完成"
echo
echo "  本地健康检查： curl http://127.0.0.1:${PORT}/healthz"
echo "  服务状态：     systemctl status ${SERVICE_NAME}"
echo "  查看日志：     journalctl -u ${SERVICE_NAME} -f"
echo "  数据库：       ${APP_DIR}/data/zhunzou.db"
echo "  规则文件：     ${APP_DIR}/data/GLOBAL_RULES.md"
echo "  Meta-Agent：   ${META_STATE}"
if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  echo "  访问地址：     https://${DOMAIN}/"
else
  echo "  待办：         DNS 生效后执行 deploy/enable-https.sh 申请证书"
fi
echo
warn "请确认云服务器安全组已放行 80 / 443（本项目走 nginx，无需单独开放 ${PORT}）"
