# Family Enrollment UI + Capture — Design (Sub-project 1 of 3)

**Date:** 2026-06-07
**Status:** Approved (pending spec review)
**Area:** `apps/electron/src/renderer/src`, `apps/electron/src/main/assistant`

## Context

The owner wants an in-app flow to enroll each family member's voice by recording
several "Hey James" samples. Those samples will (later sub-projects) build
persistent voiceprints for speaker-ID and feed the offline wake-model retrain.

This is **Sub-project 1 of 3**:

1. **Family enrollment UI + capture** *(this spec)* — record + store per-person
   clips. Pure capture/storage/UI; no behavior change.
2. On-device speaker-ID (voiceprints; unify the session "first-speaker" gate).
3. Wake-model retrain from the enrolled clips (offline loop).

The codebase already has: `FileSpeakerProfileStore` (persists named profiles +
`allowed`), IPC `enrollSpeaker`/`setSpeakerAllowed`/`deleteSpeaker`, an
`onSnapshot` stream carrying `speakers[]`, and a renderer mic pipeline
(`getUserMedia → AudioContext → ScriptProcessor`, 16 kHz mono int16, currently
streamed continuously via `sendMicFrame`).

## Goal / success criteria

From the dashboard, the owner can: add a family member by name; record ~15
"Hey James" samples through a guided flow (prompt → ~2 s record → playback →
keep/redo → next); see each person's sample count; toggle `allowed`; delete a
person. Clips persist as 16 kHz mono PCM16 WAV under the profile. The wake/live
assistant is paused while the setup screen is open. No voiceprint or
wake-behavior changes here.

## Decisions (locked)

| Fork | Decision |
| --- | --- |
| Clip format | 16 kHz mono **int16 PCM**, reuse the existing renderer pipeline (byte-identical to wake/voiceprint inputs) |
| Sample length | **Fixed ~2 s window** per sample (phrase "Hey James" fits; matches wake clip format) |
| Samples/person | **~15** default ("Add more" allowed) — enough for a solid voiceprint and a real wake-training contribution |
| Phrase recorded | **"Hey James"** (serves both voiceprint and wake-training) |
| Mic ownership | **One owner at a time** — opening setup pauses wake streaming; enrollment owns the mic; closing resumes |
| Recorder API | Reuse **ScriptProcessor** (matches existing code) rather than introduce AudioWorklet |

## Architecture & components

New, focused files (keep `App.tsx`, already ~18 KB, from growing):

- **`renderer/src/FamilySetup.tsx`** — full-screen overlay. Renders the family
  list (name, sample count, allowed toggle, delete) from the snapshot's
  `speakers[]`; "Add" creates a profile; opens `EnrollmentRecorder` for a person.
- **`renderer/src/EnrollmentRecorder.tsx`** — guided per-person flow: shows
  `sample n / N` and the prompt "Say: Hey James", records a ~2 s window, lets the
  user **play back / redo / keep**, advances. Pure state machine over an injected
  recorder + IPC so it is testable.
- **`renderer/src/audioClip.ts`** — `recordClip(): Promise<Int16Array>` (capture
  a fixed ~2 s window of 16 kHz int16 from the mic) and `int16ToBase64`. Isolates
  Web Audio so the components stay testable.
- **`main/assistant/wav.ts`** — pure `pcm16ToWav(samples: Int16Array, sampleRate:
  number): Buffer` writing a 44-byte PCM WAV header + data. Unit-tested.
- **`main/assistant/enrollmentStore.ts`** — `saveClip(speakerId, pcm16)`,
  `countClips(speakerId)`, `deleteClip(speakerId, index)`, `deleteSpeakerClips(
  speakerId)`. Writes `speaker-profiles/<id>/clips/clip_NNNN.wav`. Co-located with
  `FileSpeakerProfileStore` and given the same `userDataDirectory`.

