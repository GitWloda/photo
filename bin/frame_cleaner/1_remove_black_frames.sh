#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib_common.sh"

load_config

DIR="$(resolve_dir "${1:-}")"

require_command magick
ensure_scarti_dir "$DIR"

section_start "STEP 1 - Rimozione frame neri"
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
    progress_line "$processed" "$total" "Frame neri"

    [[ -e "$img" ]] || continue

    black_pct="$(image_blackpct "$img")"
    if float_ge "$black_pct" "$BLACK_PCT_MIN"; then
        move_to_scarti "$DIR" "$img" "nero_${black_pct}%"
        ((removed+=1))
    fi
done

progress_done
info "Frame analizzati: $processed"
info "Frame neri spostati: $removed"
info "Scarti in: $DIR/$SCARTI_SUBDIR"
