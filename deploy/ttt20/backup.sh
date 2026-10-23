#!/bin/bash
set -euo pipefail

# Consistent SQLite backup while the Node server keeps processing moves.
# Backups contain session tokens and must remain root-readable only.
VOLUME_NAME="ttt20_ttt20_room_data"
DB_ROOT="$(/usr/bin/docker volume inspect --format '{{.Mountpoint}}' "$VOLUME_NAME")"
DB_PATH="$DB_ROOT/rooms.sqlite"
BACKUP_DIR="/opt/peerivo/backups/ttt20"
test -f "$DB_PATH" || exit 0
/usr/bin/install -d -m 0700 "$BACKUP_DIR"
stamp="$(/usr/bin/date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/rooms-$stamp.sqlite"
tmp="$target.tmp"
trap 'rm -f "$tmp"' EXIT
/usr/bin/sqlite3 "$DB_PATH" ".backup '$tmp'"
/usr/bin/chmod 0600 "$tmp"
test "$(/usr/bin/sqlite3 "$tmp" 'PRAGMA quick_check;')" = "ok"
/usr/bin/mv "$tmp" "$target"
/usr/bin/find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rooms-*.sqlite' -mtime +14 -delete
echo "SQLite game rooms backup verified: $target"
