#!/usr/bin/env bash
# Sets up the FamilyHub wake-word sidecar venv. The engine is livekit-wakeword:
# a single-stage conv-attention classifier (committed models/hey_james.onnx)
# whose mel + speech-embedding feature models ship inside the pip wheel — no
# extra model downloads.
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

# Require Python >= 3.11 (livekit-wakeword floor). Fail early with a clear message.
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "error: $PYTHON_BIN is $("$PYTHON_BIN" --version 2>&1); needs Python >= 3.11." >&2
  echo "       Re-run with e.g.: PYTHON_BIN=python3.11 $0" >&2
  exit 1
fi

# --clear rebuilds from scratch so a re-run with a different PYTHON_BIN never
# silently reuses an old interpreter.
"$PYTHON_BIN" -m venv --clear .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

mkdir -p models

echo "Sidecar ready at $(pwd) (engine: livekit-wakeword single-stage)"
echo "Verify with: ./.venv/bin/python selftest.py"
