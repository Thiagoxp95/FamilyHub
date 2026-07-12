#!/usr/bin/env bash
# Sets up the FamilyHub wake-word sidecar venv. The engine is livekit-wakeword:
# a single-stage conv-attention classifier (committed models/hey_james.onnx)
# whose mel + speech-embedding feature models ship inside the pip wheel — the
# wake path needs no model downloads. The downloads below are for AMBIENT
# transcription only (ambient_transcriber.py).
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

# Ambient mode (ambient_transcriber.py): Silero VAD + Parakeet-TDT v3 int8.
# The wake engine needs no model downloads (livekit-wakeword bundles its
# front-end in the wheel); these are ambient-transcription models only.
SILERO_VAD_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
if [ ! -f "models/silero_vad.onnx" ]; then
  echo "Downloading Silero VAD (~2 MB)…"
  curl -sL -o "models/silero_vad.onnx" "$SILERO_VAD_URL"
fi

PARAKEET="sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
PARAKEET_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET}.tar.bz2"
if [ ! -d "models/${PARAKEET}" ]; then
  echo "Downloading Parakeet-TDT v3 int8 (~600 MB)…"
  curl -sL -o "models/${PARAKEET}.tar.bz2" "$PARAKEET_URL"
  (cd models && tar xjf "${PARAKEET}.tar.bz2" && rm -f "${PARAKEET}.tar.bz2")
fi

# Moonshine tiny.en (sherpa-onnx int8): ambient's fallback ASR if the Parakeet
# dir is absent. No longer used by wake detection (chain removed).
MOONSHINE="sherpa-onnx-moonshine-tiny-en-int8"
MOONSHINE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MOONSHINE}.tar.bz2"
if [ ! -d "models/${MOONSHINE}" ]; then
  echo "Downloading Moonshine tiny.en (~50 MB, ambient fallback)…"
  curl -sL -o "models/${MOONSHINE}.tar.bz2" "$MOONSHINE_URL"
  (cd models && tar xjf "${MOONSHINE}.tar.bz2" && rm -f "${MOONSHINE}.tar.bz2")
fi

echo "Sidecar ready at $(pwd) (engine: livekit-wakeword single-stage; ambient: VAD+Parakeet)"
echo "Verify with: ./.venv/bin/python selftest.py"
