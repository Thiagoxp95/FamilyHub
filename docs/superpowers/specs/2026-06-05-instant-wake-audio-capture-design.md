# Instant-Wake Audio Capture — Design

**Date:** 2026-06-05
**Status:** Approved (pending spec review)
**Area:** `apps/electron/src/main/assistant`, `apps/electron/src/renderer`

## Problem

Today the user must say the wake word ("James") and then **wait** for the Gemini
Live connection to open before speaking their request. Anything spoken during
detection + connection is lost. The goal: **say "James" and immediately keep
talking naturally**, with nothing lost while the session is being established.

### Why the wait exists today

1. The **renderer** fills a ~2.5 s mic buffer, then ships it to Google Speech
   `recognize` (a network round-trip) purely to check for the wake phrase. This
   runs every ~2.5 s while idle, so it is also a recurring Google cost.
2. On a wake hit, the **main process** opens a fresh Gemini Live websocket
   (`session.start()` — another round-trip).
3. Only *after* the socket is open does main tell the renderer to switch to
   `"live"` mode. At that mode switch the renderer executes
   `pendingSamples = []`, **discarding everything spoken during detection +
   connect**.

So the perceived wait = `(2.5 s chunk + Google round-trip)` +
`(websocket connect)`, and every word in that window is thrown away.

## Decisions (locked)

| Fork | Decision |
| --- | --- |
| Always-on local listener | **Parakeet v3 local streaming ASR** (`parakeet-tdt-0.6b-v3` via `parakeet-mlx`) |
| How captured content enters Gemini | **Replay buffered audio** (queue post-wake PCM, flush on open, then stream live) |
| Platform for v1 | **Apple Silicon (macOS) only** |

A key consequence of "replay buffered audio": because Gemini hears **nothing**
before its socket opens, there is **no fuzzy text dedup to build**. "Dedup"
collapses into a clean **exactly-once, in-order handoff** between buffered and
live audio frames.

## Architecture

**Main-process orchestrator + Parakeet sidecar; the renderer becomes a dumb
audio device.**

Today the *renderer* owns the `wake`/`live` mode machine, runs `detectWake`, and
decides when to stream — and that is precisely what drops audio. We invert it:

- The **renderer** only **captures mic PCM and always streams every frame to
  main, and plays replies**. No mode machine, no wake detection.
- The **main process** owns everything: feeds every frame to the Parakeet
  sidecar, keeps a rolling pre-roll buffer, detects "James", opens Gemini,
  buffers across the connect, and flushes on open.

### Alternatives rejected

- **ASR in the renderer (wasm/Web):** Parakeet has no real browser build; MLX is
  Python-only. Rejected.
- **Node-native / ONNX engine in-process (no Python):** contradicts the Parakeet
  choice; only relevant if we later go cross-platform. Deferred.

## Components

- **Renderer (simplified).** Capture 16 kHz LINEAR16 mono (already does), stream
  *every* frame to main over IPC, play streamed replies. The `wake`/`live` mode
  logic and the `detectWake` loop are **deleted** here. UI reflects state pushed
  from main (idle / connecting / live, plus "heard" and "reply" text).
- **Parakeet sidecar (new).** Long-lived Python process (`parakeet-mlx`, model
  `parakeet-tdt-0.6b-v3`) reading raw PCM from stdin and emitting JSON lines:
  `{ type: "partial" | "final", text, words: [{ word, startMs, endMs }] }`.
  Hidden behind a `LocalTranscriber` interface so it can be faked in tests.
- **Listener orchestrator (new, in main).** The state machine, the frame router,
  and the seam. Written as **pure, testable functions** with no Electron or
  network types — it takes frames + events in and produces ordered "send these
  frames to the session" instructions out.
- **Reused.** `gating.ts` wake-phrase matching runs on the sidecar transcript
  stream. `GeminiLiveSession` is unchanged. The `assistant:liveFrame` transport
  is mostly unchanged.

## Data flow & the seam (core)

