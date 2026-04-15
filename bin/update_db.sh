#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

if [ ! -f "$ROOT_DIR/config/app.env" ]; then
  echo "config/app.env non trovato." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/config/app.env"

# Normalizza percorsi
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

mkdir -p "$THUMB_DIR_ABS"
touch "$LOG_FILE_ABS"

log() {
  local msg="$1"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] update_db: $msg" | tee -a "$LOG_FILE_ABS" >&2
}

sql_escape() {
  # Escapa solo gli apici singoli raddoppiandoli
  sed "s/'/''/g"
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

  # Nessuna thumbnail generata
  echo ""
}

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

  local abs_path
  abs_path="$(realpath "$file")"
  local rel_path="${abs_path#$PHOTO_ROOT_ABS/}"
  local filename
  filename="$(basename "$file")"

  local stat_out
  stat_out="$(get_size_mtime "$file")"
  local size_bytes mtime
  size_bytes="$(echo "$stat_out" | awk '{print $1}')"
  mtime="$(echo "$stat_out" | awk '{print $2}')"

  local sha256
  sha256="$("$ROOT_DIR/bin/hash_file.sh" "$file")"

  local metadata_json
  metadata_json="$("$ROOT_DIR/bin/extract_metadata.sh" "$file" || echo '{}')"

  # Escaping per SQL
  local ep er ef esha em
  ep=$(printf '%s' "$abs_path" | sql_escape)
  er=$(printf '%s' "$rel_path" | sql_escape)
  ef=$(printf '%s' "$filename" | sql_escape)
  esha=$(printf '%s' "$sha256" | sql_escape)
  em=$(printf '%s' "$metadata_json" | sql_escape)

  local row
  row=$(sqlite3 "$DB_FILE" "SELECT id, sha256, mtime, asset_id FROM asset_files WHERE absolute_path = '$ep';")

  if [ -z "$row" ]; then
    log "Nuovo file: $abs_path"
    # Nuovo asset
    local asset_id
    asset_id=$(sqlite3 "$DB_FILE" "INSERT INTO assets (title, created_at, updated_at) VALUES ('$ef', strftime('%s','now'), strftime('%s','now')); SELECT last_insert_rowid();")

    # Thumbnail opzionale
    local thumb_rel
    thumb_rel="$(generate_thumb "$file" "$asset_id")"
    local ethumb
    ethumb=$(printf '%s' "$thumb_rel" | sql_escape)

    sqlite3 "$DB_FILE" "INSERT INTO asset_files (asset_id, absolute_path, relative_path, filename, sha256, metadata_json, size_bytes, mtime, thumb_path, created_at, updated_at)
      VALUES ($asset_id, '$ep', '$er', '$ef', '$esha', '$em', $size_bytes, $mtime, '$ethumb', strftime('%s','now'), strftime('%s','now'));"

    # Descrizione AI
    local desc
    desc="$("$ROOT_DIR/bin/generate_description.sh" "$file" || echo '')"
    if [ -n "$desc" ]; then
      local edesc emodel elang
      edesc=$(printf '%s' "$desc" | sql_escape)
      emodel=$(printf '%s' "$OLLAMA_MODEL" | sql_escape)
      elang=$(printf '%s' "$LANGUAGE" | sql_escape)

      sqlite3 "$DB_FILE" "INSERT INTO ai_descriptions (asset_id, model, language, description, created_at)
        VALUES ($asset_id, '$emodel', '$elang', '$edesc', strftime('%s','now'));"

      sqlite3 "$DB_FILE" "UPDATE assets
        SET ai_description_id = (SELECT id FROM ai_descriptions WHERE asset_id = $asset_id ORDER BY created_at DESC LIMIT 1),
            updated_at = strftime('%s','now')
        WHERE id = $asset_id;"
    fi
  else
    local file_id old_sha old_mtime asset_id
    file_id=$(echo "$row" | awk -F'|' '{print $1}')
    old_sha=$(echo "$row" | awk -F'|' '{print $2}')
    old_mtime=$(echo "$row" | awk -F'|' '{print $3}')
    asset_id=$(echo "$row" | awk -F'|' '{print $4}')

    if [ "$old_sha" != "$sha256" ] || [ "$old_mtime" != "$mtime" ]; then
      log "File modificato: $abs_path"
      # Thumbnail aggiornata
      local thumb_rel
      thumb_rel="$(generate_thumb "$file" "$asset_id")"
      local ethumb
      ethumb=$(printf '%s' "$thumb_rel" | sql_escape)

      sqlite3 "$DB_FILE" "UPDATE asset_files
        SET sha256 = '$esha',
            metadata_json = '$em',
            size_bytes = $size_bytes,
            mtime = $mtime,
            thumb_path = '$ethumb',
            updated_at = strftime('%s','now')
        WHERE id = $file_id;"

      local desc
      desc="$("$ROOT_DIR/bin/generate_description.sh" "$file" || echo '')"
      if [ -n "$desc" ]; then
        local edesc emodel elang
        edesc=$(printf '%s' "$desc" | sql_escape)
        emodel=$(printf '%s' "$OLLAMA_MODEL" | sql_escape)
        elang=$(printf '%s' "$LANGUAGE" | sql_escape)

        sqlite3 "$DB_FILE" "INSERT INTO ai_descriptions (asset_id, model, language, description, created_at)
          VALUES ($asset_id, '$emodel', '$elang', '$edesc', strftime('%s','now'));"

        sqlite3 "$DB_FILE" "UPDATE assets
          SET ai_description_id = (SELECT id FROM ai_descriptions WHERE asset_id = $asset_id ORDER BY created_at DESC LIMIT 1),
              updated_at = strftime('%s','now')
          WHERE id = $asset_id;"
      fi
    else
      # Nessuna modifica
      :
    fi
  fi
}

log "Scansione libreria in $PHOTO_ROOT_ABS"

# Trova tutti i file e filtra per estensioni supportate nello script
while IFS= read -r f; do
  process_file "$f"
done < <(find "$PHOTO_ROOT_ABS" -type f 2>/dev/null)

log "Scansione completata."