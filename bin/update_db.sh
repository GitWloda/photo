#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." ; pwd)"

if [ ! -f "$ROOT_DIR/config/app.env" ]; then
  echo "config/app.env non trovato." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/config/app.env"

# --- ANSI colors ---
C_GREEN="\033[32m"
C_WHITE="\033[97m"
C_YELLOW="\033[33m"
C_RED="\033[31m"
C_RESET="\033[0m"

_ts() { date '+%Y-%m-%d %H:%M:%S'; }

log_run()  { echo -e "${C_WHITE}[$(_ts)] [RUN]  $*${C_RESET}" >&2; echo "[$(_ts)] [RUN]  $*" >> "$LOG_FILE_ABS"; }
log_ok()   { echo -e "${C_GREEN}[$(_ts)] [OK]   $*${C_RESET}" >&2; echo "[$(_ts)] [OK]   $*" >> "$LOG_FILE_ABS"; }
log_warn() { echo -e "${C_YELLOW}[$(_ts)] [WARN] $*${C_RESET}" >&2; echo "[$(_ts)] [WARN] $*" >> "$LOG_FILE_ABS"; }
log_err()  { echo -e "${C_RED}[$(_ts)] [ERR]  $*${C_RESET}" >&2; echo "[$(_ts)] [ERR]  $*" >> "$LOG_FILE_ABS"; }

log() { log_run "update_db: $*"; }

# --- Dipendenze esterne ---
if ! command -v parallel >/dev/null 2>&1; then
  log_err "GNU parallel non trovato. Installalo con: sudo apt install parallel"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  log_err "python3 non trovato nel PATH."
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
  log_err "PHOTO_ROOT non valido: $PHOTO_ROOT"
  exit 1
fi

AI_WORKERS="${AI_WORKERS:-4}"

mkdir -p "$THUMB_DIR_ABS"
touch "$LOG_FILE_ABS"

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

# ---------------------------------------------------------------------------
# generate_thumb: immagini con convert, video con ffmpeg (frame al secondo 5)
# Timeout 30s su entrambi per evitare blocchi su file corrotti/grandi.
# ---------------------------------------------------------------------------
generate_thumb() {
  local file="$1"
  local asset_id="$2"
  local lc_file="${file,,}"
  local out_file="$THUMB_DIR_ABS/${asset_id}.jpg"

  case "$lc_file" in
    *.mp4|*.mov|*.avi|*.mkv|*.webm)
      # Usa ffmpeg: estrae frame al 5° secondo (o al primo se il video è più corto)
      if command -v ffmpeg >/dev/null 2>&1; then
        if timeout 30 ffmpeg -y \
            -ss 00:00:05 \
            -i "$file" \
            -vframes 1 \
            -vf "scale=400:400:force_original_aspect_ratio=decrease" \
            "$out_file" \
            </dev/null >/dev/null 2>&1; then
          echo "${asset_id}.jpg"
          return 0
        fi
        # Fallback: prende il primo frame se ss=5 fallisce (video < 5s)
        if timeout 30 ffmpeg -y \
            -i "$file" \
            -vframes 1 \
            -vf "scale=400:400:force_original_aspect_ratio=decrease" \
            "$out_file" \
            </dev/null >/dev/null 2>&1; then
          echo "${asset_id}.jpg"
          return 0
        fi
      else
        log_warn "ffmpeg non trovato, thumbnail video non generato per: $file"
      fi
      ;;
    *)
      # Immagini: usa convert con timeout
      if command -v convert >/dev/null 2>&1; then
        if timeout 30 convert "$file" \
            -auto-orient \
            -thumbnail 400x400 \
            "$out_file" \
            >/dev/null 2>&1; then
          echo "${asset_id}.jpg"
          return 0
        fi
      fi
      ;;
  esac

  echo ""
}

# ---------------------------------------------------------------------------
# Funzioni SQL a livello top-level (fix: heredoc dentro $() causa parse error)
# ---------------------------------------------------------------------------
_sql_insert_asset() {
  local ef="$1" emk="$2"
  sqlite_batch <<SQL
BEGIN IMMEDIATE;
INSERT INTO assets (title, media_kind, created_at, updated_at)
VALUES ('$ef', '$emk', strftime('%s','now'), strftime('%s','now'));
SELECT last_insert_rowid();
COMMIT;
SQL
}

_sql_insert_file() {
  local asset_id="$1" ep="$2" er="$3" ef="$4" esha="$5" em="$6"
  local size_bytes="$7" mtime="$8" ethumb="$9"
  sqlite_batch <<SQL
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
}

