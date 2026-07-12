# FamilyHub wake-word sidecar

Always-on local **keyword spotter** for the "hey James" wake phrase. Once it
fires the app opens Gemini Live, which does the actual transcription.

## Engines (switchable)

Selected via `--engine` or `FAMILYHUB_WAKE_ENGINE`:

- **`twostage` (default)** — Stage 1 is an [openWakeWord](https://github.com/dscripka/openWakeWord)
  ONNX classifier (`models/hey_james.onnx`, custom-trained for "hey james", committed)
  flagging candidates with high recall. On a candidate the sidecar buffers a short
  post-trigger window so the full word lands, then Stage 2 free-decodes the ~2 s tail
  with a sherpa-onnx **Moonshine tiny.en** recognizer and confirms only if it actually
  transcribes "james" (or a curated alias). A false wake needs both stages wrong at once.
  Threshold via `FAMILYHUB_WAKE_THRESHOLD` (default `0.5`, recall-first).
- **`vosk`** — Vosk ASR constrained to a `["james","[unk]"]` grammar with a confidence
  gate. ~40 MB model, no general-speech drift. Offline fallback: `FAMILYHUB_WAKE_ENGINE=vosk`.

## Setup

```bash
cd sidecar
PYTHON_BIN=python3.11 ./setup.sh
```

Requires **Python ≥ 3.10**. Creates `sidecar/.venv`, installs the engines and
downloads the Moonshine confirm model + Vosk fallback model into `models/`. The
openWakeWord `hey_james.onnx` is committed (no download). The Electron main process
auto-discovers `sidecar/.venv/bin/python` and `sidecar/wake_listener.py`.
Overrides: `FAMILYHUB_SIDECAR_PYTHON`, `FAMILYHUB_SIDECAR_SCRIPT`,
`FAMILYHUB_WAKE_ENGINE`, `FAMILYHUB_WAKE_THRESHOLD`, `FAMILYHUB_WAKE_MODEL`,
`FAMILYHUB_MOONSHINE_MODEL`.

## Self-test (recommended)

Verifies wake detection end-to-end without the GUI/mic — synthesizes speech with
`say` and streams it through the sidecar:

```bash
./.venv/bin/python selftest.py
```

Expected: `PASS — wakes on 'Hey James', quiet otherwise.` (exit 0). Test the Vosk
engine with `FAMILYHUB_WAKE_ENGINE=vosk ./.venv/bin/python selftest.py`.

## Training the openWakeWord model

`models/hey_james.onnx` is produced off-device via openWakeWord's synthetic pipeline.
See `training/README.md` for the reproducible recipe (Piper TTS positives + noise/
negatives, ONNX export). For better real-room recall, fold in clips recorded on the
appliance with `record_wake.py`.
For the end-to-end owner personalization workflow (record → fold → retrain → gated
promote → rollback) see `training/README.md` § *Personalizing on the owner's voice*.

## Protocol

Newline-delimited over stdio: base64 int16 LINEAR16 @16 kHz frames in (or
`{"cmd":"reset"}`), `{"type":"partial"|"final","text","words":[]}` JSON out. The
first line is an empty `partial` ready-signal once the wake engine loads — this
fires **before** the (optional, ~600 MB) ambient transcriber initializes, so a
fresh launch's listener-ready state never waits on the larger ambient model; a
transcript containing the wake phrase is emitted only when one is confidently
detected.

## Ambient Mode

Always-on local transcription of *everything* said in the kitchen (not just the
wake phrase), feeding a long-term memory store and a proactive suggestion loop
in the Electron main process. The sidecar's role is limited to segmentation +
transcription; Electron owns memory, triggers, and the suggestion UI. See
`docs/superpowers/specs/2026-07-11-ambient-mode-design.md` for the full design.

### Sidecar side (this directory)

- **VAD:** Silero (`models/silero_vad.onnx`) via sherpa-onnx's
  `VoiceActivityDetector`, taps the same 16 kHz frame stream already used for
  wake detection (one mic owner, one fork point — wake logic is untouched).
- **ASR:** each voiced segment is decoded offline by sherpa-onnx —
  **NVIDIA Parakeet-TDT v3 int8** (`models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`)
  when that model dir is present, else the already-shipped **Moonshine tiny**
  fallback (`models/sherpa-onnx-moonshine-tiny-en-int8`). Same runtime the wake
  verifier chain already uses — no new ML dependency.
- **Output:** on segment end, one extra stdout protocol line:
  `{"type":"utterance","text":"...","t0":<epoch s>,"t1":<epoch s>,"engine":"parakeet-tdt-0.6b-v3-int8"|"moonshine-tiny"}`.
- **Control:** `{"cmd":"ambient","on":bool}` on stdin enables/disables ambient
  capture without touching wake (`on` defaults to `true` if omitted). Electron
  sends `on:false` when a Gemini Live session opens and `on:true` when it
  closes, so session speech is never double-transcribed. `{"cmd":"reset"}`
  also drops any half-collected ambient segment.
- Failure isolation: `AmbientTranscriber.feed()` never raises — a decode error
  drops that segment and logs to stderr; ambient failures never take down wake.
- Env: `FAMILYHUB_AMBIENT_ASR` overrides the Parakeet model directory.

### Electron side (`apps/electron/src/main/ambient/`)

- **`memoryStore.ts`** — `node:sqlite` + `sqlite-vec`, DB at
  `~/.familyhub/memory.sqlite`. Tables: `utterances` (ambient / session speech,
  `source` = `ambient`|`session_user`|`session_james`), `facts` (nightly
  digest output), `suggestions` (trigger card lifecycle:
  `shown`→`accepted`|`dismissed`|`expired`). Embeddings are written async and
  backfilled — a missing Ollama never blocks the transcript write path.
- **`ollama.ts`** — local LLM client for embeddings + trigger classification.
- **`triggerEngine.ts`** — after each ambient utterance, sends the last
  ~500 words of context to Ollama with a JSON schema
  (`trigger`, `kind`, `confidence`, `suggestion`, `payload`); fires a
  suggestion only when `trigger && confidence >= 0.7`. Queue-depth-1 (latest
  window wins), with a similarity-based dedupe/cooldown against recent
  suggestions and a 2-minute cooldown after a dismissal.
- **`suggestionService.ts`** + renderer card — chime + on-screen card,
  accept by tap or voice ("yes/sure/ok ... james"), auto-expires after 30 s.
- **Memory tools for Gemini Live** (`liveSession.ts`) — `search_memory(query,
  daysBack?)` and `forget_memory(query)` are added to the session tool
  declarations so James can search household memory and honor "James, forget
  that" during a live session (deletion requires a live session; there is no
  local-only "forget" path).
