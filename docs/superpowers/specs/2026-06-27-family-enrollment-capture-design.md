# Family Voice Enrollment — Capture + Storage + UI (Sub-project 1 of 2)

**Date:** 2026-06-27
**Status:** Approved — implementing via subagent-driven development
**Area:** `apps/electron/src/renderer/src`, `apps/electron/src/main/assistant`, `apps/electron/src/preload`

## Context

The owner wants an in-app flow so each family member can enroll their voice by
recording several "Hey James" samples, shipped to clients. Those clips later
(SP2) compute on-device voice embeddings that personalize wake **recall** (a
per-family voiceprint lets us safely lower the openWakeWord gate). This spec is
**SP1: capture + storage + UI only — no wake-behavior change.** It ships safely
on its own.

This supersedes the unbuilt 2026-06-07 `family-enrollment-ui-design` spec, whose
"codebase already has FileSpeakerProfileStore / enrollSpeaker IPC" assumption is
**no longer true** — verified: no speaker/profile store, enroll IPC, or
enrollment UI exists today. SP1 is greenfield.

## Current architecture (verified, the patterns to follow)

- **IPC/preload bridge:** `apps/electron/src/preload/index.ts` exposes
  `window.familyHub.{assistant,dashboard,updater}`. Pattern per capability: an
  `invoke("ns:action")` request method and a `makeSubscription("ns:event")`
  push channel. Handlers registered in `main/assistant/ipc.ts`; renderer types
  in `renderer/src/vite-env.d.ts` (`AssistantBridge`, `AssistantSnapshot`,
  `FamilyHubBridge`).
- **State:** `service.getSnapshot()` builds `AssistantSnapshot`; the renderer
  reads it via `assistant.getSnapshot()` + `onState` subscription.
- **Mic ownership:** `renderer/src/App.tsx` runs one capture graph
  (`getUserMedia → AudioContext → ScriptProcessor → sendMicFrame`) and controls
  wake via `assistant.startListening()` / `stopListening()`.
- **Overlay pattern:** `App.tsx`'s `HubFullscreen` (`hub-fullscreen-backdrop` /
  `-panel`) is the full-screen overlay idiom to mirror for Family Setup.
- **Test idiom (NO React Testing Library — only `vitest`):** pure logic is
  extracted and unit-tested directly (e.g. `UpdateControl.tsx` exports
  `badgeAction`/`badgeContent` + a `UpdateControlView`); pure reducers follow
  `main/assistant/listenerMachine.ts` (state + events + effects, tested in
  `listenerMachine.test.ts`); Views are asserted via
  `react-dom/server` `renderToStaticMarkup`. Main-process pure code +
  temp-dir store tests follow the existing `*.test.ts` style.

## Goal / success criteria

From the dashboard the owner can: open Family Setup; add a member by name; for a
member, record ~15 "Hey James" samples through a guided flow (prompt → ~2 s
record → playback → keep / redo → next); see each member's sample count; delete a
sample (redo) or a member. Clips persist as 16 kHz mono PCM16 WAV per member.
Wake/live is **paused while Family Setup is open** and resumes on close. No
voiceprint and no wake-behavior change in SP1.

## Decisions (locked)

| Fork | Decision |
| --- | --- |
| Clip format | 16 kHz mono **int16 PCM** (byte-identical to wake/embedding inputs); store as WAV |
| Sample length | Fixed **~2 s** window per sample |
| Samples/member | **~15** default ("Add more" allowed) |
| Phrase | **"Hey James"** |
| Mic ownership | One owner at a time — opening setup `stopListening()` + tears down the renderer capture; closing resumes |
| Recorder capture | Reuse the existing **ScriptProcessor** capture (mirror `App.tsx`), buffering a fixed window instead of streaming |
| Flow logic | A **pure reducer** (`enrollmentMachine`) drives prompt→record→review→keep/redo/next; the `.tsx` is a thin View — testable without RTL |
| Storage root | `<userData>/speaker-profiles/<memberId>/` (clips/ + meta) — new store, greenfield |

## Components (new, focused files)

### Main process
- **`main/assistant/wav.ts`** — pure `pcm16ToWav(samples: Int16Array, sampleRate:
  number): Buffer` (44-byte PCM WAV header + data). Unit-tested.
- **`main/assistant/enrollmentStore.ts`** — on-disk member + clip store under
  `<userData>/speaker-profiles/`:
  - `addMember(name) -> { id, name, sampleCount: 0 }` (id = slug+nonce; rejects empty name)
  - `listMembers() -> EnrolledMember[]` (`{ id, name, sampleCount }`, sampleCount = clip count)
  - `deleteMember(id)` (removes the member dir)
  - `saveClip(id, pcm16: Int16Array) -> { sampleCount }` (writes
    `clips/clip_NNNN.wav` via `pcm16ToWav`, next index = max existing + 1)
  - `deleteLastClip(id) -> { sampleCount }` (redo)
  - `clipsDir(id) -> string` (SP2 reads this)
  Temp-dir tested.
