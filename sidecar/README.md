# FamilyHub wake-word sidecar

Always-on local **keyword spotter** for the "hey James" wake phrase. Once it
fires the app opens Gemini Live, which does the actual transcription.

## Engine

Single-stage [livekit-wakeword](https://github.com/livekit/livekit-wakeword)
detector: a conv-attention classifier (`models/hey_james.onnx`, custom-trained
for "hey james", committed) over the frozen Google speech-embedding front-end
(mel + embedding models ship inside the pip wheel). The conv-attention head
models phoneme ORDER, which is what separates "james" from the
cames/games/jason confusable family — there is no second-stage ASR verifier
chain (the old openWakeWord → Moonshine/Whisper/Vosk pipeline is gone; every
lost wake died at its stage-1, and this replaces exactly that stage).

The sidecar streams incrementally: one embedding + one classifier pass per
80 ms hop (~9 ms on M-class CPUs, ~1/10th the cost of livekit's stateless
`predict()` per hop). Equivalence with the batch pipeline is locked by
`test_streaming_engine.py`.

Knobs (env): `FAMILYHUB_WAKE_MODEL`, `FAMILYHUB_WAKE_THRESHOLD` (recall-first
operating point; re-derive with `wake_bench.py --tune`), `FAMILYHUB_WAKE_MIN_HITS`
(consecutive hops ≥ threshold to fire, default 1), `FAMILYHUB_WAKE_COOLDOWN_MS`
(refractory, default 2000), `FAMILYHUB_WAKE_PHRASE` (emitted text).

## Setup

```bash
cd sidecar
PYTHON_BIN=python3.11 ./setup.sh
```

Requires **Python ≥ 3.11**. Creates `sidecar/.venv` and installs
livekit-wakeword + numpy + onnxruntime — no model downloads (the classifier is
committed; feature models are in the wheel). The Electron main process
auto-discovers `sidecar/.runtime/bin/python3` (packaged) then
`sidecar/.venv/bin/python` (dev) and `sidecar/wake_listener.py`.
Overrides: `FAMILYHUB_SIDECAR_PYTHON`, `FAMILYHUB_SIDECAR_SCRIPT`.

## Self-test (recommended)

Verifies wake detection end-to-end without the GUI/mic — synthesizes speech with
`say` and streams it through the sidecar:

```bash
./.venv/bin/python selftest.py
```

Expected: `PASS — wakes on 'Hey James', quiet otherwise.` (exit 0).

## Benchmarks & tuning

- `wake_bench.py` — recall + false-wakes/hour over the owner corpus
  (`~/.familyhub/wake-corpus`, recorded with `record_corpus.py`); `--roc`
  sweeps thresholds, `--tune --fp-budget 0.5` recommends
  `FAMILYHUB_WAKE_THRESHOLD`. Its last stdout line is the JSON contract
  `promote_model.sh` gates promotions on.
- `diagnose_wake.py scores|pipeline` — score percentiles / recall / fire
  latency over the held-out training test splits.
- `test_streaming_engine.py`, `test_wake_bench.py`, `test_promote_model.py`,
  `test_record_corpus.py` — standalone venv test scripts.

## Training the model

`models/hey_james.onnx` is produced off-device with the livekit-wakeword
pipeline: piper VITS bulk positives + VoxCPM2 Brazilian-accented personas +
macOS `say` voices, adversarial phoneme-substitution negatives + ACAV100M.
See `training/README.md` for the full recipe, including folding real owner
recordings (the strongest accent-recall lever) and the bench-gated promote.

## Protocol

Newline-delimited over stdio: base64 int16 LINEAR16 @16 kHz frames in (or
`{"cmd":"reset"}`), `{"type":"partial"|"final","text","words":[]}` JSON out. The
first line is an empty `partial` ready-signal once the model loads; a wake
emits `{"type":"final","text":"hey james","words":[]}`.
