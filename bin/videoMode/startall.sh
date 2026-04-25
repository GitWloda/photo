#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENE_SCRIPT="$SCRIPT_DIR/detect_video_scenes.sh"

count_frames() {
  local dir="$1"
  find "$dir" -maxdepth 1 -type f -iname 'frame_*.jpg' | wc -l | tr -d '[:space:]'
}

should_run_step() {
  local step="$1"
  local current_frames="$2"

  case "$step" in
    1_remove_black_frames.sh|2_remove_white_frames.sh)
      (( current_frames > 156 ))
      ;;
    3_remove_bad_frames.sh|4_remove_similar_frames.sh)
      (( current_frames > 148 ))
      ;;
    *)
      return 0
      ;;
  esac
}

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "[ERRORE] Directory non trovata: $ROOT_DIR" >&2
  exit 1
fi

ROOT_DIR="$(realpath "$ROOT_DIR")"

if [[ ! -f "$SCENE_SCRIPT" ]]; then
  echo "[ERRORE] Script non trovato: $SCENE_SCRIPT" >&2
  exit 1
fi

if [[ ! -x "$SCENE_SCRIPT" ]]; then
  echo "[ERRORE] Script non eseguibile: $SCENE_SCRIPT" >&2
  echo "Esegui: chmod +x \"$SCENE_SCRIPT\"" >&2
  exit 1
fi

STEPS=(
  "1_remove_black_frames.sh"
  "2_remove_white_frames.sh"
  "3_remove_bad_frames.sh"
  "4_remove_similar_frames.sh"
  "5_rename_frame.sh"
  "6_generate_descriptions.sh"
  "7_generate_narrative.sh"
)

for STEP in "${STEPS[@]}"; do
  if [[ ! -f "$SCRIPT_DIR/$STEP" ]]; then
    echo "[ERRORE] Step non trovato: $SCRIPT_DIR/$STEP" >&2
    exit 1
  fi
  if [[ ! -x "$SCRIPT_DIR/$STEP" ]]; then
    echo "[ERRORE] Step non eseguibile: $SCRIPT_DIR/$STEP" >&2
    echo "Esegui: chmod +x \"$SCRIPT_DIR/$STEP\"" >&2
    exit 1
  fi
done

mapfile -d '' VIDEOS < <(
  find "$ROOT_DIR" -maxdepth 1 -type f \
    \( -iname '*.mp4' -o -iname '*.mkv' -o -iname '*.avi' -o -iname '*.mov' -o -iname '*.webm' \) \
    -print0 | sort -z
)

TOTAL="${#VIDEOS[@]}"

if (( TOTAL == 0 )); then
  echo "[WARN] Nessun video trovato in: $ROOT_DIR"
  exit 0
fi

echo "[INFO] Video trovati: $TOTAL"
echo ""

INDEX=0
FAILED=0
DONE=0

for VIDEO in "${VIDEOS[@]}"; do
  INDEX=$((INDEX + 1))

  BASE="$(basename "$VIDEO")"
  NAME="${BASE%.*}"
  VIDEO_DIR="$ROOT_DIR/$NAME"
  FRAMES_DIR="$VIDEO_DIR/frames"

  mkdir -p "$VIDEO_DIR" "$FRAMES_DIR"

  echo "============================================================"
  echo "[INFO] Video $INDEX/$TOTAL"
  echo "[INFO] Input video : $VIDEO"
  echo "[INFO] Work dir    : $VIDEO_DIR"
  echo "[INFO] Frames dir  : $FRAMES_DIR"
  echo "============================================================"

  FRAME_COUNT=""
  if ! FRAME_COUNT="$("$SCENE_SCRIPT" "$VIDEO" "$FRAMES_DIR")"; then
    echo "[ERRORE] Estrazione frame fallita su: $VIDEO" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  FRAME_COUNT="$(printf '%s' "$FRAME_COUNT" | tail -n 1 | tr -d '[:space:]')"

  if [[ -z "$FRAME_COUNT" || ! "$FRAME_COUNT" =~ ^[0-9]+$ ]]; then
    echo "[ERRORE] Conteggio frame non valido per: $VIDEO (ottenuto: $FRAME_COUNT)" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  if (( FRAME_COUNT == 0 )); then
    echo "[ERRORE] Nessun frame disponibile per: $VIDEO" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  echo "[INFO] Frame iniziali: $FRAME_COUNT"

  for STEP in "${STEPS[@]}"; do
    CURRENT_FRAMES="$(count_frames "$FRAMES_DIR")"

    if [[ -z "$CURRENT_FRAMES" || ! "$CURRENT_FRAMES" =~ ^[0-9]+$ ]]; then
      echo "[ERRORE] Conteggio frame corrente non valido in: $FRAMES_DIR" >&2
      FAILED=$((FAILED + 1))
      continue 2
    fi

    if ! should_run_step "$STEP" "$CURRENT_FRAMES"; then
      echo "[INFO] Skip $STEP: frame correnti = $CURRENT_FRAMES, sotto soglia"
      continue
    fi

    echo "[INFO] Eseguo $STEP su $FRAMES_DIR (frame correnti: $CURRENT_FRAMES)"
    if ! "$SCRIPT_DIR/$STEP" "$FRAMES_DIR"; then
      echo "[ERRORE] Fallito $STEP su: $FRAMES_DIR" >&2
      FAILED=$((FAILED + 1))
      continue 2
    fi
  done

  FINAL_FRAMES="$(count_frames "$FRAMES_DIR")"
  echo "[OK] Completato: $VIDEO"
  echo "[INFO] Frame finali rimasti: $FINAL_FRAMES"
  echo ""

  DONE=$((DONE + 1))
done

echo "============================================================"
echo "[INFO] Fine elaborazione"
echo "[INFO] Video totali      : $TOTAL"
echo "[INFO] Video completati  : $DONE"
echo "[INFO] Video con errori  : $FAILED"
echo "============================================================"

if (( FAILED > 0 )); then
  exit 1
fi

exit 0