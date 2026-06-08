# "Hey James" wake — SOTA two-stage rebuild (openWakeWord → Moonshine)

**Date:** 2026-06-08
**Branch:** feature/instant-wake-audio-capture
**Status:** Approved design, pre-implementation

## Goal

Modernize the always-on local "hey james" wake detector to a 2026 state-of-the-art
stack while preserving the existing recall-first behavior and downstream contract.
Replace the two engine internals only; keep the cascade architecture, stdio protocol,
and the Electron-side gate unchanged.

Two changes, motivated by the review:

1. **Stage 1** `livekit-wakeword` (`james.onnx`, trained without the ACAV100M
   general-negative set → general-speech drift) → **openWakeWord**, a better-maintained
   open framework with proper negative/noise training, custom-trained for "hey james".
2. **Stage 2** Vosk free decode (2020-era Kaldi small/lgraph; mis-transcribes "james"
   → real wakes vetoed, the `heard='hey ja'` misses) → **sherpa-onnx + Moonshine
   tiny.en**, a modern short-clip ASR that reuses an already-pinned runtime.

## Non-goals

- Speaker-lock / voiceprint identification (removed on this branch; stays removed —
  wake is owner-agnostic by design).
- Changing the Electron/renderer side beyond what the sidecar contract requires
  (it requires nothing — the protocol is unchanged).
- Cloud/native always-on wake (privacy + cost — wrong tradeoff for an always-listening
  mic stage).
- Microcontroller targets (microWakeWord) — the device is a 16 GB Mac appliance.

## Architecture

Unchanged cascade in `sidecar/wake_listener.py`:

```
PCM frames (16 kHz int16 LINEAR16, base64 over stdio)
  → Stage 1 (high recall candidate detector)
  → on candidate: collect post-trigger window (~640 ms) into ring buffer
  → Stage 2 (free decode of ~2 s tail; confirm phrase present)
  → emit {"type":"final","text":"hey james"} on confirm
```

Preserved verbatim:

- stdio protocol (base64 PCM in / JSON transcript out, `{"cmd":"reset"}` control line,
  empty `partial` ready signal).
- `TwoStageEngine` ring buffer (`RING_FRAMES=50`, ~4 s), post-trigger collection
  (`DEFAULT_POST_TRIGGER_MS=640`, sample-counted), `CONFIRM_DECODE_FRAMES=25` (~2 s tail).
- Stage-1 cooldown so one utterance can't double-fire.
- `dlog` diagnostics to `~/.familyhub/wake-debug.log` (peak score, FIRED, VETOED,
  `heard='…'`).
- The full-phrase emit (`"hey james"`) so the downstream
  `transcriptContainsWakePhrase` gate in `gating.ts` accepts it.
- `gating.ts` and `liveController.ts` are **untouched**.

## Components

### Stage 1 — `OpenWakeWordEngine` (replaces `LivekitEngine`)

- **Runtime:** onnxruntime via the `openwakeword` package (torch-free at runtime;
  torch is a train-time-only dep, not in the runtime venv).
- **Model files (committed under `sidecar/models/`):**
  - `hey_james.onnx` — the custom-trained classifier.
  - openWakeWord shared preprocessors `melspectrogram.onnx` and `embedding_model.onnx`
    (standard files openWakeWord ships/downloads; committed so the runtime needs no
    network).
- **Interface:** same as today — `__init__(model_path, threshold)`, `reset()`,
  `feed(pcm_bytes) -> bool`. 80 ms frames, score 0–1, fires at
  `>= FAMILYHUB_WAKE_THRESHOLD` (recall-first default kept; retune in
  selftest if openWakeWord's score distribution differs from livekit's).
- **Diagnostics:** keep the peak-score candidate-burst logging so misses below
  threshold remain observable (the past "ask 2–3 times" symptom).

### Stage 1 model training (one-time, reproducible)

- openWakeWord synthetic pipeline: Piper TTS generates many-voiced "hey james"
  positives; openWakeWord mixes negatives + room/background noise; train; export ONNX.
- Runs on Colab/GPU (~1–2 hrs). Documented in `sidecar/training/README.md` with the
  config + command so `hey_james.onnx` is reproducible. Training deps
  (`openwakeword[train]`, `piper-tts`) are **not** in the runtime `requirements.txt`.

### Stage 2 — `MoonshineConfirmer` (replaces the Vosk free decode)

- **Runtime:** `sherpa-onnx` (already pinned) offline recognizer, Moonshine tiny.en.
- **Why Moonshine over whisper-tiny:** purpose-built for short clips; no fixed 30 s
  padding, so a ~2 s tail decode is faster; torch-free; same runtime we already ship.
