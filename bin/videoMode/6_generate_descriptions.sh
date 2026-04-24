#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 5_generate_descriptions.sh
# Per ogni frame nella directory, chiama Ollama (modello visione)
# e salva le descrizioni in descriptions.json
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Carica la config condivisa
source "$SCRIPT_DIR/frame_cleaner.conf"

DIR="${1:-.}"
DIR="$(realpath "$DIR")"

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_VISION_MODEL="${OLLAMA_VISION_MODEL:-llava:13b}"
LANGUAGE="${LANGUAGE:-italiano}"
OUTPUT_JSON="$DIR/descriptions.json"

# ============================================================
# Dipendenze
# ============================================================
for cmd in curl jq base64; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERRORE] Comando non trovato: $cmd" >&2
    exit 1
  fi
done

# ============================================================
# Raccoglie i frame ordinati
# ============================================================
mapfile -t FRAMES < <(find "$DIR" -maxdepth 1 -name "$FRAME_GLOB" | sort)

if [ "${#FRAMES[@]}" -eq 0 ]; then
  echo "[WARN] Nessun frame trovato in: $DIR"
  echo "[]" > "$OUTPUT_JSON"
  exit 0
fi

TOTAL="${#FRAMES[@]}"
echo "[INFO] Frame trovati: $TOTAL"
echo "[INFO] Modello visione: $OLLAMA_VISION_MODEL"
echo "[INFO] Output JSON: $OUTPUT_JSON"
echo ""

# ============================================================
# Inizializza il JSON (array vuoto)
# ============================================================
echo "[]" > "$OUTPUT_JSON"

COUNT=0
ERRORS=0

for FRAME in "${FRAMES[@]}"; do
  COUNT=$((COUNT + 1))
  BASENAME="$(basename "$FRAME")"

  # Barra di avanzamento
  BAR_FILLED=$(( COUNT * PROGRESS_BAR_WIDTH / TOTAL ))
  BAR_EMPTY=$(( PROGRESS_BAR_WIDTH - BAR_FILLED ))
  BAR="$(printf '#%.0s' $(seq 1 $BAR_FILLED))$(printf '.%.0s' $(seq 1 $BAR_EMPTY))"
  printf "\r[%s] %d/%d  %-30s" "$BAR" "$COUNT" "$TOTAL" "$BASENAME"

  PROMPT="Descrivi con precisione e senza inventare questa immagine in ${LANGUAGE}, in più frasi, senza saluti, introduzioni né elenchi."

  # Costruisce il payload e chiama Ollama
  RESPONSE="$(
    base64 < "$FRAME" | tr -d '\n' | \
    jq -Rn \
      --arg model  "$OLLAMA_VISION_MODEL" \
      --arg prompt "$PROMPT" \
      '{
         model:  $model,
         prompt: $prompt,
         images: [input],
         stream: false
       }' | \
    curl -s --max-time 120 "${OLLAMA_URL}/api/generate" \
      -H "Content-Type: application/json" \
      -d @- \
  )"

  DESC="$(printf '%s' "$RESPONSE" | jq -r '.response // empty' 2>/dev/null || true)"

  if [ -z "$DESC" ] || [ "$DESC" = "null" ]; then
    DESC="[ERRORE: risposta vuota da Ollama]"
    ERRORS=$((ERRORS + 1))
  fi

  # Aggiunge l'entry al JSON in modo atomico (leggi → aggiungi → riscrivi)
  UPDATED="$(
    jq \
      --arg file "$BASENAME" \
      --arg path "$FRAME" \
      --arg desc "$DESC" \
      '. += [{"frame": $file, "path": $path, "description": $desc}]' \
      "$OUTPUT_JSON"
  )"
  printf '%s' "$UPDATED" > "$OUTPUT_JSON"

done

echo ""
echo ""
echo "[OK] Descrizioni salvate in: $OUTPUT_JSON"
echo "[INFO] Totale: $TOTAL | Errori: $ERRORS"