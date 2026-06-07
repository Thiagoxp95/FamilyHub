# Speaker-Lock via Family Voiceprints — Design (Sub-project 2 of 3)

**Date:** 2026-06-07
**Status:** Approved (pending spec review)
**Area:** `sidecar/speaker_gate.py`, `sidecar/speaker_embed.py` (new),
`apps/electron/src/main/assistant` (`voiceprintStore`, `speakerGate`,
`liveController`, IPC)

## Context

The retrained single-stage wake model (SP-wake) fires on "james" from **anyone**
— including the TV. SP1 captured per-member "Hey James" clips. SP2 uses those
clips to build **persistent family voiceprints** so that only an enrolled family
member's voice actually reaches Gemini, and the assistant **hard-locks to whoever
woke it** for the session.

The parallel "speaker hard-lock" work already shipped the hard part:
`sidecar/speaker_gate.py` uses **sherpa-onnx silero VAD + nemo titanet** speaker
embeddings, VAD-segments live audio, and forwards/drops utterances by cosine
similarity — but it locks onto the **first speaker of each session** (ephemeral,
no notion of family). `liveController.ts` already routes live frames through it
(`gate.feed` → `onForward` → Gemini).

## Decisions (locked)

| Fork | Decision |
| --- | --- |
| Lock scope | **Hard-lock to the waker** — only the exact voice that woke James talks this session; other family AND the TV are ignored until it ends. |
| Non-family wake | **End the session immediately** — if no enrolled voice matches the wake utterance, close the Gemini session right away. |
| Lock reference | The **live wake-utterance embedding** (matches session acoustics), not the stored voiceprint. The stored voiceprints are used only for the membership check. |
| No-enrollment fallback | If **no** voiceprints are enrolled yet, the gate stays **open-mic** (today's behavior) so James still works before anyone enrolls. |
| Threshold | titanet cosine `FAMILYHUB_SPEAKER_THRESHOLD=0.6` (validated: same-speaker ~0.9 vs others <0.55). |

## Architecture & components

### 1. Voiceprints — compute once from the SP1 clips

- **`sidecar/speaker_embed.py` (new):** the titanet embed logic, extracted from
  `speaker_gate.py` so both share one implementation.
  - `load_extractor(model_path)` → sherpa-onnx `SpeakerEmbeddingExtractor`.
  - `embed(extractor, samples) -> np.ndarray` (L2-normalized).
  - `mean_voiceprint(extractor, clip_paths) -> np.ndarray` (mean of per-clip
    embeddings, re-normalized).
  - CLI one-shot: `python speaker_embed.py <clips_dir>` reads `clip_*.wav`,
    prints the voiceprint as a JSON float array on stdout (exit non-zero on
    error). This is what the main process spawns.
- **`main/assistant/voiceprintStore.ts`:** `compute(speakerId, clipsDir)` spawns
  the one-shot, parses the vector, writes `speaker-profiles/<id>/voiceprint.json`
  (`{ dim, vec }`); `load(speakerId)` reads it; `loadAll(allowedSpeakerIds)`
  returns `[{ id, vec }]`; `delete(speakerId)` removes it. Co-located with
  `EnrollmentStore` (same `userDataDirectory`).

### 2. The gate becomes family-aware — modify `sidecar/speaker_gate.py`

- Import the shared `speaker_embed`.
- New stdin control message `{"cmd":"load","speakers":[{"id":str,"vec":[...]}]}`
  — sets the in-memory family voiceprint list (sent by the controller at session
  start; may be empty).
- Replace the first-speaker-wins flow:
  - **Locked reference is `None` and family list non-empty:** on the first VAD
    segment, embed it, compute the best cosine match across family voiceprints.
    - best ≥ threshold → set `reference = this segment's embedding` (hard-lock to
      the live wake voice), record `locked_id`, emit
      `{"type":"forward","audio":...,"score":...,"speakerId":locked_id}`.
    - best < threshold → emit `{"type":"rejected","score":best}` (do NOT lock).
  - **Locked reference set:** each later segment → cosine vs `reference`;
    ≥ threshold → `forward`, else `{"type":"dropped","score":...}`.
  - **Family list empty (no enrollment):** behave as today — first segment
    becomes the reference and forwards (open-mic fallback); emit `enrolled` as
    before so nothing downstream breaks.
- `{"cmd":"reset"}` clears `reference`, `locked_id`, and the family list stays
  until the next `load` (the controller re-loads per session).

### 3. Controller wiring — `speakerGate.ts` / `liveController.ts`

- `speakerGate.ts`: add `loadVoiceprints(speakers: {id, vec}[])` (writes the
  `load` control line); extend `SpeakerGateDecision` with `"rejected"` and an
  optional `speakerId`; surface `onDecision`.
- `liveController.ts`: at session start, after `gate.start(...)`, read the
  allowed family voiceprints from `voiceprintStore.loadAll(...)` and call
  `gate.loadVoiceprints(...)`. On a `rejected` decision → **end the session
  immediately** (the existing session-close path). `forward`/`dropped` keep
  current behavior.

### 4. Voiceprint lifecycle (IPC)

- New IPC `assistant:finalizeEnrollment(speakerId)` — called when the enrollment
  recorder closes ("Done"); the service calls `voiceprintStore.compute(id,
  clipsDir)` and pushes a snapshot. (Recompute on re-record happens the same way
  when the recorder closes again.)
- `deleteSpeaker` also calls `voiceprintStore.delete(id)` (alongside the SP1
  `enrollmentStore.deleteSpeakerClips`).
- `EnrolledSpeaker` gains `hasVoiceprint: boolean` (so the Family list can show a
  "voiceprint ready" hint — optional UI).

## Data flow

```
wake fires → session opens → gate.start() → gate.loadVoiceprints(allowed family)
  first VAD segment:
     best family match >= 0.6 ? lock to THIS voice + forward : "rejected"
  "rejected" → controller ends the session (TV can't hold it open)
  later segments: match locked voice >= 0.6 ? forward : drop
session end / barge-in → gate.reset()
```

## Error handling & edge cases

- **No voiceprints enrolled** → open-mic fallback (above); James works pre-enrollment.
- **sherpa-onnx / titanet model missing** → `voiceprintStore.compute` fails →
  service logs + surfaces "speaker-lock offline"; the gate, given an empty family
  list, degrades to open-mic. No crash.
- **Voiceprint compute on a speaker with 0 clips** → no file written; `loadAll`
  skips them (they simply aren't gating candidates).
- **Wake fired by family but first words are noise/short** → VAD's
  `min_speech_duration` (0.25 s) avoids embedding sub-word blips; if the first
  segment mis-rejects, the user repeats (acceptable per "end immediately").
- **A disallowed (`allowed=false`) member** → excluded from `loadAll`, so their
  voice can't lock the session.

## Testing

Matches the repo's pure-function-first test style.

- **Pure:** `mean_voiceprint` (averaging + renormalize on fixture vectors); the
  gate decision as an extracted pure function `decide(refs, locked, emb, thresh)
  → "forward"|"drop"|"rejected"|"lock"` (drive embeddings + threshold, assert
  the verdict) in a small `sidecar/test_speakerlock.py`.
- **`voiceprintStore.test.ts`** (temp dir): compute (with a fake embed binary or
  a small real run) → store → loadAll filters by allowed → delete.
- **Offline** (`speaker_embed`): embed two clips of the same enrolled speaker →
  high cosine; a different speaker (a macOS `say` voice) → low; assert lock vs
  reject around 0.6.
- **Regression:** existing `liveController` / gate tests stay green; the open-mic
  fallback path is covered so pre-enrollment behavior is unchanged.

## Scope

**In scope (SP2):** `speaker_embed.py`, voiceprint compute + store + lifecycle
IPC, gate membership/hard-lock/reject logic, controller `loadVoiceprints` +
end-on-reject, the open-mic fallback, `hasVoiceprint` on the summary, tests.

**Out of scope:** any new enrollment UI beyond an optional "voiceprint ready"
hint (SP1 already captures clips); re-running the **wake-model** retrain when new
members enroll (that's SP3); multi-speaker conversations (explicitly rejected —
hard-lock to the waker); cloud speaker ID.