- **Confirm logic:** free (unconstrained) decode of the ~2 s tail → confirm iff the
  transcript contains `james` or a curated alias. Reuse the alias set that mirrors
  `gating.ts` (`jaymes`, `jaimes`, `jamez`, `jaymz`, `hames`, `jaymez`) so the two
  layers agree. Drops Vosk's per-word numeric confidence gate: with a free decode the
  precision mechanism is "the model actually transcribed the distinctive word", same
  principle, fewer magic numbers. Near-misses ("hey jason", "games", "cames") fail
  because the decoded word differs.
- **Interface:** drop-in for the current `_confirm()` — same ring-tail input, returns
  bool, sets `self._last_heard = "heard='…'"` for the veto log line.
- **Model file:** Moonshine tiny.en sherpa-onnx bundle downloaded by `setup.sh` into
  `sidecar/models/`.

### Engine selection

- `twostage` (default) = openWakeWord → Moonshine.
- `vosk` (fallback, **kept**) = existing grammar-constrained Vosk ASR, unchanged.
  Offline, no downloads to fail; the safety net if the new stack misbehaves in a room.
- `livekit` standalone debug engine — **removed** (superseded by openWakeWord; the
  reduced-config james.onnx is the thing we're retiring).
- Env knobs preserved: `FAMILYHUB_WAKE_ENGINE`, `FAMILYHUB_WAKE_THRESHOLD`,
  `FAMILYHUB_WAKE_POST_TRIGGER_MS`, `FAMILYHUB_WAKE_PHRASE`,
  `FAMILYHUB_WAKE_CONFIRM_PHRASE` (→ matched as the distinctive token), `FAMILYHUB_WAKE_MODEL`.

## Data flow (confirm path)

1. openWakeWord scores each 80 ms frame; `>= threshold` → Stage-1 candidate, start
   collecting post-trigger samples.
2. After `post_trigger_samples` buffered, take last `CONFIRM_DECODE_FRAMES` (~2 s) from
   the ring.
3. Moonshine decodes that tail → text.
4. Normalize text; if any token matches `james`/alias → confirm → emit
   `{"type":"final","text":"hey james"}`. Else increment `rejected`, `dlog` the veto
   with `heard='…'`.

## Packaging / deps

`sidecar/requirements.txt` (runtime, torch-free):

```
openwakeword     # replaces livekit-wakeword (Stage 1, onnxruntime)
sherpa-onnx      # Stage 2 Moonshine confirm (already pinned)
vosk             # fallback engine
numpy
```

`setup.sh`:

- Create `.venv`, install runtime requirements.
- Download Moonshine tiny.en sherpa-onnx model into `models/`.
- Keep the Vosk fallback model download.
- openWakeWord ONNX files (`hey_james.onnx` + preprocessors) are committed → no download.

## Testing

`sidecar/selftest.py` is the behavioral contract and stays the gate:

- **Should WAKE:** `say "Hey James"` (default + Daniel + Karen voices),
  `"Hey James turn on the lights"`.
- **Should stay quiet:** `"what is the weather like today"`, `"the name of the guy is
  John"`, bare `"James"`, `"hey Jason"`, `"hey can you hear me"`, pure silence.
- Runs the default `twostage` (openWakeWord → Moonshine) end-to-end through the sidecar
  via synthesized speech, no GUI/mic. Must print `PASS`.
- Threshold/confirm tuning is driven by making selftest pass with margin (recall-first:
  prefer a Stage-1 fire + Stage-2 veto over a Stage-1 miss).
- Unit-level: `wakeDetection.test.ts` / `gating.ts` unchanged and still green (the
  Electron-side gate contract is untouched).

## Docs cleanup (in scope)

- Rewrite `sidecar/README.md` engine section: openWakeWord (Stage 1) + sherpa-onnx
  Moonshine (Stage 2) + Vosk (fallback); remove the `livekit` engine; update knobs and
  the "retraining the livekit model" section → "training the openWakeWord model".
- Fix the stale `requirements.txt` comment that references a `sherpa-onnx` speaker
  hard-lock gate (speaker-lock was removed on this branch); sherpa-onnx is now the
  Stage-2 ASR runtime.

## Risks / open items

- **openWakeWord score distribution differs from livekit's** → the recall-first
  `0.5` default may need re-tuning. Mitigation: selftest is the tuning harness; log
  peaks; pick threshold with margin on the synthesized corpus.
- **Custom model quality** depends on the synthetic training set breadth (voices/noise).
  Mitigation: document the config; if real-room recall is poor, expand voices/negatives
  and re-export — runtime code is unaffected.
- **Moonshine on very short tails** could truncate "james" if post-trigger is too short;
  `FAMILYHUB_WAKE_POST_TRIGGER_MS` already exists to tune this (it trades latency vs
  recall only, not false positives).
```
