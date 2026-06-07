# FamilyHub wake-word sidecar

Always-on local **keyword spotter** for the "James" wake word. Once it fires the
app opens Gemini Live, which does the actual transcription — so this only has to
spot one word. A full ASR (e.g. Parakeet) drops a bare isolated "James" because
it leans on language-model context; a dedicated spotter does not.

## Engines (switchable)

Selected via `--engine` or `FAMILYHUB_WAKE_ENGINE`:

- **`livekit` (default)** — a custom [livekit-wakeword](https://github.com/livekit/livekit-wakeword)
  ONNX model (`james.onnx`, committed) trained just for "James". Catches
  isolated "James" and "James <continuation>". Runs on onnxruntime (no PyTorch);
  feature models are bundled in the pip package. Detection threshold via
  `FAMILYHUB_WAKE_THRESHOLD` (default `0.8`; raise it if it's too trigger-happy,
  lower it if it misses). Trained without the optional 16 GB ACAV100M negative
  set, so very general speech can drift up — the 0.8 threshold compensates.
- **`vosk`** — Vosk ASR constrained to a `["james","[unk]"]` grammar with a
  confidence gate. ~40 MB model, no general-speech drift. Use as a fallback:
  `FAMILYHUB_WAKE_ENGINE=vosk`.

## Setup

```bash
cd sidecar
PYTHON_BIN=python3.11 ./setup.sh
```

Requires **Python ≥ 3.10**. Creates `sidecar/.venv`, installs both engines, and
downloads the Vosk fallback model into `sidecar/models/`. The livekit default
needs no download (`james.onnx` is committed). The Electron main process
auto-discovers `sidecar/.venv/bin/python` and `sidecar/wake_listener.py`.
Overrides: `FAMILYHUB_SIDECAR_PYTHON`, `FAMILYHUB_SIDECAR_SCRIPT`,
`FAMILYHUB_WAKE_ENGINE`, `FAMILYHUB_WAKE_THRESHOLD`, `FAMILYHUB_WAKE_MODEL`.

## Self-test (recommended)

Verifies wake detection end-to-end without the GUI/mic — synthesizes speech with
`say` and streams it through the sidecar:

```bash
./.venv/bin/python selftest.py
```

Expected: `PASS — wakes on 'James', quiet otherwise.` (exit 0). Test the Vosk
engine with `FAMILYHUB_WAKE_ENGINE=vosk ./.venv/bin/python selftest.py`.

## Retraining the livekit model (optional, better accuracy)

`james.onnx` was trained from a reduced config without the 16 GB ACAV100M
general-negative set. For lower false positives, retrain with `livekit-wakeword`
(`pip install livekit-wakeword[train,eval,export]`, then `setup` without
`--skip-acav` and `run` your config), and drop the exported `james.onnx` here.

## Protocol

Newline-delimited over stdio: base64 int16 LINEAR16 @16 kHz frames in (or
`{"cmd":"reset"}`), `{"type":"partial"|"final","text","words":[]}` JSON out. The
first line is an empty `partial` ready-signal once the model loads; a transcript
containing the wake word is emitted only when one is confidently detected.