- **`factsDigest.ts`** — nightly (~03:30 local, catch-up on launch) pass that
  distills durable facts from the day's utterances into the `facts` table,
  with `expires_at` for time-bound facts.

### Env knobs (Electron side)

| Var | Default | Meaning |
|---|---|---|
| `FAMILYHUB_AMBIENT` | on | `0`/`off`/`false`/`no` disables ambient capture, memory, and triggers entirely (kill switch). |
| `FAMILYHUB_AMBIENT_ASR` | `sidecar/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` | Sidecar-side: path to the Parakeet model dir; falls back to Moonshine if absent. |
| `FAMILYHUB_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama server base URL, used for both embeddings and trigger classification. |
| `FAMILYHUB_AMBIENT_LLM` | `qwen3:4b` | Chat model used by the trigger engine (and `scripts/trigger-bench.mjs`). |
| `FAMILYHUB_AMBIENT_EMBED_MODEL` | `nomic-embed-text` | Embedding model for utterances/facts/suggestion dedupe vectors. |

### Ollama prerequisite

Ambient triggers and semantic memory search need a local Ollama server:

```bash
brew install ollama
ollama pull qwen3:4b
ollama pull nomic-embed-text
```

**Graceful degradation without Ollama:** transcripts are still captured and
stored in `utterances` (raw text is never lost); embeddings queue up and
backfill automatically once Ollama becomes reachable; the trigger loop is
silently off (no suggestion cards) until then. No crash, no blocked audio
path — see `memoryStore.ts` and `triggerEngine.ts`.

### Memory DB and the "forget" flow

All ambient and session transcripts persist in `~/.familyhub/memory.sqlite`
(raw forever, plus a nightly facts digest). Saying **"James, forget that"**
(or any query naming what to remove) during a live session invokes the
`forget_memory` tool, which vector-searches for the best-matching
utterances/facts, deletes them, and has James confirm verbally what was
removed.

### Trigger-quality bench

`apps/electron/scripts/trigger-bench.mjs` replays a labeled corpus of ~50
kitchen-conversation windows (`trigger-corpus.jsonl`) against a live Ollama
server, using a byte-for-byte copy of the real `triggerEngine.ts` prompt and
JSON schema (kept in sync by hand — see the comment at the top of the
script), and reports precision/recall against the labels:

```bash
ollama serve            # in another terminal
node scripts/trigger-bench.mjs
```

Current: **recall 0.900, precision 1.000** on the 50-window corpus (target
was recall ≥ 0.8, false-trigger rate ≤ 1 per 30 min of negative transcript —
both met with 0 false positives).
