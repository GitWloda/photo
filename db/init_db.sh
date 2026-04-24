#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." ; pwd)"

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

# ---------------------------------------------------------------------------
# Sistema di migration: applica tutti i file db/migrations/*.sql in ordine,
# saltando quelli già applicati tracciati nella tabella schema_migrations.
# ---------------------------------------------------------------------------
sqlite3 "$DB_FILE" "
CREATE TABLE IF NOT EXISTS schema_migrations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  filename  TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
"

MIGRATIONS_DIR="$ROOT_DIR/db/migrations"

if [ -d "$MIGRATIONS_DIR" ]; then
  while IFS= read -r migration_file; do
    filename="$(basename "$migration_file")"

    already_applied=$(sqlite3 "$DB_FILE" \
      "SELECT COUNT(*) FROM schema_migrations WHERE filename = '$filename';")

    if [ "$already_applied" -eq 0 ]; then
      echo "Applico migration: $filename"
      if sqlite3 "$DB_FILE" < "$migration_file"; then
        sqlite3 "$DB_FILE" \
          "INSERT INTO schema_migrations (filename) VALUES ('$filename');"
        echo "  -> OK: $filename"
      else
        echo "  -> ERRORE applicando $filename" >&2
        exit 1
      fi
    fi
  done < <(find "$MIGRATIONS_DIR" -name "*.sql" | sort)
fi

touch "$LOG_FILE_ABS"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] init_db: database pronto in $DB_FILE" >> "$LOG_FILE_ABS"
