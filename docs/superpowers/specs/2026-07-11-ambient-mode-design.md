# Ambient Mode: Always-On Transcription, Proactive Suggestions, Long-Term Memory

**Date:** 2026-07-11
**Status:** Approved (architecture + UX approved by owner; remaining decisions delegated)

## Summary

Today James only acts when invoked with "Hey James". Ambient Mode adds three capabilities:

1. **Always-on local speech-to-text** — every utterance in the kitchen is transcribed on-device.
2. **Proactive trigger loop** — after each finalized utterance, a cheap local LLM scans the recent conversation window and decides whether James can help (e.g. "don't forget Saturday is Jonas's party" → suggest a reminder; "how far is the drive to NYC?" → offer to answer). Suggestions surface as a chime + on-screen card; James never speaks uninvited.
3. **Long-term memory** — every transcript (ambient and James sessions) is embedded into a local vector store. Gemini Live sessions get `search_memory` / `forget_memory` tools; a nightly digest distills durable facts.

Everything runs locally. No ambient audio or text ever leaves the Mac; the only cloud touch remains Gemini Live during explicit sessions.

## Decisions (settled during brainstorming)

| Decision | Choice |
|---|---|
| STT engine | **Local, swappable.** NVIDIA Parakeet-TDT v3 int8 via **sherpa-onnx** (already a sidecar dependency for Moonshine — zero new ML runtimes), VAD-segmented decodes behind a transcriber seam. Falls back to the bundled Moonshine model if the Parakeet model dir is absent. Soniox cloud backend can be added later if far-field accuracy disappoints. |
| Trigger model | **Local small LLM via Ollama** (`qwen3:4b` class), JSON-schema output. |
| Trigger UX | **Chime + on-screen suggestion card**, auto-dismiss ~30 s, accept by tap or voice. James never verbally interjects. |
| Memory retention | **Raw forever + facts digest.** All utterances kept indefinitely in a local store; nightly local-LLM pass distills durable facts into a curated layer searched first. "James, forget that" deletion supported. |
| Architecture | **Extend the Python sidecar** (Approach A). Sidecar does VAD + streaming STT and emits utterances on its existing stdout channel; Electron main owns triggers, memory, cards, and session tools. |

## Architecture

```
                         Python sidecar (extended)
mic frames (16 kHz) ──┬──> openWakeWord + verifier chain      (unchanged)
                      └──> Silero VAD ──> Parakeet v3 (MLX, streaming)
                                             │ {"type":"utterance",...} JSON lines on stdout
                                             ▼
                    Electron main — new src/main/ambient/ modules
        ┌──────────────┬──────────────────┬─────────────────────┐
        ▼              ▼                  ▼                     ▼
  memoryStore      triggerEngine     suggestionService     memory tools
  (better-sqlite3  (500-word window  (IPC → chime +        (search_memory /
  + sqlite-vec)    → Ollama LLM)     card in renderer)     forget_memory in
                                                           Gemini Live tools)
```

### Data flow rules

- **One mic owner, one fork point.** The sidecar already receives every mic frame for wake detection (base64 PCM lines on stdin). The ambient branch taps the same frames. Wake detection is byte-for-byte unchanged; ambient is purely additive.
- **Ambient pauses during Gemini Live sessions** (main sends `{"cmd":"ambient","on":false}` on session open, `on:true` on close). Session speech is instead ingested from Gemini's own transcription events (already surfaced as captions), stored tagged `source: "session"` with role (user/james). No double transcription, no echo pollution.
- **Ollama degradation.** If Ollama is unreachable: raw utterances still stored; embeddings queued and backfilled when Ollama returns; trigger loop silently off. Never block or crash the audio path.
- **Persistence** in `~/.familyhub/memory.sqlite`. Config knob `FAMILYHUB_AMBIENT=0` and a UI toggle disable the whole feature.

## Components

### 1. Sidecar: ambient transcription (`sidecar/ambient_transcriber.py`)

- Silero VAD (via sherpa-onnx `VoiceActivityDetector`) segments speech from the shared 16 kHz frame stream (silence hangover ~300 ms; min segment 400 ms to skip coughs/clatter).
- Each voiced segment is decoded offline by sherpa-onnx: Parakeet-TDT v3 int8 (nemo_transducer) when its model dir is present, else the already-shipped Moonshine tiny. Same runtime the wake verifier chain already uses — avoids the pinned-torch conflicts documented in `sidecar/README.md`.
- On segment end, emits one stdout line: `{"type":"utterance","text":"...","t0":<epoch s>,"t1":<epoch s>,"engine":"parakeet"}`.
- Honors stdin control commands: `{"cmd":"ambient","on":bool}`. Starts **on** by default when `FAMILYHUB_AMBIENT` is not `0`.
- `wake_listener.py` changes are limited to: instantiate the ambient module, pass frames to it, forward its control command. All wake logic untouched. (Another agent is actively editing `wake_listener.py` — keep this integration to the minimal seam and coordinate at merge time.)

