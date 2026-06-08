# FamilyHub wake-word sidecar

Always-on local **keyword spotter** for the "hey James" wake phrase. Once it
fires the app opens Gemini Live, which does the actual transcription.

## Engines (switchable)

Selected via `--engine` or `FAMILYHUB_WAKE_ENGINE`:

- **`twostage` (default)** — Stage 1 is an [openWakeWord](https://github.com/dscripka/openWakeWord)
  ONNX classifier (`models/hey_james.onnx`, custom-trained for "hey james", committed)
  flagging candidates with high recall. On a candidate the sidecar buffers a short
  post-trigger window so the full word lands, then Stage 2 free-decodes the ~2 s tail
  with a sherpa-onnx **Moonshine tiny.en** recognizer and confirms only if it actually
  transcribes "james" (or a curated alias). A false wake needs both stages wrong at once.
  Threshold via `FAMILYHUB_WAKE_THRESHOLD` (default `0.5`, recall-first).
- **`vosk`** — Vosk ASR constrained to a `["james","[unk]"]` grammar with a confidence
  gate. ~40 MB model, no general-speech drift. Offline fallback: `FAMILYHUB_WAKE_ENGINE=vosk`.

## Setup

```bash
cd sidecar
PYTHON_BIN=python3.11 ./setup.sh
```

Requires **Python ≥ 3.10**. Creates `sidecar/.venv`, installs the engines and
downloads the Moonshine confirm model + Vosk fallback model into `models/`. The
openWakeWord `hey_james.onnx` is committed (no download). The Electron main process
auto-discovers `sidecar/.venv/bin/python` and `sidecar/wake_listener.py`.
Overrides: `FAMILYHUB_SIDECAR_PYTHON`, `FAMILYHUB_SIDECAR_SCRIPT`,
`FAMILYHUB_WAKE_ENGINE`, `FAMILYHUB_WAKE_THRESHOLD`, `FAMILYHUB_WAKE_MODEL`,
`FAMILYHUB_MOONSHINE_MODEL`.

## Self-test (recommended)

Verifies wake detection end-to-end without the GUI/mic — synthesizes speech with
`say` and streams it through the sidecar:

```bash
./.venv/bin/python selftest.py
```

Expected: `PASS — wakes on 'Hey James', quiet otherwise.` (exit 0). Test the Vosk
engine with `FAMILYHUB_WAKE_ENGINE=vosk ./.venv/bin/python selftest.py`.

## Training the openWakeWord model

`models/hey_james.onnx` is produced off-device via openWakeWord's synthetic pipeline.
See `training/README.md` for the reproducible recipe (Piper TTS positives + noise/
negatives, ONNX export). For better real-room recall, fold in clips recorded on the
appliance with `record_wake.py`.

## Protocol

Newline-delimited over stdio: base64 int16 LINEAR16 @16 kHz frames in (or
`{"cmd":"reset"}`), `{"type":"partial"|"final","text","words":[]}` JSON out. The
first line is an empty `partial` ready-signal once the model loads; a transcript
containing the wake phrase is emitted only when one is confidently detected.
