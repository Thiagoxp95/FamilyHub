#!/usr/bin/env bash
# Creates the local Python venv for the Parakeet sidecar (Apple Silicon only).
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

# Require Python >= 3.10 (parakeet-mlx / mlx). Fail early with a clear message
# instead of installing into an unusable env.
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "error: $PYTHON_BIN is $("$PYTHON_BIN" --version 2>&1); parakeet-mlx needs Python >= 3.10." >&2
  echo "       Re-run with e.g.: PYTHON_BIN=python3.11 $0" >&2
  exit 1
fi

# --clear rebuilds from scratch so a re-run with a different PYTHON_BIN (e.g.
# after a first attempt on a too-old python) never silently reuses the old
# interpreter.
"$PYTHON_BIN" -m venv --clear .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

echo "Sidecar venv ready at $(pwd)/.venv"
echo "The Parakeet model (~600 MB) downloads on first run and is cached by Hugging Face."
