#!/usr/bin/env bash
#
# 准奏 · 本地一键部署（macOS / Linux）
#
# 用法（在项目根目录执行）：
#   bash deploy/deploy.sh
#   bash deploy/deploy.sh --domain hub.l1uqi.com --key ~/.ssh/pte_deploy
#
# 参数：
#   -s, --server <IP>       服务器公网 IP（默认 154.219.111.22）
#   -u, --user <用户>       SSH 用户（默认 root）
#   -p, --port <端口>       SSH 端口（默认 22）
#   -k, --key <私钥>        私钥路径（默认 ~/.ssh/pte_deploy，存在时自动使用）
#       --remote-dir <目录> 服务器部署目录（默认 /opt/zhunzou）
#       --domain <域名>     nginx 域名（默认 hub.l1uqi.com）
#       --app-port <端口>   Node 监听端口（默认 8899）
#       --no-nginx          不配置 nginx（仅监听 127.0.0.1，需自行反代）
#   -h, --help              显示帮助
#
set -euo pipefail

SERVER="${SERVER:-154.219.111.22}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
KEY_FILE="${KEY_FILE:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/zhunzou}"
DOMAIN="${DOMAIN:-hub.l1uqi.com}"
APP_PORT="${APP_PORT:-8899}"
INSTALL_NGINX="${INSTALL_NGINX:-1}"

log()  { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
准奏 · 本地一键部署（macOS / Linux）

用法：
  bash deploy/deploy.sh [选项]

选项：
  -s, --server <IP>       服务器公网 IP（默认 154.219.111.22）
  -u, --user <用户>       SSH 用户（默认 root）
  -p, --port <端口>       SSH 端口（默认 22）
  -k, --key <私钥>        私钥路径（默认 ~/.ssh/pte_deploy）
      --remote-dir <目录> 服务器部署目录（默认 /opt/zhunzou）
      --domain <域名>     nginx 域名（默认 hub.l1uqi.com）
      --app-port <端口>   Node 监听端口（默认 8899）
      --no-nginx          不配置 nginx
  -h, --help              显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -s|--server) SERVER="$2"; shift 2 ;;
    -u|--user) SSH_USER="$2"; shift 2 ;;
    -p|--port) SSH_PORT="$2"; shift 2 ;;
    -k|--key) KEY_FILE="$2"; shift 2 ;;
    --remote-dir) REMOTE_DIR="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --no-nginx) INSTALL_NGINX=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 -h 查看用法）" ;;
  esac
done

for tool in ssh scp tar; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少命令: $tool"
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${SSH_USER}@${SERVER}"
COMMON=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
SSH_ARGS=("${COMMON[@]}" -p "$SSH_PORT")
SCP_ARGS=("${COMMON[@]}" -P "$SSH_PORT")

if [ -z "$KEY_FILE" ] && [ -f "${HOME}/.ssh/pte_deploy" ]; then
  KEY_FILE="${HOME}/.ssh/pte_deploy"
fi
if [ -n "$KEY_FILE" ]; then
  [ -f "$KEY_FILE" ] || die "找不到私钥: ${KEY_FILE}"
  SSH_ARGS+=(-i "$KEY_FILE")
  SCP_ARGS+=(-i "$KEY_FILE")
fi

log "项目目录: ${REPO_DIR}"
BRIDGE_MANIFEST="${REPO_DIR}/release/bridge/latest.json"
if [ -f "$BRIDGE_MANIFEST" ]; then
  log "桥接发布包: $(grep -m1 '"version"' "$BRIDGE_MANIFEST" | sed 's/.*: *"\([^"]*\)".*/\1/')（/releases/bridge/，客户端可自更新）"
else
  warn "未发现 release/bridge/latest.json：客户端无法自更新，可在本地先执行 pnpm publish:bridge"
fi
log "目标服务器: ${TARGET}:${REMOTE_DIR}"
log "访问地址: http://${DOMAIN}（HTTPS 需 DNS 生效后执行 deploy/enable-https.sh）"

# ---------------------------------------------------------------- 1) 打包
TAR_PATH="$(mktemp "${TMPDIR:-/tmp}/zhunzou.XXXXXX")"
TAR_PATH="${TAR_PATH}.tar.gz"
trap 'rm -f "$TAR_PATH"' EXIT

log "打包项目（排除 node_modules / dist / .git / data / .env）..."
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TAR_PATH" \
  --exclude=node_modules \
  --exclude='**/node_modules' \
  --exclude=.git \
  --exclude=dist \
  --exclude='**/dist' \
  --exclude=data \
  --exclude=.env \
  --exclude=.env.local \
  --exclude=coverage \
  --exclude=logs \
  --exclude='*.log' \
  --exclude='._*' \
  --exclude='*.tar.gz' \
  -C "$REPO_DIR" .
log "打包完成: $(du -h "$TAR_PATH" | cut -f1)"

# ---------------------------------------------------------------- 2) 上传
log "上传中..."
scp "${SCP_ARGS[@]}" "$TAR_PATH" "${TARGET}:/root/zhunzou.tar.gz"

# ---------------------------------------------------------------- 3) 部署 + 验证
REMOTE_CMD="set -e
mkdir -p ${REMOTE_DIR}
tar --no-same-owner -xzf /root/zhunzou.tar.gz -C ${REMOTE_DIR}
cd ${REMOTE_DIR}
APP_DIR=${REMOTE_DIR} PORT=${APP_PORT} DOMAIN=${DOMAIN} INSTALL_NGINX=${INSTALL_NGINX} bash deploy/setup.sh
echo '===== HEALTH ====='
curl -s http://127.0.0.1:${APP_PORT}/healthz || true
echo
echo -n 'service: '; systemctl is-active ${SERVICE_NAME:-zhunzou} || true
echo -n 'nginx: ';   systemctl is-active nginx || true
echo '===== TOKEN ====='
grep -E '^HUB_SECRET_TOKEN=' ${REMOTE_DIR}/.env | cut -d= -f2-
echo '===== META ====='
grep -E '^META_AGENT_ENABLED=' ${REMOTE_DIR}/.env | cut -d= -f2-"

log "在服务器上安装依赖并构建（首次约 1-3 分钟）..."
ssh "${SSH_ARGS[@]}" "$TARGET" "$REMOTE_CMD"

echo
log "部署完成"
if [ "$INSTALL_NGINX" = "1" ]; then
  if curl -fsS -m 5 "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
    echo "  访问地址：https://${DOMAIN}/"
  else
    echo "  访问地址：http://${DOMAIN}/（DNS 生效后）"
    echo "  启用 HTTPS：bash deploy/enable-https.sh --domain ${DOMAIN}"
  fi
else
  warn "未启用 nginx，服务只监听 127.0.0.1:${APP_PORT}"
fi
echo "  查看日志：ssh -p ${SSH_PORT} ${TARGET} 'journalctl -u zhunzou -f'"
