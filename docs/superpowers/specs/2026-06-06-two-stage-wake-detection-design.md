# Two-Stage "Hey James" Wake Detection — Design

**Date:** 2026-06-06
**Status:** Approved (pending spec review)
**Area:** `sidecar/wake_listener.py`, `sidecar/selftest.py`,
`apps/electron/src/main/assistant` (config/default labels only)

## Problem

Wake detection produces constant false positives — a false wake roughly every
few minutes. Root cause: the default engine is the custom `james.onnx`
livekit-wakeword model, which was **trained without the negative/background
dataset** (`--skip-acav`, reduced config). Its measured false-positive rate is
**~9.4 per hour**. The `FAMILYHUB_WAKE_THRESHOLD=0.8` gate is a band-aid over a
model that scores ordinary speech/TV too high.

Two factors compound it:

1. **The model is crippled by design** — skipping the ACAV negatives is exactly
   what teaches a wake model "this is NOT the word"; without it, random speech
   scores high.
2. **"James" is a common English name** — it occurs in normal conversation and
   on TV. No single detector handles a common-name wake word well in a noisy
   kitchen.

## Decisions (locked)

| Fork | Decision |
| --- | --- |
| Strategy | **Two-stage detect→confirm** (a permissive recall stage + a strict precision stage) |
| Wake phrase | **"Hey James"** (two-word phrase almost never fires by accident) |
| Confirmation engine | **Vosk (local)** — offline, free, already shipped as the fallback |
| Retrain the model? | **No.** Stage 2 supplies the precision the model lacks; the 16GB ACAV retrain is unnecessary. |
| Porcupine / cloud always-on? | **No.** No Porcupine, no always-on cloud STT. |

There is no hosted "cloud wake word" product. Always-streaming to cloud STT was
already (correctly) removed from this project. "Use Google stuff" would only mean
using Google STT as a confirmation stage — and Vosk fills that role locally for
free, so cloud is not used here.

## Core idea

Split detection into two stages, **both inside the existing
`sidecar/wake_listener.py`** (single long-lived process, same newline-delimited
stdio protocol, TypeScript side unchanged):

```
mic frames ──► [Stage 1: james.onnx]   fires on a "james"-ish candidate (HIGH RECALL)
                      │ (only on a candidate; cooldown prevents re-runs per frame)
                      ▼
              [Stage 2: Vosk verifier]  re-decodes the trailing ~3 s ring buffer
                      │                  against a tight grammar; must hear "hey james"
                      ▼ (only if confirmed)
              emit {"type":"final","text":"hey james"}  ──► controller opens Gemini
```

A false wake now requires **both** stages to be wrong at the same time.
Combined false-positive rate ≈ `Stage1_FP × Stage2_FP`, which collapses the
~9.4/hr to effectively never. Lowering the Stage-1 threshold also recovers any
*missed* real wakes, because Stage 2 now removes the junk that the high
threshold was guarding against.

## Architecture

Everything new lives in the sidecar. The renderer, IPC transport, listener
state machine, and `GeminiLiveSession` are all unchanged.

### New `TwoStageEngine` (in `wake_listener.py`, becomes the default engine)

Responsibilities and interface mirror the existing engines (`feed(pcm_bytes) ->
bool`, `reset()`), so `build_engine` and `main()`'s loop are unaffected beyond
engine selection.

- **Rolling ring buffer:** keeps the most recent ~3 s of raw `int16` PCM
  (enough to contain "hey" + a short pause + "james"). Sized in 80 ms frames.
- **Stage 1 (candidate trigger):** reuses `LivekitEngine` unchanged. Every frame
  is fed to it; it reports a candidate when `james.onnx` crosses the
  (now lower) Stage-1 threshold. Its internal cooldown already prevents
  re-firing on a single utterance, which also bounds how often Stage 2 runs.
- **Stage 2 (verifier):** on a candidate, build a **fresh** `KaldiRecognizer`
  with grammar `["hey james", "[unk]"]`, push the entire ring buffer through
  `AcceptWaveform` + `FinalResult`, and parse the word list. Confirm only when
  the result contains **"hey"** immediately followed by **"james"** with average
  confidence ≥ the confirm gate. A fresh recognizer per candidate avoids Vosk's
  continuous-decode drift and keeps Stage 2 stateless.
- On confirm → `feed` returns `True` (→ `main()` emits the final wake transcript).
  On veto → returns `False`, increments a rejected-candidate counter (see
  Diagnostics), and stays idle.

### Configuration / env knobs