_sql_update_file() {
  local esha="$1" em="$2" size_bytes="$3" mtime="$4" ethumb="$5"
  local file_id="$6" emk="$7" asset_id="$8"
  sqlite_batch <<SQL
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
    media_kind='$emk',
    updated_at=strftime('%s','now')
WHERE id=$asset_id;
COMMIT;
SQL
}

# ---------------------------------------------------------------------------
# process_file
# ---------------------------------------------------------------------------
process_file() {
  local file="$1"

  local lc_file="${file,,}"

  local media_kind
  case "$lc_file" in
    *.mp4|*.mov|*.avi|*.mkv|*.webm) media_kind="video" ;;
    *) media_kind="image" ;;
  esac

  case "$lc_file" in
    *.jpg|*.jpeg|*.png|*.gif|*.webp|*.mp4|*.mov|*.avi|*.mkv|*.webm) ;;
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

  local ep er ef esha em emk
  ep=$(printf '%s' "$abs_path"      | sql_escape)
  er=$(printf '%s' "$rel_path"      | sql_escape)
  ef=$(printf '%s' "$filename"      | sql_escape)
  esha=$(printf '%s' "$sha256"      | sql_escape)
  em=$(printf '%s' "$metadata_json" | sql_escape)
  emk=$(printf '%s' "$media_kind"   | sql_escape)

  local row
  row=$(sqlite_query "SELECT id, sha256, mtime, asset_id FROM asset_files WHERE absolute_path = '$ep';")

  if [ -z "$row" ]; then
    log_ok "Nuovo file: $abs_path"

    local asset_id
    asset_id="$(_sql_insert_asset "$ef" "$emk" | tail -n 1)"

    local thumb_rel ethumb
    thumb_rel="$(generate_thumb "$file" "$asset_id")"
    ethumb=$(printf '%s' "$thumb_rel" | sql_escape)

    _sql_insert_file "$asset_id" "$ep" "$er" "$ef" "$esha" "$em" "$size_bytes" "$mtime" "$ethumb" >/dev/null

    echo "$asset_id"

  else
    local file_id old_sha old_mtime asset_id
    file_id=$(echo "$row" | awk -F'|' '{print $1}')
    old_sha=$(echo "$row" | awk -F'|' '{print $2}')
    old_mtime=$(echo "$row" | awk -F'|' '{print $3}')
    asset_id=$(echo "$row" | awk -F'|' '{print $4}')

    if [ "$old_sha" != "$sha256" ] || [ "$old_mtime" != "$mtime" ]; then
      log_run "File modificato: $abs_path"

      local thumb_rel ethumb
      thumb_rel="$(generate_thumb "$file" "$asset_id")"
      ethumb=$(printf '%s' "$thumb_rel" | sql_escape)

      _sql_update_file "$esha" "$em" "$size_bytes" "$mtime" "$ethumb" "$file_id" "$emk" "$asset_id" >/dev/null

      echo "$asset_id"
    fi
  fi
}

# ---------------------------------------------------------------------------
# FASE 1: scansione sequenziale
# ---------------------------------------------------------------------------
log_run "Scansione libreria in $PHOTO_ROOT_ABS"

PENDING_IDS_FILE="$(mktemp)"
trap 'rm -f "$PENDING_IDS_FILE"' EXIT

while IFS= read -r f; do
  process_file "$f"
done < <(find "$PHOTO_ROOT_ABS" -type f 2>/dev/null) > "$PENDING_IDS_FILE"

log_ok "Scansione filesystem completata."

SALVATI_SENZA_DESC=$(sqlite_query "SELECT id FROM assets WHERE ai_description_id IS NULL;")

ALL_PENDING=$(
  { cat "$PENDING_IDS_FILE"; echo "$SALVATI_SENZA_DESC"; } \
  | grep -v '^$' \
  | sort -un
)

COUNT=$(echo "$ALL_PENDING" | grep -c '[0-9]' || true)

# ---------------------------------------------------------------------------
# FASE 2: elaborazione IA parallela
# ---------------------------------------------------------------------------
WORKER_SCRIPT="$ROOT_DIR/bin/worker_ai.py"

if [ "$COUNT" -eq 0 ]; then
  log_ok "Nessun asset da elaborare con l'IA."
else
  log_run "Avvio $AI_WORKERS worker IA su $COUNT asset..."
  echo "$ALL_PENDING" | \
    parallel \
      --jobs "$AI_WORKERS" \
      --line-buffer \
      python3 "\"$WORKER_SCRIPT\"" {}
  log_ok "Elaborazione IA completata ($COUNT asset processati)."
fi

log_ok "Update DB completato."