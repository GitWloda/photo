#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib_common.sh"
load_config

ROOT_DIR="${1:-.}"
ROOT_DIR="$(realpath "$ROOT_DIR")"

SCENE_SCRIPT="$SCRIPT_DIR/detect_video_scenes.sh"

[[ -d "$ROOT_DIR" ]] || { error "Directory non trovata: $ROOT_DIR"; exit 1; }
[[ -f "$SCENE_SCRIPT" ]] || { error "Script non trovato: $SCENE_SCRIPT"; exit 1; }
[[ -x "$SCENE_SCRIPT" ]] || { error "Script non eseguibile: $SCENE_SCRIPT"; exit 1; }

mkdir -p "$WORK_ROOT"

mapfile -d '' VIDEOS < <(
  find "$ROOT_DIR" -maxdepth 1 -type f \
    \( -iname '*.mp4' -o -iname '*.mkv' -o -iname '*.avi' -o -iname '*.mov' -o -iname '*.webm' \) \
    -print0 | sort -z
)

TOTAL="${#VIDEOS[@]}"

if (( TOTAL == 0 )); then
  warn "Nessun video trovato in: $ROOT_DIR"
  exit 0
fi

echo "[INFO] Video trovati: $TOTAL"
echo

INDEX=0
FAILED=0
DONE=0

for VIDEO in "${VIDEOS[@]}"; do
  INDEX=$((INDEX + 1))

  WORK_DIR="$(get_video_work_dir "$VIDEO")"
  FRAMES_DIR="$WORK_DIR/frames"

  mkdir -p "$WORK_DIR"
  mkdir -p "$FRAMES_DIR"

  echo "============================================================"
  echo "[INFO] Video $INDEX/$TOTAL"
  echo "[INFO] Input video : $VIDEO"
  echo "[INFO] Work dir    : $WORK_DIR"
  echo "[INFO] Frames dir  : $FRAMES_DIR"
  echo "============================================================"

  if ! "$SCENE_SCRIPT" "$VIDEO" "$FRAMES_DIR"; then
    error "Estrazione frame fallita su: $VIDEO"
    FAILED=$((FAILED + 1))
    continue
  fi

  CURRENT_COUNT="$(find "$FRAMES_DIR" -maxdepth 1 -type f -iname "$FRAME_GLOB" | wc -l | tr -d '[:space:]')"
  info "Frame trovati dopo estrazione: $CURRENT_COUNT"

  if [[ "$CURRENT_COUNT" -eq 0 ]]; then
    warn "Nessun frame generato per: $VIDEO"
    FAILED=$((FAILED + 1))
    continue
  fi

  for STEP in \
    1_remove_black_frames.sh \
    2_remove_white_frames.sh \
    3_remove_bad_frames.sh \
    4_remove_similar_frames.sh \
    6_generate_descriptions.sh \
    7_generate_narrative.sh
  do
    CURRENT_COUNT="$(find "$FRAMES_DIR" -maxdepth 1 -type f -iname "$FRAME_GLOB" | wc -l | tr -d '[:space:]')"
    echo "[INFO] Eseguo $STEP su $FRAMES_DIR (frame correnti: $CURRENT_COUNT)"

    if ! "$SCRIPT_DIR/$STEP" "$FRAMES_DIR"; then
      error "Fallito $STEP su: $FRAMES_DIR"
      FAILED=$((FAILED + 1))
      continue 2
    fi
  done

  cleanup_scarti_dir "$FRAMES_DIR"

  echo "[OK] Completato: $VIDEO"
  echo
  DONE=$((DONE + 1))
done

echo "============================================================"
echo "[INFO] Fine elaborazione"
echo "[INFO] Video totali      : $TOTAL"
echo "[INFO] Video completati  : $DONE"
echo "[INFO] Video con errori  : $FAILED"
echo "============================================================"

exit 0