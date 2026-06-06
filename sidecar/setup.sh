#!/usr/bin/env bash
# Creates the local Python venv for the Parakeet sidecar (Apple Silicon only).
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

"$PYTHON_BIN" -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

echo "Sidecar venv ready at $(pwd)/.venv"
echo "The Parakeet model (~600 MB) downloads on first run and is cached by Hugging Face."