- **IPC (`ipc.ts`)** — register `enrollment:listMembers`, `:addMember`,
  `:deleteMember`, `:saveClip` (id, base64 pcm16), `:deleteLastClip`; each returns
  the updated member(s). Push `enrollment:members` on every change. Opening setup
  is handled renderer-side via existing `stopListening`/`startListening`.

### Preload + types
- **`preload/index.ts`** — add `window.familyHub.enrollment`:
  `listMembers()`, `addMember(name)`, `deleteMember(id)`, `saveClip(id, base64)`,
  `deleteLastClip(id)`, `onMembers(cb)` subscription.
- **`renderer/src/vite-env.d.ts`** — `EnrolledMember`, `EnrollmentBridge`, add
  `enrollment: EnrollmentBridge` to `FamilyHubBridge`.

### Renderer
- **`renderer/src/audioClip.ts`** (exists; has `int16ToBase64`) — add
  `recordClip(opts): Promise<Int16Array>`: open a short-lived
  `getUserMedia → AudioContext(16k) → ScriptProcessor` graph, buffer a fixed ~2 s
  window of int16, tear down, resolve. (The Web-Audio glue; the fixed-window
  accumulation math is a pure helper that IS unit-tested.)
- **`renderer/src/enrollmentMachine.ts`** — pure reducer: state
  `{ phase: "idle"|"recording"|"review", memberId, target, kept, lastClip? }`,
  events `{startRecord}|{clipCaptured,pcm}|{keep}|{redo}|{next}|{finish}`, and
  effects `{record}|{save,pcm}|{deleteLast}`. Mirrors `listenerMachine`. Fully
  unit-tested.
- **`renderer/src/EnrollmentRecorder.tsx`** — thin View over the machine + injected
  `recordClip` + `window.familyHub.enrollment`. Pure `recorderView(state)` helper +
  a `*View` asserted via `renderToStaticMarkup`.
- **`renderer/src/FamilySetup.tsx`** — full-screen overlay (mirror `HubFullscreen`):
  member list (name, sampleCount, delete), "Add member", launches the recorder.
  Pure helpers + `FamilySetupView` rendered to static markup.
- **`App.tsx`** — a "Family setup" entry (button near `MicPicker` in the header)
  toggles the overlay; opening calls `stopListening()` + tears down capture
  (bump `captureEpoch`), closing calls `startListening()`. (Reuse the existing
  `captureEpoch`/listening machinery.)

## Data flow (record one sample)
```
EnrollmentRecorder (machine "recording"):
  pcm16 = await recordClip()                  // ~2 s, 16 kHz int16
  → machine: clipCaptured(pcm16) → phase "review"  (optional playback)
  keep → enrollment.saveClip(id, int16ToBase64(pcm16)) → sampleCount++  → next
  redo → discard → phase "recording"
  until kept >= target (15)
```

## Error handling & edge cases
- **Mic permission denied / no device** → inline message in the recorder; "Done"
  still closes + resumes wake.
- **Save failure (disk)** → surfaced; sample not counted; retry.
- **Leave mid-enrollment** → saved samples persist; member shows the count + an
  "under-enrolled" hint below target.
- **Empty name** → `addMember` rejects; surfaced.
- **Setup opened while a live session is active** → opening ends/pauses the
  session (`stopListening`/`endLive`) before taking the mic.
- **Non-contiguous clips** (manual deletion) → next index = max existing + 1
  (never clobber).

## Testing
- `wav.test.ts` (pure): RIFF/WAVE/fmt/data sizes, 16-bit mono, sampleRate,
  `data` length = `samples.length * 2`.
- `enrollmentStore.test.ts` (temp dir): addMember/list/delete; saveClip writes a
  file + increments; deleteLastClip decrements + never clobbers; deleteMember
  removes the dir.
- `enrollmentMachine.test.ts` (pure): record→capture→review→keep advances + saves;
  redo replaces; finish at target; under-target stays.
- `audioClip.test.ts` (extend): the fixed-window accumulation helper (exact sample
  count for a 2 s window at 16 kHz, partial-frame handling).
- `EnrollmentRecorder` / `FamilySetup` Views: `renderToStaticMarkup` asserts the
  prompt, sample n/N, member list, under-enrolled hint.
- Regression: existing `App.test.tsx`, `micLoop.test.ts`, `audioClip.test.ts`
  stay green; wake path untouched (no `wake_listener.py` change in SP1).

## Scope
**In SP1:** the setup overlay + guided recorder, clip capture + WAV storage +
member CRUD + counts, the enrollment IPC + preload + types, pause/resume around
setup, tests.

**Out of SP1 (→ SP2):** computing/persisting voiceprints, the on-device
embedding model, any wake-detection change, on-appliance↔dev clip sync. SP1
writes clips the SP2 embedding step will read from `clipsDir(id)`.
