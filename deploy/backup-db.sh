#!/usr/bin/env bash
#
# Nightly SQLite snapshot for the Zhunzou hub.
#
# Installed as a systemd timer by deploy/setup.sh. `.backup` uses SQLite's
# online backup API, so it is safe while the hub is writing (WAL included).
# The copy is verified before the previous snapshots are pruned.
#
# Environment:
#   APP_DIR    install root (default /opt/zhunzou)
#   KEEP       snapshots to retain (default 14)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/zhunzou}"
DB="${DB:-$APP_DIR/data/zhunzou.db}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/data/backups}"
KEEP="${KEEP:-14}"

command -v sqlite3 >/dev/null 2>&1 || {
  echo "sqlite3 is not installed" >&2
  exit 1
}
[ -f "$DB" ] || {
  echo "database not found: $DB" >&2
  exit 1
}

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_DIR/zhunzou-$stamp.db"

sqlite3 "$DB" ".backup '$target'"
chmod 600 "$target"

check="$(sqlite3 "$target" 'PRAGMA quick_check;' || true)"
if [ "$check" != "ok" ]; then
  echo "backup integrity check failed: ${check:-no output}" >&2
  rm -f "$target"
  exit 1
fi

# Prune oldest snapshots, keeping the newest $KEEP. Manual snapshots with other
# names (zhunzou-before-*.db) are left alone.
{
  ls -1t "$BACKUP_DIR"/zhunzou-2*.db 2>/dev/null || true
} | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
  rm -f "$old"
done

echo "backup written: $target"
