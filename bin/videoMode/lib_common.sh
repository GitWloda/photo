#!/usr/bin/env bash

SCRIPT_DIR_COMMON="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE_DEFAULT="$SCRIPT_DIR_COMMON/frame_cleaner.conf"
PROJECT_ROOT="$(cd "$SCRIPT_DIR_COMMON/../.." && pwd)"

load_config() {
    local config_file="${FRAME_CLEANER_CONFIG:-$CONFIG_FILE_DEFAULT}"

    if [[ -f "$config_file" ]]; then
        # shellcheck source=/dev/null
        source "$config_file"
    fi

    DEFAULT_DIR="${DEFAULT_DIR:-.}"
    FRAME_GLOB="${FRAME_GLOB:-frame_*.jpg}"
    SCARTI_SUBDIR="${SCARTI_SUBDIR:-scarti}"

    BLACK_THRESHOLD="${BLACK_THRESHOLD:-10}"
    BLACK_PCT_MIN="${BLACK_PCT_MIN:-80}"

    WHITE_THRESHOLD="${WHITE_THRESHOLD:-90}"
    WHITE_PCT_MIN="${WHITE_PCT_MIN:-80}"

    DARK_THRESHOLD="${DARK_THRESHOLD:-10}"
    DARK_PCT_MAX="${DARK_PCT_MAX:-80}"
    BLUR_MIN_SCORE="${BLUR_MIN_SCORE:-8}"

    QS_WEIGHT_SHARPNESS="${QS_WEIGHT_SHARPNESS:-0.60}"
    QS_WEIGHT_CONTRAST="${QS_WEIGHT_CONTRAST:-0.30}"
    QS_WEIGHT_MEAN="${QS_WEIGHT_MEAN:-0.10}"
    QS_WEIGHT_DARK="${QS_WEIGHT_DARK:-0.70}"

    WINDOW_SIZE="${WINDOW_SIZE:-5}"
    PARALLEL_WORKERS="${PARALLEL_WORKERS:-4}"

    HASH_WIDTH="${HASH_WIDTH:-9}"
    HASH_HEIGHT="${HASH_HEIGHT:-8}"
    SIMILARITY_MAX_DISTANCE="${SIMILARITY_MAX_DISTANCE:-6}"

    VERBOSE="${VERBOSE:-1}"
    PROGRESS_BAR_WIDTH="${PROGRESS_BAR_WIDTH:-28}"

    DATA_ROOT="${DATA_ROOT:-$PROJECT_ROOT/data}"
    WORK_ROOT="${WORK_ROOT:-$DATA_ROOT/work}"
    CLEAN_SCARTI_ON_SUCCESS="${CLEAN_SCARTI_ON_SUCCESS:-1}"

    OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
    OLLAMA_VISION_MODEL="${OLLAMA_VISION_MODEL:-llava:7b}"
    LANGUAGE="${LANGUAGE:-italiano}"
    OLLAMA_BATCH_SIZE="${OLLAMA_BATCH_SIZE:-4}"
    OLLAMA_TIMEOUT="${OLLAMA_TIMEOUT:-240}"
    OLLAMA_TEMPERATURE="${OLLAMA_TEMPERATURE:-0.2}"
}

require_command() {
    local cmd="$1"
    command -v "$cmd" >/dev/null 2>&1 || {
        echo "$cmd non trovato" >&2
        exit 1
    }
}

ts() {
    date '+%H:%M:%S'
}

log() {
    if [[ "${VERBOSE:-1}" == "1" ]]; then
        printf '[%s] %s\n' "$(ts)" "$*"
    fi
}

info() {
    printf '[%s] %s\n' "$(ts)" "$*"
}

warn() {
    printf '[%s] [WARN] %s\n' "$(ts)" "$*" >&2
}

error() {
    printf '[%s] [ERRORE] %s\n' "$(ts)" "$*" >&2
}

float_ge() {
    local a="$1"
    local b="$2"
    awk -v a="$a" -v b="$b" 'BEGIN { exit !(a >= b) }'
}

float_le() {
    local a="$1"
    local b="$2"
    awk -v a="$a" -v b="$b" 'BEGIN { exit !(a <= b) }'
}

