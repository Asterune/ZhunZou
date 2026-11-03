#!/usr/bin/env bash
#
# 准奏 · 为已部署站点申请 Let's Encrypt 证书并启用 HTTPS
#
# 前置条件：DNS 已将域名解析到服务器 IP，且 80 端口可从公网访问。
#
# 用法：
#   bash deploy/enable-https.sh
#   bash deploy/enable-https.sh --domain hub.l1uqi.com
#
set -euo pipefail

SERVER="${SERVER:-154.219.111.22}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
KEY_FILE="${KEY_FILE:-}"
DOMAIN="${DOMAIN:-hub.l1uqi.com}"
FORCE=0

log()  { printf '\033[1;36m[https]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
准奏 · 启用 HTTPS

用法：
  bash deploy/enable-https.sh [选项]

选项：
  -s, --server <IP>    服务器公网 IP（默认 154.219.111.22）
  -u, --user <用户>    SSH 用户（默认 root）
  -p, --port <端口>    SSH 端口（默认 22）
  -k, --key <私钥>     私钥路径（默认 ~/.ssh/pte_deploy）
      --domain <域名>  证书域名（默认 hub.l1uqi.com）
      --force          DNS 未生效时也继续
  -h, --help           显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -s|--server) SERVER="$2"; shift 2 ;;
    -u|--user) SSH_USER="$2"; shift 2 ;;
    -p|--port) SSH_PORT="$2"; shift 2 ;;
    -k|--key) KEY_FILE="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 -h 查看用法）" ;;
  esac
done

TARGET="${SSH_USER}@${SERVER}"
COMMON=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
SSH_ARGS=("${COMMON[@]}" -p "$SSH_PORT")

if [ -z "$KEY_FILE" ] && [ -f "${HOME}/.ssh/pte_deploy" ]; then
  KEY_FILE="${HOME}/.ssh/pte_deploy"
fi
if [ -n "$KEY_FILE" ]; then
  [ -f "$KEY_FILE" ] || die "找不到私钥: ${KEY_FILE}"
  SSH_ARGS+=(-i "$KEY_FILE")
fi

# ---------------------------------------------------------------- DNS 检查
resolved="$(dig +short "$DOMAIN" A 2>/dev/null | tail -1 || true)"
if [ "$resolved" != "$SERVER" ]; then
  if [ "$FORCE" -ne 1 ]; then
    die "DNS 未指向本机：${DOMAIN} -> '${resolved:-空}'（期望 ${SERVER}）。
请先在域名控制台添加 A 记录：${DOMAIN} -> ${SERVER}，生效后重跑；或加 --force 跳过检查。"
  fi
  warn "DNS 当前为 '${resolved:-空}'，继续（--force）..."
fi

log "在服务器上申请证书：${DOMAIN}"
ssh "${SSH_ARGS[@]}" "$TARGET" "set -e
if ! command -v certbot >/dev/null 2>&1; then
  apt-get -o DPkg::Lock::Timeout=300 update -y
  apt-get -o DPkg::Lock::Timeout=300 install -y certbot
fi
if ! certbot plugins --text 2>/dev/null | grep -q nginx; then
  apt-get -o DPkg::Lock::Timeout=300 update -y
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y python3-certbot-nginx
fi
certbot --nginx -d ${DOMAIN} --redirect --non-interactive --agree-tos
echo '===== NGINX TEST ====='
nginx -t
systemctl reload nginx
echo '===== LOCAL HTTPS ====='
curl -fsS --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/healthz
echo
echo '===== CERT ====='
certbot certificates | sed -n '/${DOMAIN}/,+4p' || true"

echo
log "HTTPS 已启用：https://${DOMAIN}/"
echo "  续期检查：ssh -p ${SSH_PORT} ${TARGET} 'certbot renew --dry-run'"
