#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/frame_cleaner.conf"

DIR="${1:-.}"
DIR="$(realpath "$DIR")"

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_TEXT_MODEL="${OLLAMA_TEXT_MODEL:-qwen3.6:35b}"
LANGUAGE="${LANGUAGE:-italiano}"
INPUT_JSON="$DIR/descriptions.json"
NARRATIVE_FILE="$DIR/narrative.txt"
NARRATIVE_JSON="$DIR/narrative.json"
OLLAMA_TIMEOUT="${OLLAMA_TIMEOUT:-300}"

cleanup_files=()

cleanup() {
  local f
  for f in "${cleanup_files[@]:-}"; do
    [[ -n "$f" && -e "$f" ]] && rm -f "$f"
  done
}
trap cleanup EXIT

die() {
  echo "$*" >&2
  exit 1
}

for cmd in curl jq realpath mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || die "[ERRORE] Comando non trovato: $cmd"
done

[[ -d "$DIR" ]] || die "[ERRORE] Directory non trovata: $DIR"

if [[ ! -f "$INPUT_JSON" ]]; then
  die "[ERRORE] File non trovato: $INPUT_JSON
         Esegui prima 6_generate_descriptions.sh"
fi

TOTAL_BATCHES="$(jq 'length' "$INPUT_JSON")"
if [[ "$TOTAL_BATCHES" -eq 0 ]]; then
  echo "[WARN] Il file $INPUT_JSON è vuoto. Niente da elaborare."
  exit 0
fi

TOTAL_FRAMES_APPROX="$(jq '[.[].batch_size // 1] | add' "$INPUT_JSON")"
FIRST_FRAME="$(jq -r '.[0].start_frame // .[0].frame // "sconosciuto"' "$INPUT_JSON")"
LAST_FRAME="$(jq -r '.[-1].end_frame // .[-1].frame // "sconosciuto"' "$INPUT_JSON")"

echo "[INFO] Batch caricati        : $TOTAL_BATCHES"
echo "[INFO] Frame rappresentati   : $TOTAL_FRAMES_APPROX"
echo "[INFO] Intervallo sequenza   : $FIRST_FRAME -> $LAST_FRAME"
echo "[INFO] Modello testuale      : $OLLAMA_TEXT_MODEL"
echo "[INFO] Input JSON            : $INPUT_JSON"
echo ""