State machine in main: `idle → connecting → live → closing → idle`.

```
onFrame(frame):
  sidecar.write(frame)                  // ASR always hears the mic (cheap, local)
  if phase == idle:  preroll.push(frame)        // rolling ~2 s ring buffer
  else:              queue.push(frame); pump()  // buffer across connect, then live

onWake():                                // gating.ts matches "james" in transcript
  if phase != idle: return
  phase = connecting
  queue = preroll.drain()                // seed with pre-roll so words spoken right
  startGemini()                          // after "James" (before detection finished)
                                         // are NOT lost
  // on socket open: phase = live; pump()

pump():
  if phase != live or !session.isOpen: return
  while queue.length: session.sendAudioFrame(queue.shift())  // exactly-once, in-order
```

### Rolling pre-roll — why it matters

Parakeet only *reports* "James" a few hundred ms after it is spoken, so by
detection time the user is already mid-request. Seeding the flush queue from a
rolling pre-roll ring buffer (~2 s) recovers those words. Replaying "James"
itself into Gemini is harmless (it is addressed to the assistant), so v1 does
**not** precisely trim the wake word — this keeps the implementation simple
(YAGNI). Precise trimming via the word timestamps is a possible later refinement.

### Why this is exactly-once

A single ordered queue is the only path from "buffered" to "sent". Frames are
never sent anywhere before the socket opens, so there is no source of
duplication against Gemini. The pump drains FIFO and keeps draining as new
frames arrive, so there is no reorder and no gap at the seam.

## Sidecar & packaging (macOS v1)

- A project-local managed Python environment (`uv` or `venv`) with
  `parakeet-mlx`, spawned by main over stdio.
- The model (~600 MB) downloads once on first run and is HuggingFace-cached.
- **Dev:** a setup script installs Python deps and the model.
- **Distribution:** freeze the sidecar with PyInstaller into electron-builder
  `extraResources`. This is a **follow-up**, not v1-blocking (v1 runs on the
  developer/owner's own Mac).
- New UI provider row: **"Local listener (Parakeet)"** with ready/missing status,
  driven by a config probe in `config.ts`.

## Error handling & edge cases

- **Gemini connect fails / times out** → drop the queue, return to `idle`,
  surface a status message.
- **Slow connect** → queue is capped (~30 s of audio) to bound memory.
- **Sidecar crash** → auto-restart; if it will not come up, surface "listener
  offline".
- **Wake fires again while connecting/live** → ignored.
- **Barge-in, idle-timeout, `end_conversation`** → unchanged from today.

## Testing

Matches the repo's existing vitest coverage style.

- **Pure unit tests:** the pre-roll ring buffer; the frame-router / seam state
  machine (drive a frame + event sequence, assert the exact ordered frames
  delivered to a fake session — no loss, no dup, no reorder); the sidecar
  JSON-line parser with fixtures.
- **Integration test:** fake `LocalTranscriber` + fake `GeminiLiveSession`
  exercising `idle → wake → connecting → open → flush`, asserting a seamless
  handoff.
- **Regression:** existing `gating`, `turns`, `service`, `liveSession`,
  `vendorAdapters` tests stay green.

## Scope

**In scope (v1):**

- Parakeet sidecar + `LocalTranscriber` interface.
- Main-process listener orchestrator (state machine, pre-roll, seam).
- Renderer simplification (dumb audio I/O; remove mode machine + `detectWake`).
- Buffer-across-connect + flush-on-open audio replay.
- UI status for the local listener; config probe.

**Out of scope (v1):**

- Fully removing Google Speech. The wake path stops using it, but the
  speaker-profile / enroll feature and the diagnostics chunk path
  (`submitAudioChunk`) remain. Full retirement is a follow-up.
- Speaker-identity gating on the live path (not enforced today; not added now).
- Precise wake-word trimming from the replayed audio.
- Windows / Linux support.
- PyInstaller distribution packaging (dev setup script suffices for v1).
