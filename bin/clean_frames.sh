#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAME_CLEANER_DIR="$ROOT_DIR/bin/frame_cleaner"

if [[ ! -d "$FRAME_CLEANER_DIR" ]]; then
    echo "Directory frame cleaner non trovata: $FRAME_CLEANER_DIR" >&2
    exit 1
fi

exec "$FRAME_CLEANER_DIR/startall.sh" "${1:-}"
