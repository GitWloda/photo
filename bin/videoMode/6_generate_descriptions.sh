#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 6_generate_descriptions.sh
# Raggruppa frame consecutivi in batch temporali e chiede a
# Ollama di descrivere ogni batch come una micro-sequenza
# video coerente, non come singole immagini isolate.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/frame_cleaner.conf"

DIR="${1:-.}"
DIR="$(realpath "$DIR")"

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_VISION_MODEL="${OLLAMA_VISION_MODEL:-gemma4:e4b}"
LANGUAGE="${LANGUAGE:-italiano}"
OUTPUT_JSON="$DIR/descriptions.json"

PROGRESS_BAR_WIDTH="${PROGRESS_BAR_WIDTH:-28}"
OLLAMA_BATCH_SIZE="${OLLAMA_BATCH_SIZE:-6}"
OLLAMA_TIMEOUT="${OLLAMA_TIMEOUT:-240}"
OLLAMA_TEMPERATURE="${OLLAMA_TEMPERATURE:-0.2}"

cleanup_files=()

cleanup() {
  local f
  for f in "${cleanup_files[@]:-}"; do
    rm -f -- "$f" >/dev/null 2>&1 || true
  done
  true
}
trap cleanup EXIT

die() {
  echo "$*" >&2
  exit 1
}

for cmd in curl jq base64 realpath find sort mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || die "[ERRORE] Comando non trovato: $cmd"
done

[[ -d "$DIR" ]] || die "[ERRORE] Directory non trovata: $DIR"

if ! [[ "$OLLAMA_BATCH_SIZE" =~ ^[0-9]+$ ]] || ((OLLAMA_BATCH_SIZE < 1)); then
  die "[ERRORE] OLLAMA_BATCH_SIZE non valido: $OLLAMA_BATCH_SIZE"
fi

mapfile -t FRAMES < <(find "$DIR" -maxdepth 1 -type f -name "${FRAME_GLOB:-frame_*.jpg}" | sort)

if [[ "${#FRAMES[@]}" -eq 0 ]]; then
  echo "[WARN] Nessun frame trovato in: $DIR"
  printf '[]\n' >"$OUTPUT_JSON"
  exit 0
fi

TOTAL_FRAMES="${#FRAMES[@]}"
TOTAL_BATCHES=$(((TOTAL_FRAMES + OLLAMA_BATCH_SIZE - 1) / OLLAMA_BATCH_SIZE))

echo "[INFO] Frame trovati        : $TOTAL_FRAMES"
echo "[INFO] Batch size           : $OLLAMA_BATCH_SIZE"
echo "[INFO] Batch totali         : $TOTAL_BATCHES"
echo "[INFO] Modello visione      : $OLLAMA_VISION_MODEL"
echo "[INFO] Timeout richiesta    : ${OLLAMA_TIMEOUT}s"
echo "[INFO] Output JSON          : $OUTPUT_JSON"
echo ""

printf '[]\n' >"$OUTPUT_JSON"

BATCH_INDEX=0
ERRORS=0

make_bar() {
  local current="$1"
  local total="$2"
  local width="$3"
  local filled=0
  local empty=0
  local bar=""
  local i

  if ((total > 0)); then
    filled=$((current * width / total))
  fi
  empty=$((width - filled))

  for ((i = 0; i < filled; i++)); do
    bar+="#"
  done
  for ((i = 0; i < empty; i++)); do
    bar+="."
  done

  printf '%s' "$bar"
}

build_prompt() {
  local language="$1"
  cat <<EOF
Analizza questo gruppo di frame consecutivi estratti dallo stesso video.

Questi frame sono ordinati temporalmente e rappresentano una breve porzione continua del filmato.
Non devi descrivere i singoli frame separatamente, ma interpretarli come una micro-sequenza video coerente.

Obiettivo:
scrivi una descrizione unica della sequenza nel suo insieme, in ${language}, come se stessi osservando un breve momento del video e dovessi raccontare cosa succede realmente in quel tratto.

Istruzioni:
- considera l'insieme dei frame come un unico segmento video;
- descrivi l'ambientazione generale, i soggetti presenti, le azioni in corso e gli eventuali cambiamenti tra l'inizio e la fine della sequenza;
- se c'è movimento, progressione o trasformazione, rendilo esplicito;
- evita di elencare o separare i frame uno a uno;
- evita ripetizioni inutili se i frame sono simili;
- non inventare dettagli non chiaramente supportati dalle immagini;
- se qualcosa non è certo, usa formulazioni prudenti;
- scrivi in modo naturale, compatto e coerente;
- niente saluti, niente introduzioni, niente elenco puntato;
- produci un solo testo continuo di 3-6 frasi ben collegate.

Importante:
non parlare di "immagini", "frame", "fotogrammi" o "sequenza di screenshot" nel testo finale.
Descrivi direttamente ciò che accade nel video in quel tratto.
EOF
}