resolve_dir() {
    local cli_dir="${1:-}"
    if [[ -n "$cli_dir" ]]; then
        echo "$cli_dir"
    else
        echo "$DEFAULT_DIR"
    fi
}

ensure_scarti_dir() {
    local dir="$1"
    mkdir -p "$dir/$SCARTI_SUBDIR"
}

cleanup_scarti_dir() {
    local dir="$1"
    if [[ "${CLEAN_SCARTI_ON_SUCCESS}" == "1" && -d "$dir/$SCARTI_SUBDIR" ]]; then
        rm -rf "$dir/$SCARTI_SUBDIR"
        info "Scarti rimossi: $dir/$SCARTI_SUBDIR"
    fi
}

list_frames() {
    local dir="$1"
    find "$dir" -maxdepth 1 -type f -iname "$FRAME_GLOB" -print0 | sort -zV
}

move_to_scarti() {
    local dir="$1"
    local img="$2"
    local reason="$3"

    [[ -e "$img" ]] || return 1

    local base
    base="$(basename "$img")"

    log "Sposto $base -> $dir/$SCARTI_SUBDIR ($reason)"
    mv "$img" "$dir/$SCARTI_SUBDIR/$base"
}

image_blackpct() {
    local img="$1"
    magick "$img" -colorspace Gray -threshold "${BLACK_THRESHOLD}%" -negate \
        -format "%[fx:100*mean]" info:
}

image_whitepct() {
    local img="$1"
    magick "$img" -colorspace Gray -threshold "${WHITE_THRESHOLD}%" \
        -format "%[fx:100*mean]" info:
}

image_darkpct() {
    local img="$1"
    magick "$img" -colorspace Gray -threshold "${DARK_THRESHOLD}%" -negate \
        -format "%[fx:100*mean]" info:
}

image_sharpness() {
    local img="$1"
    magick "$img" -colorspace Gray -morphology Convolve Laplacian:0 \
        -format "%[standard-deviation]" info:
}

image_contrast() {
    local img="$1"
    magick "$img" -colorspace Gray \
        -format "%[standard-deviation]" info:
}

image_mean() {
    local img="$1"
    magick "$img" -colorspace Gray \
        -format "%[fx:100*mean]" info:
}

quality_score_common() {
    local img="$1"
    local sharpness contrast mean darkpct

    sharpness="$(image_sharpness "$img")"
    contrast="$(image_contrast "$img")"
    mean="$(image_mean "$img")"
    darkpct="$(image_darkpct "$img")"

    awk \
        -v s="$sharpness" \
        -v c="$contrast" \
        -v m="$mean" \
        -v d="$darkpct" \
        -v ws="$QS_WEIGHT_SHARPNESS" \
        -v wc="$QS_WEIGHT_CONTRAST" \
        -v wm="$QS_WEIGHT_MEAN" \
        -v wd="$QS_WEIGHT_DARK" \
        'BEGIN {
            print (s*ws) + (c*wc) + (m*wm) - (d*wd)
        }'
}

progress_line() {
    local current="$1"
    local total="$2"
    local label="${3:-Progresso}"
    local width="${PROGRESS_BAR_WIDTH:-28}"

    (( total <= 0 )) && total=1
    (( current < 0 )) && current=0
    (( current > total )) && current="$total"

    local filled=$(( current * width / total ))
    local empty=$(( width - filled ))
    local percent=$(( current * 100 / total ))

    local done_bar todo_bar
    done_bar="$(printf "%${filled}s" "")"
    todo_bar="$(printf "%${empty}s" "")"

    printf '\r[%s] %-18s [%s%s] %3d%% (%d/%d)' \
        "$(ts)" \
        "$label" \
        "${done_bar// /#}" \
        "${todo_bar// /-}" \
        "$percent" \
        "$current" \
        "$total"
}

progress_done() {
    printf '\n'
}

section_start() {
    info "--------------------------------------------------"
    info "$1"
    info "--------------------------------------------------"
}

get_video_slug() {
    local video="$1"
    local base
    base="$(basename "$video")"
    printf '%s\n' "${base%.*}"
}

get_video_work_dir() {
    local video="$1"
    local slug
    slug="$(get_video_slug "$video")"
    printf '%s/%s\n' "$WORK_ROOT" "$slug"
}