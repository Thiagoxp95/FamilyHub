# Owner-Personalized, Recall-First Wake Reliability

**Date:** 2026-06-27
**Status:** Approved — implementing via subagent-driven development
**Goal:** "OK Google / Hey Siri" trigger reliability — near-zero misses for the owner's
voice at counter distance, with false wakes held to "a few a day" (acceptable per owner).

## Problem

The owner frequently has to say "hey james" **louder** or **twice** before it triggers.
This is a **recall** problem, not the false-positive problem recent work (`measure_cames.py`,
`record_phrases.py`) addressed.

### Evidence (from `~/.familyhub/wake-debug.log`, 2043 lines of real usage)

Misses split into two buckets:

1. **Stage-1 never fires — the dominant "say it louder / say it twice" cause.**
   The custom `hey_james.onnx` has voice/timbre blind spots. On clean TTS, the "Fred"
   voice scores **0.064** (total miss) and "Karen" **0.42**. In the wild, 102+ logged
   no-fire candidates peak at **0.30–0.49**, plus an invisible tail below the 0.30 log
   floor. They never cross the 0.32 gate, so **Stage 2 never runs**. Saying it louder
   shoves the peak over 0.32. The gate is already aggressive; lowering it further floods
   Stage 2 with TV/music (192 logged vetoes, mostly `(buzzer)`, `(mellow music)`,
   `"subscribe to our channel"`).

2. **Stage-2 vetoes genuine wakes.** Tiny ASRs on a noisy ~2 s tail mis-hear real wakes,
   e.g. `FIRED 0.460 → VETOED whisper=' I came.' vosk='hey games'`. The alias list is a
   hand-maintained band-aid on a knife-edge against the "hey cames/games" false-positive
   family.

### Why Siri/Google win
(a) on-device **speaker personalization** ("Hey Siri" enrollment retrains on *your* voice);
(b) bigger acoustic models; (c) multi-mic beamforming hardware. We replicate (a), partly
(b), not (c).

## Owner decisions (triage)

- **Approach:** Personalize + targeted tuning (retrain on owner voice/room + software fixes).
- **False wakes:** "Never miss me" — a few accidental wakes/day is acceptable. Unlocks a
  lower Stage-1 gate + looser Stage-2 confirm.
- **Deployment:** **External USB mic, near the counter** (within ~1–2 m). NOT far-field —
  SNR is good, so misses are about model sensitivity to the owner's voice/articulation,
  not distance/reverb. Personalization is the ideal lever; dereverb is unnecessary.

## Architecture today

renderer mic (WebRTC AGC **on**, noise-suppression **off**, echo-cancel **on**) → int16
16 kHz frames → `sidecar/wake_listener.py` `TwoStageEngine` (Stage-1 openWakeWord
`hey_james.onnx` @ threshold 0.32, bypass ≥0.90 → Stage-2 Moonshine→Whisper→Vosk free-decode
chain confirming token "james") → emit `hey james` → Electron gate (`gating.ts`) → Gemini Live.
The always-on listener **is** the wake engine; no separate strong ASR runs pre-wake.

## Design — 5 components with a measurement spine

### Component 0 — Recall benchmark + corpus *(foundation, built first)*
Two guided recorders (evolve `record_phrases.py`) + one bench harness (evolve
`measure_cames.py` / `diagnose_wake.py`).
- **Positives:** owner says "hey james" ~40–60× with realistic variation (normal/quiet/
  mumbled/fast/slow, TV on, moving around the counter). Split **70% train / 30% held-out
  bench**.
- **Negatives:** room TV/music/YouTube, kitchen conversation, the cames/games/came-home
  family. → train hard-negatives + false-wake bench.
- **Bench output:** miss-rate (recall), false-wakes/hour, and **where each miss died**
  (Stage-1 no-fire w/ score vs Stage-2 veto w/ decode). Single source of truth; first run
  establishes the **current baseline**.

