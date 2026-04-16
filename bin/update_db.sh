#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." ; pwd)"

if [ ! -f "$ROOT_DIR/config/app.env" ]; then
  echo "config/app.env non trovato." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/config/app.env"

# --- Dipendenze esterne ---
if ! command -v parallel >/dev/null 2>&1; then
  echo "Errore: GNU parallel non trovato. Installalo con: sudo apt install parallel" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Errore: python3 non trovato nel PATH." >&2
  exit 1
fi

# --- Normalizza percorsi ---
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

if [[ "$PHOTO_ROOT" != /* ]]; then
  PHOTO_ROOT_ABS="$(cd "$ROOT_DIR/$PHOTO_ROOT" 2>/dev/null && pwd || true)"
else
  PHOTO_ROOT_ABS="$(cd "$PHOTO_ROOT" 2>/dev/null && pwd || true)"
fi

if [ -z "$PHOTO_ROOT_ABS" ]; then
  echo "Errore: PHOTO_ROOT non valido: $PHOTO_ROOT" >&2
  exit 1
fi

# Default AI_WORKERS se non impostato nel config
AI_WORKERS="${AI_WORKERS:-4}"

mkdir -p "$THUMB_DIR_ABS"
touch "$LOG_FILE_ABS"

log() {
  local msg="$1"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] update_db: $msg" | tee -a "$LOG_FILE_ABS" >&2
}

sql_escape() {
  sed "s/'/''/g"
}

sqlite_query() {
  sqlite3 -cmd ".timeout 15000" "$DB_FILE" "$1"
}

sqlite_batch() {
  sqlite3 -cmd ".timeout 15000" "$DB_FILE"
}

get_stat_linux() {
  local file="$1"
  stat -c '%s %Y' "$file"
}

get_stat_macos() {
  local file="$1"
  stat -f '%z %m' "$file"
}

get_size_mtime() {
  local file="$1"
  if stat -c '%s' / >/dev/null 2>&1; then
    get_stat_linux "$file"
  else
    get_stat_macos "$file"
  fi
}

generate_thumb() {
  local file="$1"
  local asset_id="$2"
  local out_file="$THUMB_DIR_ABS/${asset_id}.jpg"

  if command -v convert >/dev/null 2>&1; then
    if convert "$file" -auto-orient -thumbnail 400x400 "$out_file" >/dev/null 2>&1; then
      echo "${asset_id}.jpg"
      return 0
    fi
  fi

  echo ""
}

# ---------------------------------------------------------------------------
# process_file: gestisce insert/update di asset e asset_files nel DB.
# NON chiama più Ollama direttamente: l'elaborazione IA è delegata ai worker.
# ---------------------------------------------------------------------------
process_file() {
  local file="$1"

  local lc_file="${file,,}"
  case "$lc_file" in
    *.jpg|*.jpeg|*.png|*.gif|*.webp) ;;
    *) return 0 ;;
  esac

  if [ ! -f "$file" ]; then
    return 0
  fi

  local abs_path rel_path filename stat_out size_bytes mtime sha256 metadata_json
  abs_path="$(realpath "$file")"
  rel_path="${abs_path#$PHOTO_ROOT_ABS/}"
  filename="$(basename "$file")"

  stat_out="$(get_size_mtime "$file")"
  size_bytes="$(echo "$stat_out" | awk '{print $1}')"
  mtime="$(echo "$stat_out" | awk '{print $2}')"

  sha256="$("$ROOT_DIR/bin/hash_file.sh" "$file")"

  metadata_json="$("$ROOT_DIR/bin/extract_metadata.sh" "$file" || echo '{}')"

  # Escaping per SQL
  local ep er ef esha em
  ep=$(printf '%s' "$abs_path"      | sql_escape)
  er=$(printf '%s' "$rel_path"      | sql_escape)
  ef=$(printf '%s' "$filename"      | sql_escape)
  esha=$(printf '%s' "$sha256"      | sql_escape)
  em=$(printf '%s' "$metadata_json" | sql_escape)

  local row
  row=$(sqlite_query "SELECT id, sha256, mtime, asset_id FROM asset_files WHERE absolute_path = '$ep';")

  if [ -z "$row" ]; then
    # ----------------- NUOVO FILE -----------------
    log "Nuovo file: $abs_path"

    # 1) crea asset in transazione corta
    local asset_id
    asset_id="$({
      cat <<SQL
BEGIN IMMEDIATE;
INSERT INTO assets (title, created_at, updated_at)
VALUES ('$ef', strftime('%s','now'), strftime('%s','now'));
SELECT last_insert_rowid();
COMMIT;
SQL
    } | sqlite_batch | tail -n 1)"

    # 2) genera thumbnail fuori dal DB (può essere lenta)
    local thumb_rel ethumb
    thumb_rel="$(generate_thumb "$file" "$asset_id")"
    ethumb=$(printf '%s' "$thumb_rel" | sql_escape)

    # 3) inserisce asset_files in un'altra transazione corta
    {
      cat <<SQL
BEGIN IMMEDIATE;
INSERT INTO asset_files (
  asset_id, absolute_path, relative_path, filename, sha256,
  metadata_json, size_bytes, mtime, thumb_path, created_at, updated_at
) VALUES (
  $asset_id, '$ep', '$er', '$ef', '$esha',
  '$em', $size_bytes, $mtime, '$ethumb',
  strftime('%s','now'), strftime('%s','now')
);
COMMIT;
SQL
    } | sqlite_batch >/dev/null

    # restituisce asset_id per la coda IA
    echo "$asset_id"

  else
    # ----------------- FILE GIÀ CONOSCIUTO -----------------
    local file_id old_sha old_mtime asset_id
    file_id=$(echo "$row" | awk -F'|' '{print $1}')
    old_sha=$(echo "$row" | awk -F'|' '{print $2}')
    old_mtime=$(echo "$row" | awk -F'|' '{print $3}')
    asset_id=$(echo "$row" | awk -F'|' '{print $4}')

    if [ "$old_sha" != "$sha256" ] || [ "$old_mtime" != "$mtime" ]; then
      log "File modificato: $abs_path"

      local thumb_rel ethumb
      thumb_rel="$(generate_thumb "$file" "$asset_id")"
      ethumb=$(printf '%s' "$thumb_rel" | sql_escape)

      {
        cat <<SQL
BEGIN IMMEDIATE;
UPDATE asset_files
SET sha256='$esha',
    metadata_json='$em',
    size_bytes=$size_bytes,
    mtime=$mtime,
    thumb_path='$ethumb',
    updated_at=strftime('%s','now')
WHERE id=$file_id;

UPDATE assets
SET ai_description_id=NULL,
    updated_at=strftime('%s','now')
WHERE id=$asset_id;
COMMIT;
SQL
      } | sqlite_batch >/dev/null

      echo "$asset_id"
    fi
  fi
}

# ---------------------------------------------------------------------------
# FASE 1: scansione sequenziale (DB writes safe, nessuna chiamata Ollama)
# ---------------------------------------------------------------------------
log "Scansione libreria in $PHOTO_ROOT_ABS"

PENDING_IDS_FILE="$(mktemp)"
trap 'rm -f "$PENDING_IDS_FILE"' EXIT

while IFS= read -r f; do
  process_file "$f"
done < <(find "$PHOTO_ROOT_ABS" -type f 2>/dev/null) > "$PENDING_IDS_FILE"

log "Scansione filesystem completata."

# asset già presenti ma senza descrizione
SALVATI_SENZA_DESC=$(sqlite_query "SELECT id FROM assets WHERE ai_description_id IS NULL;")

ALL_PENDING=$(
  { cat "$PENDING_IDS_FILE"; echo "$SALVATI_SENZA_DESC"; } \
  | grep -v '^$' \
  | sort -un
)

COUNT=$(echo "$ALL_PENDING" | grep -c '[0-9]' || true)

# ---------------------------------------------------------------------------
# FASE 2: elaborazione IA parallela sui nuovi/modificati + asset senza descrizione
# ---------------------------------------------------------------------------
WORKER_SCRIPT="$ROOT_DIR/bin/worker_ai.py"

if [ "$COUNT" -eq 0 ]; then
  log "Nessun asset da elaborare con l'IA."
else
  log "Avvio $AI_WORKERS worker IA su $COUNT asset..."
  echo "$ALL_PENDING" | \
    parallel \
      --jobs "$AI_WORKERS" \
      --line-buffer \
      python3 "\"$WORKER_SCRIPT\"" {}
  log "Elaborazione IA completata ($COUNT asset processati)."
fi

log "Update DB completato."