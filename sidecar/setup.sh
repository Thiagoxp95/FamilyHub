#!/usr/bin/env bash
# Sets up the FamilyHub wake-word sidecar venv. The default twostage engine uses
# openWakeWord (Stage-1 candidate, committed hey_james.onnx) then sherpa-onnx
# Moonshine to confirm "hey james". Vosk is downloaded as an offline fallback engine.
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

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

mkdir -p models

# Stage-1 openWakeWord shared feature models (melspectrogram + embedding). Bundled
# with the pip package but fetched on first use; pre-fetch so the runtime is offline.
./.venv/bin/python -c "import openwakeword.utils as u; u.download_models()"

# Stage-2 Moonshine tiny.en (sherpa-onnx int8 bundle).
MOONSHINE="sherpa-onnx-moonshine-tiny-en-int8"
MOONSHINE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MOONSHINE}.tar.bz2"
if [ ! -d "models/${MOONSHINE}" ]; then
  echo "Downloading Moonshine tiny.en (~50 MB)…"
  curl -sL -o "models/${MOONSHINE}.tar.bz2" "$MOONSHINE_URL"
  (cd models && tar xjf "${MOONSHINE}.tar.bz2" && rm -f "${MOONSHINE}.tar.bz2")
fi

# Vosk fallback model (engine=vosk only).
VOSK_MODEL="vosk-model-small-en-us-0.15"
VOSK_URL="https://alphacephei.com/vosk/models/${VOSK_MODEL}.zip"
if [ ! -d "models/${VOSK_MODEL}" ]; then
  echo "Downloading Vosk fallback model (~40 MB)…"
  curl -sL -o "models/${VOSK_MODEL}.zip" "$VOSK_URL"
  (cd models && unzip -q "${VOSK_MODEL}.zip" && rm -f "${VOSK_MODEL}.zip")
fi

# Ambient mode: Silero VAD + Parakeet-TDT v3 int8 (ambient transcription).
# Moonshine tiny (downloaded above) is the fallback ASR if Parakeet is absent.
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

echo "Sidecar ready at $(pwd) (default engine: twostage / openWakeWord → Moonshine)"
echo "Verify with: ./.venv/bin/python selftest.py"
