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
first line is an empty `partial` ready-signal once the wake engine loads — this
fires **before** the (optional, ~600 MB) ambient transcriber initializes, so a
fresh launch's listener-ready state never waits on the larger ambient model. A
wake emits `{"type":"final","text":"hey james","words":[]}`. Ambient mode (below)
adds `{"type":"utterance",...}` output lines and the `{"cmd":"ambient","on":bool}`
control command.

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
  when that model dir is present, else the **Moonshine tiny** fallback
  (`models/sherpa-onnx-moonshine-tiny-en-int8`; downloaded by `setup.sh` for
  dev, deliberately not bundled in packaged builds where Parakeet is
  guaranteed). `sherpa-onnx` in `requirements.txt` is owned by ambient — the
  livekit-wakeword wake path no longer uses it.
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
