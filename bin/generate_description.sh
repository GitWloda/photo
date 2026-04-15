#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

if [ ! -f "$ROOT_DIR/config/app.env" ]; then
  echo "config/app.env non trovato." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$ROOT_DIR/config/app.env"

if [ $# -ne 1 ]; then
  echo "Uso: $0 <file-immagine>" >&2
  exit 1
fi

FILE="$1"

if ! command -v curl >/dev/null 2>&1; then
  echo "Errore: curl non trovato nel PATH." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Errore: jq non trovato nel PATH." >&2
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "Errore: file non trovato: $FILE" >&2
  exit 1
fi

# Metadati come contesto extra (opzionale)
METADATA_JSON="$("$ROOT_DIR/bin/extract_metadata.sh" "$FILE" || echo '{}')"

PROMPT="Descrivi con precisione e senza inventare questa foto in ${LANGUAGE}, in più frasi, senza saluti, introduzioni né elenchi: ${FILE}"

# Pipeline:
#   base64 -> (una riga) -> jq costruisce JSON -> curl legge body da stdin (-d @-)
RESPONSE="$(
  base64 < "$FILE" | tr -d '\n' | \
  jq -Rn \
    --arg model "$OLLAMA_MODEL" \
    --arg prompt "$PROMPT" \
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

DESC="$(printf '%s' "$RESPONSE" | jq -r '.response // empty')"

if [ -z "$DESC" ] || [ "$DESC" = "null" ]; then
  echo "Descrizione non disponibile (risposta vuota da Ollama)." >&2
  echo "Risposta completa Ollama:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

printf '%s\n' "$DESC"