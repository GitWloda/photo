#!/usr/bin/env bash
set -euo pipefail

INPUT="${1:-}"
OUTDIR="${2:-}"

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "$*"
  exit 1
}

if [[ -z "$INPUT" ]]; then
  die "Uso: $0 <video.mp4> [outdir]"
fi

if [[ ! -f "$INPUT" ]]; then
  die "[ERRORE] Video non trovato: $INPUT"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  die "[ERRORE] ffmpeg non trovato nel PATH."
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  die "[ERRORE] ffprobe non trovato nel PATH."
fi

if [[ -z "$OUTDIR" ]]; then
  OUTDIR="./frames"
fi

mkdir -p "$OUTDIR"
find "$OUTDIR" -maxdepth 1 -type f -iname 'frame_*.jpg' -delete

DURATION_RAW="$(
  ffprobe -v error \
    -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 \
    "$INPUT" 2>/dev/null || true
)"

DURATION_SEC="$(awk -v d="$DURATION_RAW" 'BEGIN { printf "%d", d + 0.5 }')"

FPS_VALUE="2"

if (( DURATION_SEC < 15 )); then
  FPS_VALUE="8"
elif (( DURATION_SEC < 30 )); then
  FPS_VALUE="6"
elif (( DURATION_SEC < 60 )); then
  FPS_VALUE="4"
fi

log "[INFO] Estrazione frame da: $INPUT"
log "[INFO] Durata video: ${DURATION_SEC}s"
log "[INFO] FPS: $FPS_VALUE"

ffmpeg -hide_banner -y -i "$INPUT" \
  -vf "fps=${FPS_VALUE},mpdecimate=hi=64*8:lo=64*5:frac=0.10,scale='if(gt(iw,1280),1280,iw)':'-2'" \
  -fps_mode vfr \
  -qscale:v 2 \
  "$OUTDIR/frame_%05d.jpg"

COUNT="$(find "$OUTDIR" -maxdepth 1 -type f -iname 'frame_*.jpg' | wc -l | tr -d '[:space:]')"
log "[OK] Frame generati: $COUNT"
log "[OK] Directory output: $OUTDIR"

printf '%s\n' "$COUNT"