### 2. Main: `parseTranscriptLine` extension + `AmbientBus`

- `localTranscriber.ts`'s `parseTranscriptLine` learns the `utterance` message type; `LiveController` forwards utterances to a new `AmbientBus` (event emitter) without touching wake/session logic.
- `AmbientBus` fans out to memoryStore, triggerEngine, and (while a card is visible) the voice-accept matcher.

### 3. Main: `memoryStore` (`src/main/ambient/memoryStore.ts`)

- `better-sqlite3` + `sqlite-vec`. Tables:
  - `utterances(id, ts, text, source TEXT /* ambient|session_user|session_james */, speaker TEXT NULL, embedding BLOB NULL)`
  - `facts(id, ts, text, source_utterance_ids, expires_at NULL, embedding BLOB)`
  - `suggestions(id, ts, kind, text, payload JSON, status /* shown|accepted|dismissed|expired */)`
- Embeddings via Ollama `/api/embed` (`embeddinggemma` or `nomic-embed-text`, whichever is installed; store model name per row so re-embedding is possible). Write utterance first, embed async, backfill.
- API: `addUtterance`, `search(query, {topK, layer: "facts"|"raw"|"both"})`, `forget(matchText | ids)`, `recentWindow(nWords)`.

### 4. Main: `triggerEngine` (`src/main/ambient/triggerEngine.ts`)

