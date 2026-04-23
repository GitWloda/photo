#!/usr/bin/env bash
set -euo pipefail

DIR="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/1_remove_black_frames.sh" ${DIR:+"$DIR"}
"$SCRIPT_DIR/2_remove_white_frames.sh" ${DIR:+"$DIR"}
"$SCRIPT_DIR/3_remove_bad_frames.sh" ${DIR:+"$DIR"}
"$SCRIPT_DIR/4_remove_similar_frames.sh" ${DIR:+"$DIR"}
