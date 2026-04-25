#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Uso: $0 <file>" >&2
  exit 1
fi

FILE="$1"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$FILE" | awk '{print $1}'
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$FILE" | awk '{print $1}'
else
  echo "Errore: né sha256sum né shasum trovati nel PATH." >&2
  exit 1
fi