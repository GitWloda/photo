#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.."; pwd)"

"$ROOT_DIR/db/init_db.sh"
"$ROOT_DIR/bin/update_db.sh"
"$ROOT_DIR/bin/cleanup_deleted.sh"
"$ROOT_DIR/bin/videoMode/startall.sh /mnt/d/projects/newRDMD5IA/foto"