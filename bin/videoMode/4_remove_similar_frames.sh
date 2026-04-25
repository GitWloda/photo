#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib_common.sh"
load_config

DIR="$(resolve_dir "${1:-}")"
DIR="$(realpath "$DIR")"

WINDOW_SIZE="${WINDOW_SIZE:-5}"
HASH_WIDTH="${HASH_WIDTH:-9}"
HASH_HEIGHT="${HASH_HEIGHT:-8}"
SIMILARITY_MAX_DISTANCE="${SIMILARITY_MAX_DISTANCE:-6}"

require_command magick
ensure_scarti_dir "$DIR"

section_start "STEP 4 - Rimozione frame simili"
info "Directory: $DIR"
info "Configurazione similarita:"
info "- Gruppi fissi: $WINDOW_SIZE frame"
info "- dHash: ${HASH_WIDTH}x${HASH_HEIGHT}"
info "- Hamming max distance: $SIMILARITY_MAX_DISTANCE"

mapfile -d '' files < <(list_frames "$DIR")
total=${#files[@]}
removed=0
hashed=0

if (( total < 2 )); then
    info "Troppo pochi frame per il confronto."
    exit 0
fi

image_dhash() {
    local img="$1"
    local width="$HASH_WIDTH"
    local height="$HASH_HEIGHT"
    local expected_count=$((width * height))
    local raw
    local -a pixels=()
    local out=""
    local x y idx_left idx_right left right

    raw="$(
        magick "$img" \
            -colorspace Gray \
            -resize "${width}x${height}!" \
            -depth 8 \
            gray:- 2>/dev/null | od -An -v -tu1 | tr '\n' ' '
    )"

    [[ -n "${raw// /}" ]] || return 1

    read -r -a pixels <<< "$raw"

    if (( ${#pixels[@]} != expected_count )); then
        return 1
    fi

    for ((y=0; y<height; y++)); do
        for ((x=0; x<width-1; x++)); do
            idx_left=$((y * width + x))
            idx_right=$((idx_left + 1))
            left="${pixels[idx_left]}"
            right="${pixels[idx_right]}"

            if (( left < right )); then
                out+="1"
            else
                out+="0"
            fi
        done
    done

    printf '%s\n' "$out"
}

hamming_distance() {
    local h1="$1"
    local h2="$2"
    local dist=0
    local i
    local len="${#h1}"

    if [[ -z "$h1" || -z "$h2" || "${#h1}" -ne "${#h2}" ]]; then
        printf '9999\n'
        return 0
    fi

    for ((i=0; i<len; i++)); do
        if [[ "${h1:i:1}" != "${h2:i:1}" ]]; then
            dist=$((dist + 1))
        fi
    done

    printf '%s\n' "$dist"
}

declare -a hashes
declare -a scores

for ((i=0; i<total; i++)); do
    img="${files[i]}"
    ((hashed+=1))
    progress_line "$hashed" "$total" "Pre-hash frame"

    if hash_value="$(image_dhash "$img")"; then
        hashes[i]="$hash_value"
    else
        hashes[i]=""
    fi

    if score_value="$(quality_score_common "$img" 2>/dev/null)"; then
        scores[i]="$score_value"
    else
        scores[i]="0"
    fi
done

progress_done

group_count=$(( (total + WINDOW_SIZE - 1) / WINDOW_SIZE ))
group_index=0

for ((group_start=0; group_start<total; group_start+=WINDOW_SIZE)); do
    group_index=$((group_index + 1))
    group_end=$((group_start + WINDOW_SIZE - 1))
    if (( group_end >= total )); then
        group_end=$((total - 1))
    fi

    info "Analizzo gruppo $group_index/$group_count: frame $((group_start + 1))-$((group_end + 1))"

    for ((i=group_start; i<=group_end; i++)); do
        img_i="${files[i]}"

        [[ -e "$img_i" ]] || continue
        [[ -n "${hashes[i]}" ]] || continue

        for ((j=i+1; j<=group_end; j++)); do
            img_j="${files[j]}"

            [[ -e "$img_j" ]] || continue
            [[ -n "${hashes[j]}" ]] || continue

            dist="$(hamming_distance "${hashes[i]}" "${hashes[j]}")"

            if (( dist <= SIMILARITY_MAX_DISTANCE )); then
                if awk -v a="${scores[j]}" -v b="${scores[i]}" 'BEGIN { exit !(a > b) }'; then
                    move_to_scarti "$DIR" "$img_i" "simile_d${dist}"
                    removed=$((removed + 1))
                    break
                else
                    move_to_scarti "$DIR" "$img_j" "simile_d${dist}"
                    removed=$((removed + 1))
                fi
            fi
        done
    done
done

remaining="$(find "$DIR" -maxdepth 1 -type f -iname "$FRAME_GLOB" | wc -l | tr -d '[:space:]')"

info "Frame iniziali: $total"
info "Frame simili spostati: $removed"
info "Frame rimasti: $remaining"
info "Scarti in: $DIR/$SCARTI_SUBDIR"

exit 0