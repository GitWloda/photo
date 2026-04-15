#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Uso: $0 <file>" >&2
  exit 1
fi

FILE="$1"

if ! command -v exiftool >/dev/null 2>&1; then
  echo "Errore: exiftool non trovato nel PATH." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Errore: jq non trovato nel PATH (necessario per normalizzare JSON)." >&2
  exit 1
fi

# Ritorna un singolo oggetto JSON compatto con i metadati del file
exiftool -json -n "$FILE" 2>/dev/null | jq -c '.[0]'