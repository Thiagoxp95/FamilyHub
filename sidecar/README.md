# FamilyHub Parakeet sidecar

Always-on local ASR for the "James" wake word and post-wake capture. Apple
Silicon only (uses MLX). Requires **Python ≥ 3.10**.

## How it works

Continuous streaming ASR is the wrong tool for wake-word detection: fed one
long-lived stream with silence between utterances it drops isolated short words
(a bare "James" transcribes to "") and hallucinates on ambient noise. So this
sidecar uses **voice-activity detection** (`webrtcvad`, energy fallback) to find
each spoken utterance and transcribes it with a **fresh decode** — reliable even
for a single word. It emits an early `partial` once an utterance is ~0.9 s long
(low-latency wake on phrases) and a `final` when the utterance ends.

Protocol (newline-delimited over stdio): base64 int16 LINEAR16 @16 kHz frames in
(or `{"cmd":"reset"}`), `{"type":"partial"|"final","text","words"}` JSON out.
The first line is an empty `partial` ready-signal emitted once the model loads.

## Setup

```bash
cd sidecar
PYTHON_BIN=python3.11 ./setup.sh
```

`setup.sh` rejects Python < 3.10 and rebuilds the venv with `--clear`. It creates
`sidecar/.venv` and installs `parakeet-mlx`, `numpy`, and `webrtcvad-wheels`. The
model (~600 MB) downloads on first run and is cached by Hugging Face.

The Electron main process auto-discovers `sidecar/.venv/bin/python` and
`sidecar/parakeet_listener.py` (relative to cwd, this module, or
`process.resourcesPath`). Override with `FAMILYHUB_SIDECAR_PYTHON` /
`FAMILYHUB_SIDECAR_SCRIPT`.

## Self-test (recommended)

Verifies the sidecar catches the wake word end-to-end, without the GUI/mic —
synthesizes speech with `say` and streams it through the sidecar:

```bash
./.venv/bin/python selftest.py
```

Expected: `PASS — the sidecar catches the wake word.` (exit 0).

## Smoke test (ready signal only)

```bash
printf '%s\n' "$(./.venv/bin/python -c 'import base64,sys; sys.stdout.write(base64.b64encode(bytes(3200)).decode())')" \
  | ./.venv/bin/python parakeet_listener.py
```

Expected: a JSON line `{"type": "partial", "text": "", "words": []}` (ready
signal). Note: an isolated 3200-byte silence frame won't produce a transcript;
use `selftest.py` to check real recognition.