for ((start = 0; start < TOTAL_FRAMES; start += OLLAMA_BATCH_SIZE)); do
  BATCH_INDEX=$((BATCH_INDEX + 1))
  end=$((start + OLLAMA_BATCH_SIZE - 1))
  if ((end >= TOTAL_FRAMES)); then
    end=$((TOTAL_FRAMES - 1))
  fi

  BATCH_FILES=()
  BATCH_NAMES=()
  for ((i = start; i <= end; i++)); do
    BATCH_FILES+=("${FRAMES[$i]}")
    BATCH_NAMES+=("$(basename "${FRAMES[$i]}")")
  done

  FIRST_FRAME="${BATCH_NAMES[0]}"
  LAST_FRAME="${BATCH_NAMES[$((${#BATCH_NAMES[@]} - 1))]}"

  BAR="$(make_bar "$BATCH_INDEX" "$TOTAL_BATCHES" "$PROGRESS_BAR_WIDTH")"
  printf "\r[%s] %d/%d  %-30s" "$BAR" "$BATCH_INDEX" "$TOTAL_BATCHES" "$FIRST_FRAME → $LAST_FRAME"

  PROMPT="$(build_prompt "$LANGUAGE")"

  PAYLOAD_FILE="$(mktemp)"
  RESPONSE_FILE="$(mktemp)"
  UPDATED_FILE="$(mktemp)"
  HTTP_FILE="$(mktemp)"
  IMAGES_FILE="$(mktemp)"
  FRAMES_JSON_FILE="$(mktemp)"
  cleanup_files+=("$PAYLOAD_FILE" "$RESPONSE_FILE" "$UPDATED_FILE" "$HTTP_FILE" "$IMAGES_FILE" "$FRAMES_JSON_FILE")

  : >"$IMAGES_FILE"
  for FRAME in "${BATCH_FILES[@]}"; do
    base64 -w 0 "$FRAME" >>"$IMAGES_FILE"
    printf '\n' >>"$IMAGES_FILE"
  done

  printf '%s\n' "${BATCH_NAMES[@]}" | jq -R . | jq -s . >"$FRAMES_JSON_FILE"

  DESC=""
  HTTP_CODE="000"

  if ! jq -Rn \
    --arg model "$OLLAMA_VISION_MODEL" \
    --arg prompt "$PROMPT" \
    --argjson temperature "$OLLAMA_TEMPERATURE" \
    '
      {
        model: $model,
        prompt: $prompt,
        images: [inputs],
        stream: false,
        options: {
          temperature: $temperature
        }
      }' <"$IMAGES_FILE" >"$PAYLOAD_FILE"; then
    DESC="[ERRORE: impossibile costruire il payload JSON]"
    ERRORS=$((ERRORS + 1))
  else
    if curl -sS \
      --max-time "$OLLAMA_TIMEOUT" \
      -o "$RESPONSE_FILE" \
      -w "%{http_code}" \
      "${OLLAMA_URL}/api/generate" \
      -H "Content-Type: application/json" \
      --data-binary "@$PAYLOAD_FILE" >"$HTTP_FILE" 2>/dev/null; then
      HTTP_CODE="$(tr -d '[:space:]' <"$HTTP_FILE")"
    else
      HTTP_CODE="000"
    fi

    if [[ "$HTTP_CODE" != "200" ]]; then
      RAW_ERROR="$(cat "$RESPONSE_FILE" 2>/dev/null || true)"
      if [[ -n "$RAW_ERROR" ]]; then
        DESC="[ERRORE: Ollama HTTP $HTTP_CODE - $RAW_ERROR]"
      else
        DESC="[ERRORE: Ollama HTTP $HTTP_CODE]"
      fi
      ERRORS=$((ERRORS + 1))
    else
      DESC="$(jq -r '.response // empty' "$RESPONSE_FILE" 2>/dev/null || true)"
      if [[ -z "$DESC" || "$DESC" == "null" ]]; then
        DESC="[ERRORE: risposta vuota da Ollama]"
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi

  if ! jq \
    --arg frame "$FIRST_FRAME" \
    --arg path "${BATCH_FILES[0]}" \
    --arg start_frame "$FIRST_FRAME" \
    --arg end_frame "$LAST_FRAME" \
    --arg desc "$DESC" \
    --argjson batch_index "$BATCH_INDEX" \
    --argjson batch_size "${#BATCH_FILES[@]}" \
    --slurpfile frames "$FRAMES_JSON_FILE" \
    '. += [{
        "frame": $frame,
        "path": $path,
        "frames": $frames[0],
        "start_frame": $start_frame,
        "end_frame": $end_frame,
        "batch_index": $batch_index,
        "batch_size": $batch_size,
        "description": $desc
      }]' \
    "$OUTPUT_JSON" >"$UPDATED_FILE"; then
    echo ""
    die "[ERRORE] Impossibile aggiornare $OUTPUT_JSON"
  fi

  mv "$UPDATED_FILE" "$OUTPUT_JSON"

  rm -f "$PAYLOAD_FILE" "$RESPONSE_FILE" "$UPDATED_FILE" "$HTTP_FILE" "$IMAGES_FILE" "$FRAMES_JSON_FILE"
done

echo ""
echo ""
echo "[OK] Descrizioni salvate in: $OUTPUT_JSON"
echo "[INFO] Batch totali: $TOTAL_BATCHES | Errori: $ERRORS"

exit 0