SEGMENTS_BLOCK="$(
  jq -r '
    .[]
    | "SEGMENTO " + ((.batch_index // 0) | tostring) + "\n"
      + "Frame iniziale: " + (.start_frame // .frame // "n/d") + "\n"
      + "Frame finale: " + (.end_frame // .frame // "n/d") + "\n"
      + "Numero frame batch: " + ((.batch_size // 1) | tostring) + "\n"
      + "Frame inclusi: " + ((.frames // [.frame]) | join(", ")) + "\n"
      + "Descrizione segmento:\n" + (.description // "") + "\n"
  ' "$INPUT_JSON"
)"

PROMPT="$(cat <<EOF
Sei un analista narrativo audiovisivo.

Ti fornisco una sequenza ordinata di segmenti consecutivi estratti da un video.
Ogni segmento rappresenta una micro-scena composta da più frame vicini nel tempo.
Le descrizioni sono già in ordine cronologico.

Il tuo compito è produrre un'unica narrazione coerente dell'intero video o della porzione analizzata, in ${LANGUAGE}.

Istruzioni:
- tratta ogni segmento come parte di una sequenza temporale continua;
- ricostruisci il flusso generale di ciò che accade;
- unisci i segmenti senza ripetere le stesse informazioni;
- se un'azione o un'inquadratura evolve da un segmento al successivo, evidenzia la progressione;
- mantieni coerenza su ambienti, soggetti, movimenti e atmosfera;
- non elencare i segmenti uno per uno;
- non citare i nomi dei file salvo necessità;
- non inventare dettagli non supportati;
- se qualcosa non è certo, usa formulazioni prudenti;
- evita frasi metatestuali come "nei frame si vede";
- scrivi un testo narrativo naturale, chiaro e ben connesso;
- l'obiettivo non è descrivere immagini isolate, ma raccontare la scena come unità visiva coerente.

Struttura desiderata:
1. breve apertura contestuale;
2. sviluppo centrale con le principali azioni, cambiamenti e dettagli visivi;
3. chiusura che sintetizzi il tono complessivo e l'esito della sequenza, se deducibile.

Lunghezza:
- se i segmenti sono pochi o molto simili, resta conciso;
- se la sequenza è ricca, puoi essere più articolato;
- evita sia l'eccessiva brevità sia la prolissità.

Dati in ingresso:
- numero segmenti: ${TOTAL_BATCHES}
- frame complessivi rappresentati: ${TOTAL_FRAMES_APPROX}
- intervallo: ${FIRST_FRAME} -> ${LAST_FRAME}

--- INIZIO SEGMENTI ---
${SEGMENTS_BLOCK}
--- FINE SEGMENTI ---

Ora scrivi la narrazione finale.
EOF
)"

PAYLOAD_FILE="$(mktemp)"
RESPONSE_FILE="$(mktemp)"
HTTP_FILE="$(mktemp)"
cleanup_files+=("$PAYLOAD_FILE" "$RESPONSE_FILE" "$HTTP_FILE")

jq -n \
  --arg model "$OLLAMA_TEXT_MODEL" \
  --arg prompt "$PROMPT" \
  '{
    model: $model,
    prompt: $prompt,
    stream: false,
    options: {
      temperature: 0.3
    }
  }' > "$PAYLOAD_FILE"

echo "[INFO] Invio prompt a Ollama ($OLLAMA_TEXT_MODEL)..."
echo ""

HTTP_CODE="000"
if curl -sS \
    --max-time "$OLLAMA_TIMEOUT" \
    -o "$RESPONSE_FILE" \
    -w "%{http_code}" \
    "${OLLAMA_URL}/api/generate" \
    -H "Content-Type: application/json" \
    --data-binary "@$PAYLOAD_FILE" > "$HTTP_FILE" 2>/dev/null; then
  HTTP_CODE="$(tr -d '[:space:]' < "$HTTP_FILE")"
fi

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[ERRORE] Chiamata Ollama fallita (HTTP $HTTP_CODE)." >&2
  echo "[ERRORE] Risposta grezza:" >&2
  cat "$RESPONSE_FILE" >&2 || true
  exit 1
fi

NARRATIVE="$(jq -r '.response // empty' "$RESPONSE_FILE" 2>/dev/null || true)"

if [[ -z "$NARRATIVE" || "$NARRATIVE" == "null" ]]; then
  echo "[ERRORE] Risposta vuota da Ollama." >&2
  echo "[ERRORE] Risposta grezza:" >&2
  cat "$RESPONSE_FILE" >&2 || true
  exit 1
fi

echo "╔══════════════════════════════════════════════════════════╗"
echo "║           NARRAZIONE FINALE DELLA SEQUENZA VIDEO         ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
printf '%s\n' "$NARRATIVE"
echo ""

printf '%s\n' "$NARRATIVE" > "$NARRATIVE_FILE"

jq -n \
  --arg model "$OLLAMA_TEXT_MODEL" \
  --arg language "$LANGUAGE" \
  --arg narrative "$NARRATIVE" \
  --arg input_json "$INPUT_JSON" \
  --arg first_frame "$FIRST_FRAME" \
  --arg last_frame "$LAST_FRAME" \
  --argjson total_batches "$TOTAL_BATCHES" \
  --argjson total_frames "$TOTAL_FRAMES_APPROX" \
  '{
    input_json: $input_json,
    model: $model,
    language: $language,
    total_batches: $total_batches,
    total_frames: $total_frames,
    first_frame: $first_frame,
    last_frame: $last_frame,
    narrative: $narrative
  }' > "$NARRATIVE_JSON"

echo "[OK] Narrazione salvata in: $NARRATIVE_FILE"
echo "[OK] Metadata narrazione salvati in: $NARRATIVE_JSON"

exit 0