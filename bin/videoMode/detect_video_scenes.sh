#!/usr/bin/env bash
set -euo pipefail

INPUT="${1:-}"
OUTDIR="${2:-}"

if [[ -z "$INPUT" ]]; then
  echo "Uso: $0 <video.mp4> [outdir]" >&2
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "[ERRORE] Video non trovato: $INPUT" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[ERRORE] ffmpeg non trovato nel PATH." >&2
  exit 1
fi

if [[ -z "$OUTDIR" ]]; then
  OUTDIR="./frames"
fi

mkdir -p "$OUTDIR"
rm -f "$OUTDIR"/*.jpg

ffmpeg -hide_banner -y -i "$INPUT" \
  -vf "fps=2,mpdecimate=hi=64*8:lo=64*5:frac=0.10,scale='if(gt(iw,1280),1280,iw)':'-2'" \
  -fps_mode vfr \
  -qscale:v 2 \
  "$OUTDIR/frame_%05d.jpg"

COUNT="$(find "$OUTDIR" -maxdepth 1 -type f -iname 'frame_*.jpg' | wc -l)"
echo "[OK] Frame generati: $COUNT"
echo "[OK] Directory output: $OUTDIR"
