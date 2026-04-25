#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib_common.sh"

type load_config >/dev/null 2>&1 || {
    echo "Errore: load_config non trovata. Controlla lib_common.sh" >&2
    exit 1
}

load_config

DIR="$(resolve_dir "${1:-}")"

require_command magick
ensure_scarti_dir "$DIR"

declare -A deleted
declare -A dhash_cache
declare -A quality_cache

compute_dhash() {
    local img="$1"

    if [[ -n "${dhash_cache[$img]:-}" ]]; then
        echo "${dhash_cache[$img]}"
        return
    fi

    local matrix
    local -A px=()
    local hash=""
    local x y left right bit

    matrix="$(
        magick "$img" \
            -colorspace Gray \
            -resize "${HASH_WIDTH}x${HASH_HEIGHT}!" \
            -depth 8 txt:- 2>/dev/null \
        | awk -F'[:,()]' '
            /^[ ]*[0-9]+,[0-9]+:/ {
                gsub(/ /, "", $0)
                split($0, a, /[:,()]/)
                print a[1], a[2], a[4]
            }
        '
    )"

    while read -r x y val; do
        [[ -z "${x:-}" ]] && continue
        px["$x,$y"]="$val"
    done <<< "$matrix"

    for (( y=0; y<HASH_HEIGHT; y++ )); do
        for (( x=0; x<HASH_WIDTH-1; x++ )); do
            left="${px["$x,$y"]:-0}"
            right="${px["$((x+1)),$y"]:-0}"

            if (( left > right )); then
                bit="1"
            else
                bit="0"
            fi

            hash+="$bit"
        done
    done

    dhash_cache["$img"]="$hash"
    echo "$hash"
}

hamming_distance() {
    local h1="$1"
    local h2="$2"
    local len="${#h1}"
    local i dist=0

    for (( i=0; i<len; i++ )); do
        [[ "${h1:i:1}" != "${h2:i:1}" ]] && ((dist+=1))
    done

    echo "$dist"
}

hash_similarity() {
    local a="$1"
    local b="$2"
    local h1 h2 dist bits sim

    h1="$(compute_dhash "$a")"
    h2="$(compute_dhash "$b")"

    bits="${#h1}"
    (( bits <= 0 )) && bits=1

    dist="$(hamming_distance "$h1" "$h2")"

    sim="$(
        awk -v d="$dist" -v bits="$bits" 'BEGIN {
            v = 1 - (d / bits)
            if (v < 0) v = 0
            if (v > 1) v = 1
            printf "%.6f", v
        }'
    )"

    printf '%s %s\n' "$dist" "$sim"
}

quality_score() {
    local img="$1"

    if [[ -n "${quality_cache[$img]:-}" ]]; then
        echo "${quality_cache[$img]}"
        return
    fi

    quality_cache["$img"]="$(quality_score_common "$img")"
    echo "${quality_cache[$img]}"
}

count_total_pairs() {
    local count="$1"
    local group_size="$2"
    local total_pairs=0
    local start end n

    for (( start=0; start<count; start+=group_size )); do
        end=$((start + group_size - 1))
        (( end >= count )) && end=$((count - 1))
        n=$((end - start + 1))
        total_pairs=$((total_pairs + (n * (n - 1) / 2)))
    done

    echo "$total_pairs"
}

compare_group_pairs() {
    local start="$1"
    local end="$2"
    local i j a b qa qb
    local hash_data dist sim

    info "Gruppo fisso: frame $((start + 1))-$((end + 1))"

    for (( i=start; i<=end; i++ )); do
        a="${files[$i]}"
        [[ -e "$a" ]] || continue
        [[ -n "${deleted[$a]:-}" ]] && continue

        for (( j=i+1; j<=end; j++ )); do
            b="${files[$j]}"
            [[ -e "$b" ]] || continue
            [[ -n "${deleted[$b]:-}" ]] && continue

            ((pair_done+=1))
            progress_line "$pair_done" "$pair_total" "Similarita"

            hash_data="$(hash_similarity "$a" "$b")"
            read -r dist sim <<< "$hash_data"

            log "Confronto: $(basename "$a") vs $(basename "$b") -> hamming=$dist similarity=$sim"

            if (( dist <= SIMILARITY_MAX_DISTANCE )) || float_ge "$sim" "$SIMILARITY_THRESHOLD"; then
                qa="$(quality_score "$a")"
                qb="$(quality_score "$b")"

                if [[ "$USE_QUALITY_SCORE_FOR_TIEBREAK" == "1" ]]; then
                    if float_ge "$qa" "$qb"; then
                        move_to_scarti "$DIR" "$b" "simile_a_$(basename "$a")_hamming_${dist}_sim_${sim}"
                        deleted["$b"]=1
                        ((removed+=1))
                    else
                        move_to_scarti "$DIR" "$a" "simile_a_$(basename "$b")_hamming_${dist}_sim_${sim}"
                        deleted["$a"]=1
                        ((removed+=1))
                        break
                    fi
                else
                    move_to_scarti "$DIR" "$b" "simile_a_$(basename "$a")_hamming_${dist}_sim_${sim}"
                    deleted["$b"]=1
                    ((removed+=1))
                fi
            fi
        done
    done
}

section_start "STEP 4 - Rimozione frame simili"
info "Directory: $DIR"

mapfile -d '' files < <(list_frames "$DIR")
count=${#files[@]}
removed=0
pair_done=0
pair_total="$(count_total_pairs "$count" "$WINDOW_SIZE")"

if (( count == 0 )); then
    info "Nessun frame trovato."
    exit 0
fi

if (( pair_total == 0 )); then
    info "Non ci sono abbastanza frame per confronti di similarita."
    exit 0
fi

info "Configurazione similarita:"
info "- Gruppi fissi: $WINDOW_SIZE frame"
info "- dHash: ${HASH_WIDTH}x${HASH_HEIGHT}"
info "- Hamming max distance: $SIMILARITY_MAX_DISTANCE"
info "- Similarity threshold: $SIMILARITY_THRESHOLD"
info "- Tie-break qualità: $USE_QUALITY_SCORE_FOR_TIEBREAK"

for (( start=0; start<count; start+=WINDOW_SIZE )); do
    end=$((start + WINDOW_SIZE - 1))
    (( end >= count )) && end=$((count - 1))
    compare_group_pairs "$start" "$end"
done

progress_done
info "Confronti completati: $pair_done"
info "Frame simili spostati: $removed"
info "Scarti in: $DIR/$SCARTI_SUBDIR"