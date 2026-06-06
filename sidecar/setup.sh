#!/usr/bin/env bash
# Sets up the FamilyHub wake-word sidecar: a Python venv with Vosk and the small
# English model used for keyword spotting.
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VOSK_MODEL="vosk-model-small-en-us-0.15"
VOSK_URL="https://alphacephei.com/vosk/models/${VOSK_MODEL}.zip"

# Require Python >= 3.10 (vosk wheels). Fail early with a clear message instead
# of installing into an unusable env.
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "error: $PYTHON_BIN is $("$PYTHON_BIN" --version 2>&1); needs Python >= 3.10." >&2
  echo "       Re-run with e.g.: PYTHON_BIN=python3.11 $0" >&2
  exit 1
fi

# --clear rebuilds from scratch so a re-run with a different PYTHON_BIN never
# silently reuses an old interpreter.
"$PYTHON_BIN" -m venv --clear .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

mkdir -p models
if [ ! -d "models/${VOSK_MODEL}" ]; then
  echo "Downloading Vosk model (~40 MB)…"
  curl -sL -o "models/${VOSK_MODEL}.zip" "$VOSK_URL"
  (cd models && unzip -q "${VOSK_MODEL}.zip" && rm -f "${VOSK_MODEL}.zip")
fi

echo "Sidecar venv + Vosk model ready at $(pwd)"
echo "Verify with: ./.venv/bin/python selftest.py"
