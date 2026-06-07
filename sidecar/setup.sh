#!/usr/bin/env bash
# Sets up the FamilyHub wake-word sidecar: a Python venv with the wake engines.
# The default engine (livekit-wakeword) uses the committed james.onnx + feature
# models bundled in the pip package, so it needs no model download. The Vosk
# fallback engine needs the small English model, downloaded here.
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VOSK_MODEL="vosk-model-small-en-us-0.15"
VOSK_URL="https://alphacephei.com/vosk/models/${VOSK_MODEL}.zip"

# Require Python >= 3.10. Fail early with a clear message.
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

# Vosk fallback model (the default livekit engine needs no download).
mkdir -p models
if [ ! -d "models/${VOSK_MODEL}" ]; then
  echo "Downloading Vosk fallback model (~40 MB)…"
  curl -sL -o "models/${VOSK_MODEL}.zip" "$VOSK_URL"
  (cd models && unzip -q "${VOSK_MODEL}.zip" && rm -f "${VOSK_MODEL}.zip")
fi

echo "Sidecar ready at $(pwd) (default engine: livekit / james.onnx)"
echo "Verify with: ./.venv/bin/python selftest.py"