Reused unchanged: `FileSpeakerProfileStore`, the `enrollSpeaker` /
`setSpeakerAllowed` / `deleteSpeaker` IPC and service methods, the `onSnapshot`
stream.

## Recording mechanism (the tricky part)

The renderer must have a single mic owner at a time. Today an effect starts the
wake capture (AudioContext + ScriptProcessor → `sendMicFrame`).

- On **opening** Family Setup: call `stopListening()` (pause main-side wake/live)
  and tear down the renderer wake-capture AudioContext so the mic is free.
- During enrollment: `recordClip()` opens its own short-lived capture, buffers a
  fixed ~2 s window of int16 @ 16 kHz, closes, and returns the `Int16Array`.
- On **closing** Family Setup: resume `startListening()` and the wake capture.

`recordClip()` mirrors the existing capture setup (getUserMedia mono +
AudioContext at 16 kHz + ScriptProcessor(4096)) but accumulates into a buffer for
the window instead of streaming frames.

## Storage, IPC & data flow

- Clips: `<userData>/speaker-profiles/<speakerId>/clips/clip_NNNN.wav`
  (`NNNN` = zero-padded next index from `countClips`).
- New bridge methods (preload + `vite-env.d.ts` + main handlers):
  - `saveEnrollmentClip(speakerId: string, audioBase64: string): Promise<{ sampleCount: number }>`
    — main base64-decodes → `pcm16ToWav` → `enrollmentStore.saveClip` → returns new count.
  - `deleteEnrollmentClip(speakerId: string, index: number): Promise<{ sampleCount: number }>`
    — for "redo": removes the last clip.
- `SpeakerProfileSummary` gains `sampleCount: number` (populated by the service
  from `enrollmentStore.countClips` when building the snapshot); `deleteSpeaker`
  also calls `enrollmentStore.deleteSpeakerClips`.
- The setup UI renders from `onSnapshot`, calls the IPC, and re-renders on the
  next snapshot.

### Flow (record one sample)

```
EnrollmentRecorder.recordOne():
  pcm16  = await recordClip()                 // ~2 s, 16 kHz int16
  (optional) play back the buffer for review
  on keep:  saveEnrollmentClip(id, int16ToBase64(pcm16))  // main writes WAV, returns count
  on redo:  discard buffer, re-record
  advance until count >= target (default 15)
```

## Error handling & edge cases

- **Mic permission denied / no device** → inline message in the recorder; the
  Add/Enroll flow cannot record (Done still closes and resumes wake).
- **Save failure** (disk) → surfaced; sample not counted; user can retry.
- **Leaving mid-enrollment** → already-saved samples persist; the person simply
  has fewer samples (UI shows the count and an "under-enrolled" hint below target).
- **Empty name** → `enrollSpeaker` already rejects; surfaced.
- **Setup open while a live session is active** → opening setup ends/pauses the
  session (`stopListening`/`endLive`) before taking the mic.

## Testing

- **`wav.test.ts`** (pure): header fields (RIFF/WAVE/fmt/data sizes, sampleRate,
  16-bit mono), and that `data` length = `samples.length * 2`.
- **`enrollmentStore.test.ts`** (temp dir): save → file exists + count increments;
  delete last → count decrements; `deleteSpeakerClips` removes the dir.
- **`EnrollmentRecorder` flow** (RTL + a fake `recordClip`/IPC): records N,
  redo replaces the last, count/progress advance, "Done" calls resume.
- **Regression**: existing `profileStore`, IPC/service, and `App` tests stay green.

## Scope

**In scope (Sub-project 1):** the setup overlay, the guided recorder, clip
capture + WAV storage + counts, the two new IPC methods, `sampleCount` on the
summary, pausing the assistant during setup, tests.

**Out of scope (later sub-projects):** computing/persisting voiceprints; changing
who James responds to / unifying the live gate; exporting clips to the wake
retrain; on-appliance↔dev-box clip sync. No change to wake detection or the live
session beyond pause/resume around setup.