- On each ambient utterance: build window = last 500 words (from `recentWindow`), call Ollama chat with a JSON schema: `{trigger: boolean, kind: "reminder"|"calendar"|"question"|"shopping"|"other", confidence: 0-1, suggestion: string, payload: object}`.
- **Queue depth 1, latest wins**: if a check is in flight when a new utterance lands, drop the stale one and re-run on the newest window. Never backlog.
- Fire only when `trigger && confidence >= 0.7`.
- **Dedupe/cooldown**: embed the suggestion text; cosine similarity > 0.85 against any suggestion shown in the last 60 minutes → suppress. Also suppress all triggers for 2 minutes after a dismissal (the family said no; don't nag).
- Prompt includes today's date and household context (family member names from enrollment store) for better extraction.

### 5. Main + renderer: `suggestionService` and the card UI

- Main pushes `{suggestion}` over IPC; renderer plays a soft chime (reuse `audioClip.ts` infra) and shows a card: suggestion text + Accept / Dismiss. Auto-dismiss after 30 s → status `expired`.
- **Accept paths:** tap; or voice — while a card is visible, ambient utterances matching `/\b(yes|yeah|sure|ok(ay)?|do it)\b.*\bjames\b|\bjames\b.*\b(yes|yeah|sure|do it)\b/i` accept it.
- **On accept:** `reminder`/`calendar`/`shopping` kinds execute directly through the existing tool implementations (`calendarTools`, Reminders bridge) with the extracted payload — no Gemini session needed. `question` kind has no accept action in v1: the card shows the question with a "Say 'Hey James' to ask" hint (auto-starting a context-preloaded session needs a new session API — follow-up).
- **UI lesson applied** (Family Voices postmortem): the card gets its own scoped CSS class namespace, a CSS collision pass against existing selectors, and a manual visual check on the real dashboard before release — DOM-presence tests are not sufficient.

### 6. Main: memory tools for Gemini Live

- Add to the session tool declarations:
  - `search_memory(query: string, days_back?: number)` → top-5 facts + top-5 raw snippets, each with timestamp, source, speaker.
  - `forget_memory(query: string)` → finds best-matching utterances/facts, deletes them, returns what was deleted (James confirms verbally).
- System instruction gains one line telling James it has household memory and when to search it.

### 7. Main: nightly facts digest (`src/main/ambient/factsDigest.ts`)

- Runs at ~03:30 local (timer in main; catch-up on app launch if missed).
- Feeds the day's utterances to Ollama in chunks; extracts durable facts ("Jonas's party is Saturday 2026-07-18", "Marina prefers oat milk"), each with resolved absolute dates, embedded and stored in `facts`. Time-bound facts get `expires_at` (event date + 7 days) so stale facts fall out of search naturally.

## Error handling

- **Sidecar crash:** existing restart supervision applies; ambient module failure must not take down wake — Parakeet load errors disable ambient (log + surface once in assistant events) but leave wake running.
- **Ollama down:** store-and-backfill as above; a single "ambient triggers paused (Ollama unreachable)" info event, not repeated spam.
- **Disk:** raw text + 768-dim embeddings ≈ a few MB/month — no rotation needed; revisit if speaker audio is ever stored (it is not, only text).
- **Clock/timezones:** all timestamps stored as epoch; date resolution in prompts uses local timezone.
- **Privacy:** `FAMILYHUB_AMBIENT=0` kill switch (v1; an in-UI toggle is a follow-up); `forget_memory` tool; the memory DB lives under the user's home dir with default macOS protections.

## Testing

- **Unit (vitest):** window assembly, trigger JSON parsing/validation, dedupe-cooldown logic, queue-depth-1 semantics, memoryStore search/forget, voice-accept regex, `parseTranscriptLine` utterance type.
- **Sidecar (pytest):** VAD segmentation on fixture WAVs, utterance emission protocol, ambient on/off command; extend `selftest.py` to load Parakeet.
- **Trigger quality bench:** `sidecar/`-style harness (like `wake_bench.py`) — a labeled corpus of ~50 scripted household conversations (positive: reminders, questions, calendar; negative: chit-chat) measuring trigger precision/recall against the live Ollama model. Target: recall ≥ 0.8 on positives, false-trigger rate ≤ 1 per 30 min of negative transcript.
- **Manual QA:** real-kitchen run — card appears on party-mention, voice accept works, wake still works, session pause/resume of ambient, "forget that" round-trip. Visual CSS check on the real dashboard.

## Phases

1. **Phase 1 — Silent capture:** sidecar VAD+Parakeet, utterance protocol, memoryStore + embeddings + backfill, session-caption ingestion. No visible behavior change; verify transcript quality in the DB for a few days.
2. **Phase 2 — Memory for James:** `search_memory` / `forget_memory` tools, system-instruction line, nightly facts digest.
3. **Phase 3 — Proactive suggestions:** triggerEngine, chime + card UI, accept/dismiss paths, trigger bench.

Each phase is independently shippable and releasable.

## Implementation notes (post-hoc, Task 14)

Recorded where the shipped code diverged from this spec's wording:

- **SQLite binding:** `memoryStore.ts` uses Node's built-in `node:sqlite`
  (`DatabaseSync`) + `sqlite-vec`, not `better-sqlite3` as written above under
  "Architecture" and Component 3 — `node:sqlite` avoids an extra native
  dependency and was available in the target Node/Electron version.
- **Embedding model:** the shipped default is `nomic-embed-text` only
  (`FAMILYHUB_AMBIENT_EMBED_MODEL`), not "`embeddinggemma` or
  `nomic-embed-text`, whichever is installed" as Component 3 speculated —
  auto-detection between two models was not built; operators who want
  `embeddinggemma` can still set the env var.
- **Streaming vs. offline ASR:** the Architecture diagram's "Parakeet v3
  (MLX, streaming)" is not what shipped. `ambient_transcriber.py` uses
  sherpa-onnx's Silero VAD to segment speech, then does one offline decode
  per finished segment with sherpa-onnx Parakeet-TDT v3 int8 (falling back to
  Moonshine tiny) — consistent with the "Components" section's more precise
  description, just not the diagram's "streaming" label.
- Everything else (control-command shape, utterance protocol line, env knob
  names, memory tables, trigger schema/threshold, dedupe/cooldown, DB
  location, forget flow) matches the spec as designed.

## Implementation notes (post-hoc, final pre-merge review)

- **The `{"cmd":"ambient","on":bool}` control message is now actually sent.**
  Earlier in this branch's history, `wake_listener.py` accepted and honored
  the command, but nothing on the Electron side ever wrote it to the
  sidecar's stdin — the pause during a live session relied entirely on
  `liveController.ts`'s idle-only frame routing (mic frames simply stop
  reaching the sidecar once a session is live). `LiveController` now also
  calls the transcriber's (optional) `setAmbient(false)` when a session
  starts connecting and `setAmbient(true)` in `finalize()`, so the doc's
  original "Electron sends `on:false` on session open, `on:true` on close"
  claim is true as shipped. The idle-only frame routing remains the primary,
  load-bearing pause (it works even if a `LocalTranscriber` implementation
  omits `setAmbient`, or the IPC write is ever lost); the explicit command is
  belt-and-braces on top of it, not a replacement for it.
- **Ambient initializes after the wake-ready signal, not before.**
  `wake_listener.py` emits the `{"type":"partial","text":"","words":[]}`
  ready signal as soon as the (small, fast) wake engine loads; the ambient
  transcriber's `AmbientTranscriber.create()` (~600 MB Parakeet load) now
  runs afterward. Previously the ambient load ran first and delayed the
  UI's listener-ready state by however long that model took to load, on
  every launch — with no user-visible benefit, since ambient capture
  starting a few seconds later than wake detection is unnoticeable.
- `forget_memory` additionally now refuses degenerate queries (trimmed length
  < 3 characters) and caps any single call to 50 deletions (most-recent
  matches first), so a vague "forget that" or a mis-transcribed one-letter
  query can no longer mass-delete household memory in one shot.

## Out of scope (deliberately)

- Speaker diarization/attribution of ambient speech (future: match voice embeddings from Family Voices enrollment; schema already has a nullable `speaker` column).
- Soniox backend (interface accommodates it; not built now).
- James speaking up uninvited (explicitly rejected — Gemini owns barge-in per v0.0.21; ambient must not re-introduce any local interruption layer).
- Multi-room / multiple mics.