### Component 1 — Personalized Stage-1 model *(the big win)*
Retrain `hey_james.onnx` (existing openWakeWord recipe; memory has pinned-torch gotchas)
with owner "hey james" positives (augmented: gain/reverb/noise-mix at varied SNR, time-shift)
+ room negatives + cames family as hard negatives. Target: owner's casual "hey james" scores
0.6–0.95 instead of 0.30–0.45; cames/games stay low. Ship behind the same path; keep
`hey_james_v1.onnx` for instant rollback. **Gate: must beat baseline on the held-out bench
without raising false-wakes/hr.**

### Component 2 — Sidecar front-end normalization *(cheap recall lift)*
Fast wake-band conditioner in `wake_listener.py` before Stage-1 `predict`: **per-frame RMS
AGC with fast attack**, VAD/energy-gated so it does not amplify silence into noise.
Normalizes casual/quiet utterances to the level the model expects (Chrome AGC is too slow at
onset). **Decision:** train Component 1 on *normalized* audio too, so train/inference match.
Pre-emphasis/dereverb skipped (near-field).

### Component 3 — Stage-2 recall fixes *(reclaim vetoed real wakes)*
Given "never miss me":
- Replace the brittle alias list with a **phonetic match** (Double Metaphone + bounded
  edit-distance to "james"), tuned against the bench so cames stays rejected but real
  mis-hears pass.
- Add an **OR-rule:** a mid-high *personalized* Stage-1 score (e.g. ≥0.55) is already strong
  evidence — let it through even if the tiny ASRs choke on a noisy tail.
- Normalize the tail (same conditioner) before decode.

### Component 4 — Threshold/bypass retune *(the "never miss me" unlock)*
Retune **on the bench curve**: Stage-1 gate as low as the false-wake budget allows (likely
0.20–0.25), bypass lowered so strong personalized hits skip the lossy Stage-2, post-trigger
window confirmed for the owner's cadence. Pick the operating point at the "few a day" budget.

## Sequencing
1. **C0** → record corpus → baseline number.
2. **C2 + C4** (software-only) → ship + measure. Quick partial win.
3. **C1** (personalized model) → big win. Train → validate → swap w/ rollback.
4. **C3** (Stage-2 phonetic + OR-rule) → mop up remaining vetoes.

Re-bench after each; stop when owner miss-rate hits target within the false-wake budget.

## Component boundaries (for isolation/testing)
- **Recorders + bench:** standalone Python scripts; smoke-testable with TTS/synthetic audio.
- **Front-end conditioner:** one module/class in `wake_listener.py`; pure function over
  int16 frames; unit-testable in isolation.
- **Stage-1 model:** an artifact swap behind the existing `FAMILYHUB_WAKE_MODEL` path; old
  model retained for rollback.
- **Stage-2 confirmer:** phonetic matcher replaces/augments `text_contains_wake_token`;
  unit-testable against existing cames data + synthetic decodes.
- **Config retune:** existing env knobs (`FAMILYHUB_WAKE_THRESHOLD`, `_S1_BYPASS`,
  `_POST_TRIGGER_MS`); a bench-driven tuner picks defaults.

## Owner-in-the-loop steps (cannot be automated)
- Run the recorders to capture the voice/room corpus (~10–15 min).
- Kick the training run on the real clips (script provided; dry-runnable on TTS first).
- Final on-device bench + operating-point sign-off.

## Risks & mitigations
- **AGC amplifies inter-utterance noise → more Stage-1 candidates.** Mitigate with a
  VAD/energy gate; rely on Stage-2 + bench to hold the false-wake budget.
- **Phonetic match reopens the cames/games hole.** The cames family scores ~0 on the
  *personalized* Stage 1, so a "games" decode in the confirm band is more likely a mis-heard
  real "james"; tune the phonetic threshold against the cames negatives as a hard regression
  gate.
- **Training proves finicky (pinned-torch gotchas).** C2+C4 ship independently and already
  deliver a partial win, so the software path is a standing fallback if C1 stalls.
- **Train/inference audio mismatch.** Normalize identically in training and in the live
  sidecar path.

## Success criteria
- Owner held-out recall bench: miss-rate at/near 0 at counter distance/normal volume.
- False-wakes/hour on the negative bench stays within the "a few a day" budget.
- No regression on the cames/games false-positive family.
- Instant rollback path (`hey_james_v1.onnx`) preserved.
