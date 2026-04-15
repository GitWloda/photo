#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

if [ ! -f "$ROOT_DIR/config/app.env" ]; then
  echo "config/app.env non trovato." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/config/app.env"

if [[ "$DB_PATH" != /* ]]; then
  DB_FILE="$ROOT_DIR/$DB_PATH"
else
  DB_FILE="$DB_PATH"
fi

if [[ "$LOG_FILE" != /* ]]; then
  LOG_FILE_ABS="$ROOT_DIR/$LOG_FILE"
else
  LOG_FILE_ABS="$LOG_FILE"
fi

mkdir -p "$(dirname "$LOG_FILE_ABS")"
touch "$LOG_FILE_ABS"

log() {
  local msg="$1"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] cleanup_deleted: $msg" | tee -a "$LOG_FILE_ABS" >&2
}

log "Pulizia file mancanti..."

# 1) Cancella le righe in asset_files per cui il file sul disco non esiste più
sqlite3 -separator '|' "$DB_FILE" "SELECT id, asset_id, absolute_path FROM asset_files;" | \
while IFS='|' read -r file_id asset_id abs_path; do
  if [ ! -f "$abs_path" ]; then
    log "Rimuovo asset_files id=$file_id (file mancante: $abs_path)"
    sqlite3 "$DB_FILE" "DELETE FROM asset_files WHERE id = $file_id;"
  fi
done

# 2) Cancella asset senza più file collegati (opzionale ma pulito)
log "Pulizia asset senza file collegati..."
sqlite3 "$DB_FILE" "
DELETE FROM assets
 WHERE id IN (
   SELECT a.id
   FROM assets a
   LEFT JOIN asset_files f ON f.asset_id = a.id
   WHERE f.id IS NULL
 );
"

log "Pulizia completata."