| Env var | Default | Meaning |
| --- | --- | --- |
| `FAMILYHUB_WAKE_ENGINE` | `twostage` (was `livekit`) | `twostage` \| `livekit` \| `vosk`; single-stage engines retained for debugging/fallback |
| `FAMILYHUB_WAKE_THRESHOLD` | `0.5` (was `0.8`) | Stage-1 candidate threshold; greedy by design |
| `FAMILYHUB_WAKE_PHRASE` | `"hey james"` | Stage-2 confirmation phrase / grammar |
| `FAMILYHUB_WAKE_CONFIRM_CONFIDENCE` | `0.6` | Stage-2 Vosk confidence gate |
| `FAMILYHUB_WAKE_MODEL` / `FAMILYHUB_VOSK_MODEL` | existing | Stage-1 ONNX / Stage-2 Vosk model paths (unchanged) |

Defaults are chosen to be greedy at Stage 1 and strict at Stage 2; both are
tunable against real-room audio once the diagnostic counter (below) shows the
two stages firing.

### TypeScript side (label-only)

`liveController.ts:171` calls `transcriptContainsWakePhrase(text, wakePhrases)`
with `wakePhrases` defaulting to `["james"]`. The sidecar emits
`text:"hey james"`, which **contains** "james", so the existing gate matches with
**no logic change**. The only edits are honesty/labeling:

- Update the default phrase label/comment to "hey james" where surfaced to the
  user (no behavioral change to the gate). Keeping "james" as the matched token
  is acceptable and lower-risk than introducing multi-word regex handling.

## Diagnostics

To tell whether the two-stage is actually working in the real kitchen (not just
offline), the sidecar tracks and surfaces, on stderr (the existing diagnostic
channel), a running count of **rejected candidates** — cases where Stage 1 fired
but Stage 2 vetoed. A healthy deployment shows rejections climbing while
confirmed wakes only happen on real "Hey James". This is the signal we tune the
two thresholds against, rather than guessing.

## Error handling & edge cases

- **Vosk model missing/unloadable** → fail fast at startup with a clear stderr
  message (same as today's single-stage Vosk path); the controller surfaces
  "listener offline".
- **Stage 1 fires repeatedly (noisy room)** → Stage-1 cooldown bounds Stage-2
  runs; Stage 2 is fast (small model, faster-than-real-time over 3 s).
- **User says bare "James" (no "Hey")** → Stage 2 vetoes (grammar requires the
  phrase). This is the intended product behavior for the new phrase.
- **Wake fires again while connecting/live** → unchanged; handled by the existing
  listener state machine, which ignores wakes outside `idle`.
- **Ring buffer too short to hold "hey"** → sized ≥ 3 s specifically to avoid
  this; "hey james" is ~1 s of speech.

## Testing

Matches the repo's existing offline self-test + vitest style.

- **`sidecar/selftest.py` (extended):** across the 5 macOS TTS voices, assert
  - **0 misses** on "hey james" (and "hey james <continuation>"),
  - **0 false-wakes** on bare "james", on negatives (name/game/"jason"/
    "hey can you hear me"), and on silence,
  - a near-miss case ("hey jason", "hey can you hear me") is vetoed by Stage 2.
  - Runs against the `twostage` engine by default; `FAMILYHUB_WAKE_ENGINE`
    still selects single-stage engines for comparison.
- **`apps/electron/.../wakeDetection.test.ts`:** update expectations for the
  `twostage` default and the emitted `"hey james"` text; assert the existing
  `["james"]` gate still matches it.
- **Regression:** existing `gating`, `liveSession`, controller/machine, and the
  stdio contract tests stay green (no protocol or interface change).

## Scope

**In scope:**

- `TwoStageEngine` in `wake_listener.py`; wire it as the default engine.
- Lowered Stage-1 threshold; new confirm-phrase and confirm-confidence env knobs.
- Rejected-candidate diagnostic counter on stderr.
- Extended `selftest.py`; updated `wakeDetection.test.ts`.
- TS default phrase label/comment update (no gate logic change).

**Out of scope (later / unchanged):**

- Retraining `james.onnx` with the ACAV negatives (not needed; Stage 2 covers
  precision). Could still be done later to also shrink Stage-1 false candidates.
- Speaker verification / hard speaker-lock (already separately scoped as a
  follow-up, sequenced *after* the wake word is confirmed reliable).
- Precise wake-word trimming from replayed audio (buffering is OFF by default).
- Any Porcupine / cloud always-on path.
- Windows / Linux; PyInstaller packaging.
