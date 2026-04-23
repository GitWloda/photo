#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# generate_video_description.sh
# Dato un file video:
#   1. estrae N frame equidistanti in una directory temporanea
#   2. li filtra con frame_cleaner (rimozione neri/bianchi/simili)
#   3. descrive ogni frame sopravvissuto tramite Ollama (vision model)
#   4. chiede a Ollama di sintetizzare le descrizioni in un'unica descrizione
#      globale del video
#   5. stampa la descrizione su stdout
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." ; pwd)"

if [ ! -f "$ROOT_DIR/config/app.env" ]; then
  echo "config/app.env non trovato." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/config/app.env"

if [ $# -ne 1 ]; then
  echo "Uso: $0 <file-video>" >&2
  exit 1
fi

VIDEO_FILE="$1"

if ! command -v ffmpeg  >/dev/null 2>&1; then echo "Errore: ffmpeg non trovato."  >&2; exit 1; fi
if ! command -v ffprobe >/dev/null 2>&1; then echo "Errore: ffprobe non trovato." >&2; exit 1; fi
if ! command -v curl    >/dev/null 2>&1; then echo "Errore: curl non trovato."    >&2; exit 1; fi
if ! command -v jq      >/dev/null 2>&1; then echo "Errore: jq non trovato."      >&2; exit 1; fi

if [ ! -f "$VIDEO_FILE" ]; then
  echo "Errore: file non trovato: $VIDEO_FILE" >&2
  exit 1
fi

# --- Parametri (override da app.env) ---
VIDEO_FRAMES="${VIDEO_FRAMES:-8}"
FRAME_CLEANER_ENABLED="${FRAME_CLEANER_ENABLED:-1}"

# --- Directory temporanea per i frame ---
FRAME_TMP="$(mktemp -d)"
trap 'rm -rf "$FRAME_TMP"' EXIT

# ---------------------------------------------------------------------------
# STEP 1: estrai VIDEO_FRAMES frame equidistanti
# ---------------------------------------------------------------------------
DURATION="$(ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 "$VIDEO_FILE" 2>/dev/null || echo "0")"

if awk -v d="$DURATION" 'BEGIN { exit !(d > 0) }'; then
  SELECT_EXPR="not(mod(n,max(1,floor(tb*r_frame_rate*${DURATION}/${VIDEO_FRAMES}))))"
  ffmpeg -y -i "$VIDEO_FILE" \
    -vf "select='${SELECT_EXPR}',scale=640:-1" \
    -vsync vfr \
    -frames:v "$VIDEO_FRAMES" \
    -q:v 3 \
    "$FRAME_TMP/frame_%04d.jpg" \
    >/dev/null 2>&1 || true
fi

FRAME_COUNT=$(find "$FRAME_TMP" -maxdepth 1 -iname 'frame_*.jpg' | wc -l)
if [ "$FRAME_COUNT" -eq 0 ]; then
  STEP="$(awk -v d="$DURATION" -v n="$VIDEO_FRAMES" 'BEGIN { s=d/n; if(s<1)s=1; printf "%.3f", s }')"
  ffmpeg -y -i "$VIDEO_FILE" \
    -vf "fps=1/${STEP},scale=640:-1" \
    -frames:v "$VIDEO_FRAMES" \
    -q:v 3 \
    "$FRAME_TMP/frame_%04d.jpg" \
    >/dev/null 2>&1 || true
fi

FRAME_COUNT=$(find "$FRAME_TMP" -maxdepth 1 -iname 'frame_*.jpg' | wc -l)
if [ "$FRAME_COUNT" -eq 0 ]; then
  echo "Impossibile estrarre frame dal video: $VIDEO_FILE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# STEP 2: pulizia frame con frame_cleaner (opzionale)
# ---------------------------------------------------------------------------
CLEANER_SCRIPT="$ROOT_DIR/bin/frame_cleaner/startall.sh"

if [ "$FRAME_CLEANER_ENABLED" = "1" ] && [ -x "$CLEANER_SCRIPT" ]; then
  FRAME_CLEANER_CONFIG="$ROOT_DIR/config/frame_cleaner.conf" \
    "$CLEANER_SCRIPT" "$FRAME_TMP" >/dev/null 2>&1 || true
fi

# Rileggi i frame sopravvissuti
mapfile -d '' GOOD_FRAMES < <(
  find "$FRAME_TMP" -maxdepth 1 -iname 'frame_*.jpg' -print0 2>/dev/null | sort -zV
)

if [ ${#GOOD_FRAMES[@]} -eq 0 ]; then
  mapfile -d '' GOOD_FRAMES < <(
    find "$FRAME_TMP/scarti" -maxdepth 1 -iname 'frame_*.jpg' -print0 2>/dev/null | sort -zV
  )
fi

if [ ${#GOOD_FRAMES[@]} -eq 0 ]; then
  echo "Nessun frame utilizzabile per la descrizione." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# STEP 3: descrivi ogni frame con Ollama (vision)
# ---------------------------------------------------------------------------
FRAME_DESCRIPTIONS=()

FRAME_PROMPT="Descrivi in modo conciso (1-2 frasi) il contenuto visivo di questo frame video in ${LANGUAGE}. Sii diretto, senza formule di apertura."

for frame in "${GOOD_FRAMES[@]}"; do
  [[ -f "$frame" ]] || continue

  RESPONSE="$(
    base64 < "$frame" | tr -d '\n' | \
    jq -Rn \
      --arg model "$OLLAMA_MODEL" \
      --arg prompt "$FRAME_PROMPT" \
      '{
         model: $model,
         prompt: $prompt,
         images: [input],
         stream: false
       }' | \
    curl -s "${OLLAMA_URL}/api/generate" \
      -H "Content-Type: application/json" \
      -d @-
  )"

  DESC="$(printf '%s' "$RESPONSE" | jq -r '.response // empty' 2>/dev/null || true)"

  if [ -n "$DESC" ] && [ "$DESC" != "null" ]; then
    FRAME_DESCRIPTIONS+=("$DESC")
  fi
done

if [ ${#FRAME_DESCRIPTIONS[@]} -eq 0 ]; then
  echo "Nessuna descrizione frame ottenuta da Ollama." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# STEP 4: sintetizza le descrizioni in un'unica descrizione del video
# ---------------------------------------------------------------------------
FRAME_TEXT=""
for i in "${!FRAME_DESCRIPTIONS[@]}"; do
  FRAME_TEXT+="Frame $((i+1)): ${FRAME_DESCRIPTIONS[$i]}"$'\n'
done

SYNTH_PROMPT="Di seguito hai le descrizioni di ${#FRAME_DESCRIPTIONS[@]} frame estratti da un video, in ordine temporale. Scrivi una descrizione complessiva del video in ${LANGUAGE}, in piu' frasi, senza saluti, senza elenchi e senza formule introduttive. Concentrati su cosa accade, chi/cosa e' presente e l'atmosfera generale.\n\n${FRAME_TEXT}"

SYNTH_RESPONSE="$(
  jq -n \
    --arg model "$OLLAMA_MODEL" \
    --arg prompt "$SYNTH_PROMPT" \
    '{
       model: $model,
       prompt: $prompt,
       stream: false
     }' | \
  curl -s "${OLLAMA_URL}/api/generate" \
    -H "Content-Type: application/json" \
    -d @-
)"

FINAL_DESC="$(printf '%s' "$SYNTH_RESPONSE" | jq -r '.response // empty' 2>/dev/null || true)"

if [ -z "$FINAL_DESC" ] || [ "$FINAL_DESC" = "null" ]; then
  FINAL_DESC="$(printf '%s\n' "${FRAME_DESCRIPTIONS[@]}")"
fi

printf '%s\n' "$FINAL_DESC"
