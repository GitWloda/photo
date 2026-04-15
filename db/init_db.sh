#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

if [ ! -f "$ROOT_DIR/config/app.env" ]; then
  echo "config/app.env non trovato. Copia e modifica l'esempio prima di procedere."
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/config/app.env"

# Normalizza percorsi relativi rispetto alla root del progetto
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

if [[ "$THUMB_DIR" != /* ]]; then
  THUMB_DIR_ABS="$ROOT_DIR/$THUMB_DIR"
else
  THUMB_DIR_ABS="$THUMB_DIR"
fi

if [[ "$CACHE_DIR" != /* ]]; then
  CACHE_DIR_ABS="$ROOT_DIR/$CACHE_DIR"
else
  CACHE_DIR_ABS="$CACHE_DIR"
fi

mkdir -p "$(dirname "$DB_FILE")" \
         "$(dirname "$LOG_FILE_ABS")" \
         "$THUMB_DIR_ABS" \
         "$CACHE_DIR_ABS"

if [ ! -f "$DB_FILE" ]; then
  echo "Inizializzo database in $DB_FILE"
  sqlite3 "$DB_FILE" < "$ROOT_DIR/db/schema.sql"
else
  echo "Database già presente in $DB_FILE"
fi

# Abilita WAL per permettere accessi concorrenti da più worker
sqlite3 "$DB_FILE" "PRAGMA journal_mode=WAL;"
sqlite3 "$DB_FILE" "PRAGMA synchronous=NORMAL;"

touch "$LOG_FILE_ABS"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] init_db: database pronto in $DB_FILE" >> "$LOG_FILE_ABS"
