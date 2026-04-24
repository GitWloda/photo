#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 6_generate_narrative.sh
# Legge descriptions.json, aggrega tutte le descrizioni dei
# frame e chiede a Ollama (modello testuale) di produrre un
# racconto discorsivo coerente della sequenza visiva.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/frame_cleaner.conf"

DIR="${1:-.}"
DIR="$(realpath "$DIR")"

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_TEXT_MODEL="${OLLAMA_TEXT_MODEL:-gemma3:12b}"
LANGUAGE="${LANGUAGE:-italiano}"
INPUT_JSON="$DIR/descriptions.json"

# ============================================================
# Dipendenze
# ============================================================
for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERRORE] Comando non trovato: $cmd" >&2
    exit 1
  fi
done

if [ ! -f "$INPUT_JSON" ]; then
  echo "[ERRORE] File non trovato: $INPUT_JSON" >&2
  echo "         Esegui prima 6_generate_descriptions.sh" >&2
  exit 1
fi

TOTAL="$(jq 'length' "$INPUT_JSON")"
if [ "$TOTAL" -eq 0 ]; then
  echo "[WARN] Il file $INPUT_JSON è vuoto. Niente da elaborare."
  exit 0
fi

echo "[INFO] Carico $TOTAL descrizioni da: $INPUT_JSON"
echo "[INFO] Modello testuale: $OLLAMA_TEXT_MODEL"
echo ""

# ============================================================
# Costruisce il blocco di testo con tutte le descrizioni
# ============================================================
DESCRIPTIONS_BLOCK="$(
  jq -r '.[] | "Frame \(.frame):\n\(.description)\n"' "$INPUT_JSON"
)"

PROMPT="Sei un narratore visivo. Di seguito ti vengono fornite le descrizioni di ${TOTAL} frame estratti in sequenza da un video. \
Analizzale tutte insieme e scrivi un unico testo discorsivo in ${LANGUAGE}, coerente e fluido, che racconti cosa accade nella scena \
nel suo insieme. Non elencare i frame uno per uno: sintetizza, collega i momenti e restituisci una narrazione unica come se \
stessi descrivendo un filmato a qualcuno che non può vederlo. Sii preciso, descrittivo e usa uno stile narrativo naturale.\n\n\
--- DESCRIZIONI DEI FRAME ---\n${DESCRIPTIONS_BLOCK}\n--- FINE DESCRIZIONI ---"

echo "[INFO] Invio prompt a Ollama ($OLLAMA_TEXT_MODEL)..."
echo ""

# ============================================================
# Chiamata Ollama (solo testo, niente immagini)
# ============================================================
RESPONSE="$(
  jq -n \
    --arg model  "$OLLAMA_TEXT_MODEL" \
    --arg prompt "$PROMPT" \
    '{
       model:  $model,
       prompt: $prompt,
       stream: false
     }' | \
  curl -s --max-time 300 "${OLLAMA_URL}/api/generate" \
    -H "Content-Type: application/json" \
    -d @-
)"

NARRATIVE="$(printf '%s' "$RESPONSE" | jq -r '.response // empty' 2>/dev/null || true)"

if [ -z "$NARRATIVE" ] || [ "$NARRATIVE" = "null" ]; then
  echo "[ERRORE] Risposta vuota da Ollama." >&2
  echo "Risposta grezza:" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

# ============================================================
# Output a schermo
# ============================================================
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              NARRAZIONE DELLA SEQUENZA VISIVA            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
printf '%s\n' "$NARRATIVE"
echo ""

# Salva anche su file per reference
NARRATIVE_FILE="$DIR/narrative.txt"
printf '%s\n' "$NARRATIVE" > "$NARRATIVE_FILE"
echo "[OK] Narrazione salvata anche in: $NARRATIVE_FILE"
