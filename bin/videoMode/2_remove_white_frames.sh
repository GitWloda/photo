#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib_common.sh"

load_config

DIR="$(resolve_dir "${1:-}")"

require_command magick
ensure_scarti_dir "$DIR"

section_start "STEP 2 - Rimozione frame bianchi"
info "Directory: $DIR"

mapfile -d '' files < <(list_frames "$DIR")
total=${#files[@]}
removed=0
processed=0

if (( total == 0 )); then
    info "Nessun frame trovato."
    exit 0
fi

for img in "${files[@]}"; do
    ((processed+=1))
    progress_line "$processed" "$total" "Frame bianchi"

    [[ -e "$img" ]] || continue

    white_pct="$(image_whitepct "$img")"
    if float_ge "$white_pct" "$WHITE_PCT_MIN"; then
        move_to_scarti "$DIR" "$img" "bianco_${white_pct}%"
        ((removed+=1))
    fi
done

progress_done
info "Frame analizzati: $processed"
info "Frame bianchi spostati: $removed"
info "Scarti in: $DIR/$SCARTI_SUBDIR"