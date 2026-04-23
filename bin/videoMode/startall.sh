#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENE_SCRIPT="$SCRIPT_DIR/detect_video_scenes.sh"

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "[ERRORE] Directory non trovata: $ROOT_DIR" >&2
  exit 1
fi

if [[ ! -f "$SCENE_SCRIPT" ]]; then
  echo "[ERRORE] Script non trovato: $SCENE_SCRIPT" >&2
  echo "Crea detect_video_scenes.sh nella cartella della repo cleanerFrame." >&2
  exit 1
fi

if [[ ! -x "$SCENE_SCRIPT" ]]; then
  echo "[ERRORE] Script non eseguibile: $SCENE_SCRIPT" >&2
  echo "Esegui: chmod +x $SCENE_SCRIPT" >&2
  exit 1
fi

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
echo

INDEX=0
FAILED=0

for VIDEO in "${VIDEOS[@]}"; do
  INDEX=$((INDEX + 1))

  BASE="$(basename "$VIDEO")"
  NAME="${BASE%.*}"
  VIDEO_DIR="$ROOT_DIR/$NAME"
  FRAMES_DIR="$VIDEO_DIR/frames"

  mkdir -p "$VIDEO_DIR"

  echo "============================================================"
  echo "[INFO] Video $INDEX/$TOTAL"
  echo "[INFO] Input video : $VIDEO"
  echo "[INFO] Work dir    : $VIDEO_DIR"
  echo "[INFO] Frames dir  : $FRAMES_DIR"
  echo "============================================================"

  if ! "$SCENE_SCRIPT" "$VIDEO" "$FRAMES_DIR"; then
    echo "[ERRORE] Estrazione frame fallita su: $VIDEO" >&2
    FAILED=$((FAILED + 1))
    continue
  fi

  if ! find "$FRAMES_DIR" -maxdepth 1 -type f -iname 'frame_*.jpg' | grep -q .; then
    echo "[WARN] Nessun frame generato per: $VIDEO"
    FAILED=$((FAILED + 1))
    continue
  fi

  for STEP in \
    1_remove_black_frames.sh \
    2_remove_white_frames.sh \
    3_remove_bad_frames.sh \
    4_remove_similar_frames.sh \
    5_generate_descriptions.sh \
    6_generate_narrative.sh
  do
    echo "[INFO] Eseguo $STEP su $FRAMES_DIR"
    if ! "$SCRIPT_DIR/$STEP" "$FRAMES_DIR"; then
      echo "[ERRORE] Fallito $STEP su: $FRAMES_DIR" >&2
      FAILED=$((FAILED + 1))
      continue 2
    fi
  done

  echo "[OK] Completato: $VIDEO"
  echo
done

echo "============================================================"
echo "[INFO] Fine elaborazione"
echo "[INFO] Video totali: $TOTAL"
echo "[INFO] Video con errori: $FAILED"
echo "============================================================"
