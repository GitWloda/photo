#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib_common.sh"
load_config

INPUT="${1:-}"
OUTDIR="${2:-}"

[[ -n "$INPUT" ]] || { error "Uso: $0 <video.mp4> [outdir]"; exit 1; }
[[ -f "$INPUT" ]] || { error "Video non trovato: $INPUT"; exit 1; }

require_command ffmpeg
require_command ffprobe

if [[ -z "$OUTDIR" ]]; then
  OUTDIR="./frames"
fi

mkdir -p "$OUTDIR"
find "$OUTDIR" -maxdepth 1 -type f -iname "$FRAME_GLOB" -delete

DURATION_RAW="$(
  ffprobe -v error \
    -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 \
    "$INPUT" 2>/dev/null || true
)"

[[ -n "$DURATION_RAW" ]] || { error "Impossibile leggere la durata del video"; exit 1; }

DURATION_SEC="$(awk -v d="$DURATION_RAW" 'BEGIN { printf "%d", d + 0.5 }')"

FPS_VALUE="2"
if (( DURATION_SEC < 15 )); then
  FPS_VALUE="10"
elif (( DURATION_SEC < 30 )); then
  FPS_VALUE="8"
elif (( DURATION_SEC < 60 )); then
  FPS_VALUE="6"
elif (( DURATION_SEC < 300 )); then
  FPS_VALUE="4"
fi

info "Estrazione frame da: $INPUT"
info "Output directory    : $OUTDIR"
info "Durata video        : ${DURATION_SEC}s"
info "FPS campionamento   : $FPS_VALUE"

ffmpeg -hide_banner -y -i "$INPUT" \
  -vf "fps=${FPS_VALUE},mpdecimate=hi=64*8:lo=64*5:frac=0.10,scale='if(gt(iw,960),960,iw)':'-2'" \
  -fps_mode vfr \
  -qscale:v 2 \
  "$OUTDIR/frame_%05d.jpg"

COUNT="$(find "$OUTDIR" -maxdepth 1 -type f -iname "$FRAME_GLOB" | wc -l | tr -d '[:space:]')"
info "Frame generati: $COUNT"
info "Directory output: $OUTDIR"

exit 0