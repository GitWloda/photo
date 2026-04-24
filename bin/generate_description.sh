#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." ; pwd)"

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

# FIX #6: METADATA_JSON ora incluso nel prompt come contesto per il modello
METADATA_JSON="$("$ROOT_DIR/bin/extract_metadata.sh" "$FILE" || echo '{}')"

# Estrai solo i campi utili per il contesto (evita di inondare il prompt)
META_CONTEXT="$(printf '%s' "$METADATA_JSON" | jq -r '
  [ (.Make // ""), (.Model // ""), (.LensModel // ""), (.CreateDate // ""), (.ISO // "") ]
  | map(select(. != ""))
  | if length > 0 then "Metadati disponibili: " + join(", ") + "." else "" end
' 2>/dev/null || true)"

if [ -n "$META_CONTEXT" ]; then
  PROMPT="Descrivi con precisione e senza inventare questa foto in ${LANGUAGE}, in più frasi, senza saluti, introduzioni né elenchi. ${META_CONTEXT}"
else
  PROMPT="Descrivi con precisione e senza inventare questa foto in ${LANGUAGE}, in più frasi, senza saluti, introduzioni né elenchi."
fi

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