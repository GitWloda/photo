#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# migrate_add_media_kind.sh
# Aggiunge la colonna media_kind alla tabella assets se non esiste gia'.
# Sicuro da eseguire piu' volte (idempotente).
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." ; pwd)"

source "$ROOT_DIR/config/app.env"

if [[ "$DB_PATH" != /* ]]; then
  DB_FILE="$ROOT_DIR/$DB_PATH"
else
  DB_FILE="$DB_PATH"
fi

echo "DB: $DB_FILE"

HAS_COL=$(sqlite3 "$DB_FILE" "PRAGMA table_info(assets);" | awk -F'|' '{print $2}' | grep -c '^media_kind$' || true)

if [ "$HAS_COL" -eq 0 ]; then
  echo "Aggiunta colonna media_kind ad assets..."
  sqlite3 "$DB_FILE" "ALTER TABLE assets ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'image';"
  echo "Migrazione completata."
else
  echo "Colonna media_kind gia' presente, nessuna modifica necessaria."
fi
