# FamilyHub wake-word sidecar

Always-on local **keyword spotter** for the "James" wake word. Once it fires,
the app opens Gemini Live, which does the actual transcription — so this only
has to spot one word.

## Why a keyword spotter (not full ASR)

A full ASR model (e.g. Parakeet) leans on language-model context, so it reliably
transcribes "James" inside a phrase but **drops a bare "James" said on its own**.
This sidecar uses **Vosk** constrained to a tiny grammar (`["james", "[unk]"]`),
which is a dedicated keyword spotter: it fires on an isolated "James" across
speakers, and confidence-gated final results keep ordinary speech ("the name…")
from false-triggering. It's lightweight (~40 MB model, no PyTorch) and fast.

## Setup

```bash
cd sidecar
PYTHON_BIN=python3.11 ./setup.sh
```

Requires **Python ≥ 3.10**. `setup.sh` creates `sidecar/.venv`, installs `vosk`,
and downloads the small English model into `sidecar/models/`. The Electron main
process auto-discovers `sidecar/.venv/bin/python` and `sidecar/wake_listener.py`
(relative to cwd, this module, or `process.resourcesPath`). Overrides:
`FAMILYHUB_SIDECAR_PYTHON`, `FAMILYHUB_SIDECAR_SCRIPT`, `FAMILYHUB_VOSK_MODEL`.

## Self-test (recommended)

Verifies wake detection end-to-end without the GUI/mic — synthesizes speech with
`say` and streams it through the sidecar:

```bash
./.venv/bin/python selftest.py
```

Expected: `PASS — wakes on 'James', quiet otherwise.` (exit 0).

## Protocol

Newline-delimited over stdio: base64 int16 LINEAR16 @16 kHz frames in (or
`{"cmd":"reset"}`), `{"type":"partial"|"final","text","words":[]}` JSON out. The
first line is an empty `partial` ready-signal once the model loads; a transcript
containing the wake word is emitted only when one is confidently spotted.

## Upgrade path

For best-in-class accuracy you could swap Vosk for **Picovoice Porcupine** (type
"James" in the free console → `.ppn`, runs in-process via the Node SDK) or train
a custom **livekit-wakeword** ONNX model. Vosk was chosen here because it needs
no signup, no training, and no GPU.
