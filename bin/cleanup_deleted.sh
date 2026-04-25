#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." ; pwd)"

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
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] cleanup_deleted: $1" | tee -a "$LOG_FILE_ABS" >&2
}

log "Pulizia file mancanti dal filesystem..."

# 1) Raccoglie in batch tutti gli id da eliminare (un solo DELETE invece di N)
MISSING_IDS=""
while IFS='|' read -r file_id asset_id abs_path; do
  if [ ! -f "$abs_path" ]; then
    log "File mancante: id=$file_id asset_id=$asset_id path=$abs_path"
    if [ -z "$MISSING_IDS" ]; then
      MISSING_IDS="$file_id"
    else
      MISSING_IDS="$MISSING_IDS,$file_id"
    fi
  fi
done < <(sqlite3 -separator '|' "$DB_FILE" \
  "SELECT id, asset_id, absolute_path FROM asset_files;")

if [ -n "$MISSING_IDS" ]; then
  log "Rimuovo ${MISSING_IDS} da asset_files (batch)..."
  sqlite3 "$DB_FILE" "DELETE FROM asset_files WHERE id IN ($MISSING_IDS);"
else
  log "Nessun file mancante trovato."
fi

# 2) Cancella asset senza file collegati (orfani)
ORPHAN_COUNT=$(sqlite3 "$DB_FILE" "
SELECT COUNT(*) FROM assets a
LEFT JOIN asset_files f ON f.asset_id = a.id
WHERE f.id IS NULL;
")

if [ "$ORPHAN_COUNT" -gt 0 ]; then
  log "Rimuovo $ORPHAN_COUNT asset orfani (senza asset_files)..."
  sqlite3 "$DB_FILE" "
  DELETE FROM ai_descriptions
  WHERE asset_id IN (
    SELECT a.id FROM assets a
    LEFT JOIN asset_files f ON f.asset_id = a.id
    WHERE f.id IS NULL
  );
  DELETE FROM assets
  WHERE id IN (
    SELECT a.id FROM assets a
    LEFT JOIN asset_files f ON f.asset_id = a.id
    WHERE f.id IS NULL
  );
  "
else
  log "Nessun asset orfano trovato."
fi

log "Pulizia completata."