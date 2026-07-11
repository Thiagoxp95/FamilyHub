# Ambient Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always-on local transcription of the kitchen, proactive "James can help" suggestion cards, and a queryable long-term memory for Gemini Live sessions.

**Architecture:** The Python wake sidecar gains an ambient branch (Silero VAD → sherpa-onnx Parakeet/Moonshine decode) that emits `{"type":"utterance",...}` lines on its existing stdout protocol. Electron main gains `src/main/ambient/` modules: a SQLite(+sqlite-vec) memory store, an Ollama client (embeddings + trigger LLM), a trigger engine, a suggestion service, and a nightly facts digest. Gemini Live gains `search_memory`/`forget_memory` tools. The renderer gains a suggestion card.

**Tech Stack:** Python (sherpa-onnx, numpy — already in sidecar), TypeScript/Electron, `node:sqlite` (`DatabaseSync`) + `sqlite-vec` npm (prebuilt loadable extension, no native compile), Ollama HTTP API on localhost, React 19, vitest, standalone Python test scripts.

**Spec:** `docs/superpowers/specs/2026-07-11-ambient-mode-design.md` — read it first.

## Global Constraints

- TypeScript compiles with `exactOptionalPropertyTypes: true` — `x: T | undefined` is NOT assignable to `x?: T`; conditionally omit keys instead.
- Lint is `eslint . --max-warnings=0` (run in `apps/electron/`) — one warning fails.
- TS tests: `npx vitest run <file>` in `apps/electron/`. Python tests follow the sidecar convention: STANDALONE scripts (no pytest — it is not installed) with assert-based test functions and a `run()` harness printing `[PASS]`/`[FAIL]` per case and exiting 0/1 (see `test_wake_bench.py` for the pattern). Run as `/Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python <test_file>.py` from the worktree's `sidecar/` directory — the venv lives in the MAIN checkout, not the worktree. Where the plan shows pytest-style test functions, keep the functions but call them from `run()`; replace pytest-only fixtures (e.g. `capsys`) with `contextlib.redirect_stdout(io.StringIO())`.
- Wake detection behavior must be byte-for-byte unchanged. The ONLY `wake_listener.py` edits allowed are the minimal ambient seam in Task 2.
- No cloud calls anywhere in the ambient path. Ollama is only ever `http://127.0.0.1:11434` (override `FAMILYHUB_OLLAMA_URL`).
- Env knobs (all read at startup unless noted): `FAMILYHUB_AMBIENT` (default on; `0/off/false/no` disables), `FAMILYHUB_OLLAMA_URL`, `FAMILYHUB_AMBIENT_LLM` (default `qwen3:4b`), `FAMILYHUB_AMBIENT_EMBED_MODEL` (default `nomic-embed-text`), `FAMILYHUB_AMBIENT_ASR` (override Parakeet model dir).
- Memory DB path: `~/.familyhub/memory.sqlite`. Embedding dim: 768.
- Every Ollama failure degrades gracefully (store text, skip triggers) — never crash or block the audio path.
- Commit after every task with a conventional message (`feat(ambient): …`, `test(ambient): …`).
- Do NOT publish releases, push, or touch `scripts/release.sh`/`ship.sh`.

---

## Phase 1 — Silent capture (Tasks 1–6, shippable: transcripts accumulate in DB, no visible change)

### Task 1: Sidecar `ambient_transcriber.py`

**Files:**
- Create: `sidecar/ambient_transcriber.py`
- Create: `sidecar/test_ambient_transcriber.py`
- Modify: `sidecar/setup.sh` (append model downloads)
- Modify: `apps/electron/scripts/build-sidecar-runtime.sh` (append same downloads)

**Interfaces:**
- Produces (used by Task 2):
  ```python
  class AmbientTranscriber:
      def __init__(self, vad, recognizer, sample_rate=16000, engine_name="unknown"): ...
      def feed(self, pcm_bytes: bytes) -> list[dict]   # 0+ finished utterances
      def set_enabled(self, on: bool) -> None           # off drops audio + clears segment state
      def reset(self) -> None
      @staticmethod
      def create() -> "AmbientTranscriber | None"       # loads real models; None + dlog on failure
  ```
- Utterance dict shape (the stdout protocol message, exactly):
  `{"type": "utterance", "text": str, "t0": float, "t1": float, "engine": str}` — t0/t1 are epoch seconds (`time.time()` based).

- [ ] **Step 1: Write the failing tests** (`sidecar/test_ambient_transcriber.py`)

Test with fakes — no models loaded. The class must accept injected `vad`/`recognizer` so tests are hermetic.

```python
import numpy as np
from ambient_transcriber import AmbientTranscriber


class FakeSegment:
    def __init__(self, samples):
        self.samples = samples  # float32 numpy array


class FakeVad:
    """Mimics the sherpa-onnx VoiceActivityDetector surface we use."""
    def __init__(self):
        self.fed = []
        self.segments = []          # queue of FakeSegment
        self.cleared = 0

    def accept_waveform(self, samples):
        self.fed.append(samples)

    def empty(self):
        return len(self.segments) == 0

    @property
    def front(self):
        return self.segments[0]

    def pop(self):
        self.segments.pop(0)

    def reset(self):
        self.cleared += 1


class FakeRecognizer:
    def __init__(self, text="hello world"):
        self.text = text
        self.decoded = 0

    def decode(self, samples, sample_rate):
        self.decoded += 1
        return self.text


def pcm(n_samples, value=1000):
    return (np.ones(n_samples, dtype=np.int16) * value).tobytes()


def test_feed_without_segments_returns_empty():
    vad, rec = FakeVad(), FakeRecognizer()
    at = AmbientTranscriber(vad, rec)
    assert at.feed(pcm(1600)) == []
    assert len(vad.fed) == 1


def test_feed_drains_segments_into_utterances():
    vad, rec = FakeVad(), FakeRecognizer("don't forget the party")
    at = AmbientTranscriber(vad, rec, engine_name="fake")
    vad.segments.append(FakeSegment(np.zeros(16000, dtype=np.float32)))
    out = at.feed(pcm(1600))
    assert len(out) == 1
    utt = out[0]
    assert utt["type"] == "utterance"
    assert utt["text"] == "don't forget the party"
    assert utt["engine"] == "fake"
    assert utt["t1"] >= utt["t0"] > 0
    assert vad.empty()


def test_empty_transcripts_are_dropped():
    vad, rec = FakeVad(), FakeRecognizer("   ")
    at = AmbientTranscriber(vad, rec)
    vad.segments.append(FakeSegment(np.zeros(1600, dtype=np.float32)))
    assert at.feed(pcm(160)) == []


def test_disabled_drops_audio_and_resets():
    vad, rec = FakeVad(), FakeRecognizer()
    at = AmbientTranscriber(vad, rec)
    at.set_enabled(False)
    assert at.feed(pcm(1600)) == []
    assert vad.fed == []          # nothing fed while off
    assert vad.cleared >= 1       # segment state cleared on disable
    at.set_enabled(True)
    at.feed(pcm(1600))
    assert len(vad.fed) == 1
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd sidecar && /Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python test_ambient_transcriber.py` (use `.venv/bin/python` if present)
Expected: FAIL — `ModuleNotFoundError: No module named 'ambient_transcriber'`

- [ ] **Step 3: Implement `sidecar/ambient_transcriber.py`**

```python
"""Ambient always-on transcription for the FamilyHub sidecar.

Silero VAD (sherpa-onnx VoiceActivityDetector) segments speech out of the
shared 16 kHz mic stream; each finished segment is decoded offline by a
sherpa-onnx recognizer — Parakeet-TDT v3 int8 (models/<parakeet dir>) when
present, else the Moonshine tiny model the wake verifier already ships.

This module NEVER raises out of feed(): any decode error drops that segment
and logs. Ambient failure must not disturb the wake path.
"""

import os
import sys
import time

import numpy as np

SAMPLE_RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))

PARAKEET_DIR = os.environ.get(
    "FAMILYHUB_AMBIENT_ASR",
    os.path.join(HERE, "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"),
)
MOONSHINE_DIR = os.environ.get(
    "FAMILYHUB_MOONSHINE_MODEL",
    os.path.join(HERE, "models", "sherpa-onnx-moonshine-tiny-en-int8"),
)
SILERO_VAD = os.path.join(HERE, "models", "silero_vad.onnx")


def _dlog(message):
    print(f"[ambient] {message}", file=sys.stderr, flush=True)


class _SherpaRecognizer:
    """Adapts a sherpa_onnx.OfflineRecognizer to `decode(samples, rate) -> str`."""

    def __init__(self, recognizer):
        self._recognizer = recognizer

    def decode(self, samples, sample_rate):
        stream = self._recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)
        self._recognizer.decode_stream(stream)
        return stream.result.text


class AmbientTranscriber:
    def __init__(self, vad, recognizer, sample_rate=SAMPLE_RATE, engine_name="unknown"):
        self._vad = vad
        self._recognizer = recognizer
        self._sample_rate = sample_rate
        self._engine_name = engine_name
        self._enabled = True

    def set_enabled(self, on):
        on = bool(on)
        if self._enabled and not on:
            # Drop any half-collected segment so stale audio can't surface later.
            try:
                self._vad.reset()
            except Exception:  # noqa: BLE001
                pass
        self._enabled = on

    def reset(self):
        try:
            self._vad.reset()
        except Exception:  # noqa: BLE001
            pass

    def feed(self, pcm_bytes):
        if not self._enabled or not pcm_bytes:
            return []

        samples = (
            np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        )

        utterances = []
        try:
            self._vad.accept_waveform(samples)
            while not self._vad.empty():
                segment = self._vad.front
                self._vad.pop()
                seg_samples = segment.samples
                duration = len(seg_samples) / float(self._sample_rate)
                now = time.time()
                text = self._recognizer.decode(seg_samples, self._sample_rate)
                text = (text or "").strip()
                if text:
                    utterances.append(
                        {
                            "type": "utterance",
                            "text": text,
                            "t0": now - duration,
                            "t1": now,
                            "engine": self._engine_name,
                        }
                    )
        except Exception as exc:  # noqa: BLE001 - ambient must never break the wake path
            _dlog(f"feed error (segment dropped): {exc}")

        return utterances

    @staticmethod
    def create():
        """Load real models. Returns None (with a log line) if anything is missing."""
        try:
            import sherpa_onnx
        except ImportError as exc:
            _dlog(f"sherpa_onnx unavailable: {exc}")
            return None

        if not os.path.isfile(SILERO_VAD):
            _dlog(f"silero vad model missing: {SILERO_VAD}")
            return None

        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = SILERO_VAD
        vad_config.silero_vad.threshold = 0.5
        vad_config.silero_vad.min_silence_duration = 0.3
        vad_config.silero_vad.min_speech_duration = 0.4
        # Cap a single segment; long monologues split at 15 s.
        vad_config.silero_vad.max_speech_duration = 15.0
        vad_config.sample_rate = SAMPLE_RATE
        vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=30)

        def parakeet_paths():
            enc = os.path.join(PARAKEET_DIR, "encoder.int8.onnx")
            dec = os.path.join(PARAKEET_DIR, "decoder.int8.onnx")
            joi = os.path.join(PARAKEET_DIR, "joiner.int8.onnx")
            tok = os.path.join(PARAKEET_DIR, "tokens.txt")
            if all(os.path.isfile(p) for p in (enc, dec, joi, tok)):
                return enc, dec, joi, tok
            return None

        engine_name = None
        recognizer = None
        paths = parakeet_paths()
        if paths:
            enc, dec, joi, tok = paths
            recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=enc,
                decoder=dec,
                joiner=joi,
                tokens=tok,
                model_type="nemo_transducer",
                num_threads=2,
            )
            engine_name = "parakeet-tdt-0.6b-v3-int8"
        elif os.path.isdir(MOONSHINE_DIR):
            recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine(
                preprocessor=os.path.join(MOONSHINE_DIR, "preprocess.onnx"),
                encoder=os.path.join(MOONSHINE_DIR, "encode.int8.onnx"),
                uncached_decoder=os.path.join(MOONSHINE_DIR, "uncached_decode.int8.onnx"),
                cached_decoder=os.path.join(MOONSHINE_DIR, "cached_decode.int8.onnx"),
                tokens=os.path.join(MOONSHINE_DIR, "tokens.txt"),
                num_threads=2,
            )
            engine_name = "moonshine-tiny"
        else:
            _dlog("no ambient ASR model found (parakeet or moonshine)")
            return None

        _dlog(f"ambient transcriber ready: {engine_name}")
        return AmbientTranscriber(vad, _SherpaRecognizer(recognizer), SAMPLE_RATE, engine_name)
```

NOTE for implementer: verify the exact sherpa-onnx VAD/moonshine constructor keyword names against the installed version (`python3 -c "import sherpa_onnx; help(sherpa_onnx.OfflineRecognizer.from_moonshine)"`) and against how `wake_listener.py`'s `MoonshineConfirmer` already builds its recognizer — copy that invocation style. Also verify `max_speech_duration` exists in the installed `SileroVadModelConfig`; if not, drop that line.

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd sidecar && /Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python test_ambient_transcriber.py`
Expected: 4 passed

- [ ] **Step 5: Append model downloads to `sidecar/setup.sh` and `apps/electron/scripts/build-sidecar-runtime.sh`**

Follow each script's existing download style (curl + tar into `models/`). Add, guarded by existence checks:

```bash
# Ambient mode: Silero VAD + Parakeet-TDT v3 int8 (ambient transcription).
MODELS_DIR="$(dirname "$0")/models"   # adjust to each script's existing models path variable
if [ ! -f "$MODELS_DIR/silero_vad.onnx" ]; then
  curl -L -o "$MODELS_DIR/silero_vad.onnx" \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
fi
if [ ! -d "$MODELS_DIR/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8" ]; then
  curl -L -o /tmp/parakeet-v3-int8.tar.bz2 \
    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2
  tar -xjf /tmp/parakeet-v3-int8.tar.bz2 -C "$MODELS_DIR"
  rm /tmp/parakeet-v3-int8.tar.bz2
fi
```

Verify both URLs respond (`curl -sIL <url> | head -1` → HTTP 200/302); if the v3 asset name differs, list the release assets and use the closest `parakeet-tdt-0.6b-v3` int8 variant, updating `PARAKEET_DIR` default to match. Run the setup.sh download once so the models exist locally.

- [ ] **Step 6: Smoke-test with real models** (not part of the unit tests)

Run: `cd sidecar && python3 -c "
from ambient_transcriber import AmbientTranscriber
at = AmbientTranscriber.create()
print('created:', at is not None)
"`
Expected: `created: True` (engine line on stderr). If Parakeet fails to load, Moonshine fallback must kick in.

- [ ] **Step 7: Commit**

```bash
git add sidecar/ambient_transcriber.py sidecar/test_ambient_transcriber.py sidecar/setup.sh apps/electron/scripts/build-sidecar-runtime.sh
git commit -m "feat(ambient): sidecar VAD+Parakeet ambient transcriber module"
```

---

### Task 2: Wire ambient into `wake_listener.py` (minimal seam)

**Files:**
- Modify: `sidecar/wake_listener.py` (main() only)
- Create: `sidecar/test_wake_listener_ambient.py`

**Interfaces:**
- Consumes: `AmbientTranscriber.create() / .feed() / .set_enabled()` (Task 1).
- Produces: `{"type":"utterance",...}` lines on stdout, interleaved with the existing wake `partial`/`final` lines. Stdin control: `{"cmd":"ambient","on":true|false}`.

- [ ] **Step 1: Write the failing test** (`sidecar/test_wake_listener_ambient.py`)

Test the helper we're about to extract, not the whole process:

```python
import wake_listener


class FakeAmbient:
    def __init__(self, out=None):
        self.out = out or []
        self.enabled = True
        self.fed = 0

    def feed(self, pcm):
        self.fed += 1
        return list(self.out)

    def set_enabled(self, on):
        self.enabled = on


def test_handle_ambient_command_toggles():
    ambient = FakeAmbient()
    wake_listener.handle_control({"cmd": "ambient", "on": False}, None, ambient)
    assert ambient.enabled is False
    wake_listener.handle_control({"cmd": "ambient", "on": True}, None, ambient)
    assert ambient.enabled is True


def test_handle_reset_still_resets_engine():
    class FakeEngine:
        def __init__(self):
            self.resets = 0
        def reset(self):
            self.resets += 1
    engine = FakeEngine()
    wake_listener.handle_control({"cmd": "reset"}, engine, None)
    assert engine.resets == 1


def test_ambient_utterances_emitted(capsys):
    ambient = FakeAmbient(out=[{"type": "utterance", "text": "hi", "t0": 1.0, "t1": 2.0, "engine": "fake"}])
    wake_listener.pump_ambient(ambient, b"\x00\x00")
    captured = capsys.readouterr()
    assert '"type": "utterance"' in captured.out or '"utterance"' in captured.out
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd sidecar && /Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python test_wake_listener_ambient.py`
Expected: FAIL — `AttributeError: module 'wake_listener' has no attribute 'handle_control'`

- [ ] **Step 3: Implement the seam in `wake_listener.py`**

Add two module-level helpers (near `emit`), then use them in `main()`:

```python
def handle_control(command, engine, ambient):
    """Dispatch one stdin JSON control command. Never raises."""
    cmd = command.get("cmd")
    if cmd == "reset":
        if engine is not None:
            engine.reset()
        if ambient is not None:
            # A session just ended (Electron resets on finalize): drop any
            # half-collected VAD segment so pre-session audio can't bridge
            # into a post-session utterance.
            ambient.reset()
    elif cmd == "ambient" and ambient is not None:
        ambient.set_enabled(bool(command.get("on", True)))


def pump_ambient(ambient, pcm):
    """Feed one frame to the ambient transcriber and emit its utterances."""
    if ambient is None:
        return
    for utterance in ambient.feed(pcm):
        emit(utterance)
```

In `main()`, after `engine, description = build_engine(...)`:

```python
    ambient = None
    if os.environ.get("FAMILYHUB_AMBIENT", "1").strip().lower() not in ("0", "off", "false", "no"):
        try:
            from ambient_transcriber import AmbientTranscriber
            ambient = AmbientTranscriber.create()
        except Exception as exc:  # noqa: BLE001 - ambient is optional, wake is not
            dlog(f"ambient disabled: {exc}")
    dlog(f"ambient: {'on' if ambient else 'off'}")
```

Replace the existing control-command block in the read loop:

```python
        if line.startswith("{"):
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            handle_control(command, engine, ambient)
            continue
```

And after the existing `if engine.feed(pcm): emit(...)` line add:

```python
        pump_ambient(ambient, pcm)
```

No other `wake_listener.py` changes are permitted.

- [ ] **Step 4: Run ALL sidecar tests**

Run: `cd sidecar && /Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python test_wake_listener_ambient.py && /Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python test_ambient_transcriber.py` then any pre-existing standalone sidecar tests (e.g. `/Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python test_wake_bench.py`)
Expected: all pass (pre-existing failures, if any, must be reported not fixed).

- [ ] **Step 5: Commit**

```bash
git add sidecar/wake_listener.py sidecar/test_wake_listener_ambient.py
git commit -m "feat(ambient): emit ambient utterances from wake sidecar (minimal seam)"
```

---

### Task 3: TypeScript utterance parsing + handler plumbing

**Files:**
- Modify: `apps/electron/src/main/assistant/localTranscriber.ts`
- Modify: `apps/electron/src/main/assistant/localTranscriber.test.ts` (or create if absent — check first)

**Interfaces:**
- Produces (used by Tasks 6):
  ```ts
  export interface AmbientUtterance {
    type: "utterance";
    text: string;
    t0: number;   // epoch seconds
    t1: number;
    engine: string;
  }
  export function parseUtteranceLine(line: string): AmbientUtterance | null;
  // LocalTranscriberHandlers gains: onUtterance?: (utterance: AmbientUtterance) => void;
  ```
- `WakeWordSidecar.start()` stdout handling becomes: try `parseTranscriptLine` → `handlers.onTranscript`; else try `parseUtteranceLine` → `handlers.onUtterance?.(...)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { parseUtteranceLine } from "./localTranscriber";

describe("parseUtteranceLine", () => {
  it("parses a well-formed utterance line", () => {
    const line = JSON.stringify({
      type: "utterance", text: "jonas party is saturday", t0: 100.5, t1: 103.2, engine: "parakeet",
    });
    expect(parseUtteranceLine(line)).toEqual({
      type: "utterance", text: "jonas party is saturday", t0: 100.5, t1: 103.2, engine: "parakeet",
    });
  });

  it("rejects wake transcript lines", () => {
    expect(parseUtteranceLine(JSON.stringify({ type: "final", text: "hey james", words: [] }))).toBeNull();
  });

  it("rejects garbage and missing fields", () => {
    expect(parseUtteranceLine("not json")).toBeNull();
    expect(parseUtteranceLine(JSON.stringify({ type: "utterance", text: 5 }))).toBeNull();
    expect(parseUtteranceLine(JSON.stringify({ type: "utterance", text: "x", t0: "a", t1: 2, engine: "e" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail** — `cd apps/electron && npx vitest run src/main/assistant/localTranscriber.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement**

In `localTranscriber.ts` add after `TranscriptMessage`:

```ts
export interface AmbientUtterance {
  type: "utterance";
  text: string;
  t0: number;
  t1: number;
  engine: string;
}

// Pure: one stdout line → an ambient utterance, or null if it is not one.
export function parseUtteranceLine(line: string): AmbientUtterance | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (
    record.type !== "utterance" ||
    typeof record.text !== "string" ||
    typeof record.t0 !== "number" ||
    typeof record.t1 !== "number" ||
    typeof record.engine !== "string"
  ) {
    return null;
  }

  return { type: "utterance", text: record.text, t0: record.t0, t1: record.t1, engine: record.engine };
}
```

Extend the handlers interface (optional member keeps every existing implementer compiling):

```ts
export interface LocalTranscriberHandlers {
  onTranscript: (message: TranscriptMessage) => void;
  onUtterance?: (utterance: AmbientUtterance) => void;
  onError: (message: string) => void;
  onExit: (code: number | null) => void;
}
```

In `WakeWordSidecar.start()` replace the stdout line handler body:

```ts
    stdout.on("line", (line) => {
      const message = parseTranscriptLine(line);
      if (message) {
        handlers.onTranscript(message);
        return;
      }

      const utterance = parseUtteranceLine(line);
      if (utterance) {
        handlers.onUtterance?.(utterance);
      }
    });
```

CAUTION: `parseTranscriptLine` currently maps unknown `type` values to null — verify it returns null (not a mangled message) for `type:"utterance"` lines; the test in Step 1 covers this via `rejects wake transcript lines` in reverse. If `parseTranscriptLine` accepts `"utterance"` lines, tighten it.

- [ ] **Step 4: Run tests + typecheck** — `npx vitest run src/main/assistant/ && npm run typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/assistant/localTranscriber.ts apps/electron/src/main/assistant/localTranscriber.test.ts
git commit -m "feat(ambient): parse sidecar utterance lines in main process"
```

---

### Task 4: `MemoryStore` (SQLite + sqlite-vec)

**Files:**
- Create: `apps/electron/src/main/ambient/memoryStore.ts`
- Create: `apps/electron/src/main/ambient/memoryStore.test.ts`
- Modify: `apps/electron/package.json` (add dependency `sqlite-vec`)

**Interfaces:**
- Produces (used by Tasks 5, 6, 8, 9, 10, 11):
  ```ts
  export type UtteranceSource = "ambient" | "session_user" | "session_james";
  export interface StoredUtterance { id: number; ts: number; text: string; source: UtteranceSource; speaker: string | null; }
  export interface MemoryHit { id: number; ts: number; text: string; source: string; layer: "raw" | "fact"; score: number; }
  export interface SearchOptions { topK?: number; layer?: "raw" | "fact" | "both"; sinceTs?: number; }

  export class MemoryStore {
    constructor(dbPath: string);           // ":memory:" works for tests
    readonly vectorSearchAvailable: boolean; // false if sqlite-vec failed to load
    addUtterance(text: string, source: UtteranceSource, ts?: number): number;
    addFact(text: string, sourceIds: number[], expiresAt: number | null): number;
    recentWindow(maxWords: number): StoredUtterance[];          // oldest→newest, ambient+session
    pendingEmbeddings(limit: number): Array<{ table: "utterances" | "facts"; id: number; text: string }>;
    setEmbedding(table: "utterances" | "facts", id: number, vector: Float32Array, model: string): void;
    search(queryVector: Float32Array | null, queryText: string, opts?: SearchOptions): MemoryHit[];
    forget(matchText: string): { deleted: number; texts: string[] };
    addSuggestion(kind: string, text: string, payload: Record<string, unknown>): number;
    setSuggestionStatus(id: number, status: "accepted" | "dismissed" | "expired"): void;
    recentSuggestions(sinceTs: number): Array<{ id: number; ts: number; text: string }>;
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
    utterancesBetween(t0: number, t1: number): StoredUtterance[]; // for the digest
    close(): void;
  }
  ```
- Timestamps are epoch **milliseconds** everywhere in TS (`Date.now()`).
- Uses `node:sqlite` `DatabaseSync` (no native compile). sqlite-vec loads via `allowExtension: true` + `sqliteVec.getLoadablePath()`. If either is unavailable, `vectorSearchAvailable=false` and `search` falls back to LIKE-based text match — construction must NOT throw.

- [ ] **Step 1: Verify `node:sqlite` + sqlite-vec work in this environment**

```bash
cd apps/electron && npm install sqlite-vec
node -e "
const { DatabaseSync } = require('node:sqlite');
const sv = require('sqlite-vec');
const db = new DatabaseSync(':memory:', { allowExtension: true });
db.loadExtension(sv.getLoadablePath());
db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[4])');
const ins = db.prepare('INSERT INTO v(rowid, embedding) VALUES (?, ?)');
ins.run(1n, new Uint8Array(new Float32Array([1,0,0,0]).buffer));
const row = db.prepare('SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 1')
  .get(new Uint8Array(new Float32Array([1,0,0,0]).buffer));
console.log('OK', row);
"
```
Expected: `OK { rowid: 1n, distance: 0 }` (shape may vary). If `node:sqlite` is missing or extension loading fails, STOP and report — the fallback plan is the `better-sqlite3` package, which changes this task; do not improvise silently.

- [ ] **Step 2: Write the failing tests** (abridged here to the essential behaviors — write all of these)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memoryStore";

let store: MemoryStore;
beforeEach(() => { store = new MemoryStore(":memory:"); });
afterEach(() => { store.close(); });

describe("MemoryStore", () => {
  it("stores and windows utterances oldest→newest capped by word count", () => {
    store.addUtterance("one two three", "ambient", 1000);
    store.addUtterance("four five", "ambient", 2000);
    store.addUtterance("six seven eight nine", "ambient", 3000);
    const window = store.recentWindow(7);
    expect(window.map((u) => u.text)).toEqual(["four five", "six seven eight nine"]);
  });

  it("backfills embeddings and reports pending", () => {
    const id = store.addUtterance("hello", "ambient");
    expect(store.pendingEmbeddings(10)).toEqual([{ table: "utterances", id, text: "hello" }]);
    store.setEmbedding("utterances", id, unitVector(0), "test-model");
    expect(store.pendingEmbeddings(10)).toEqual([]);
  });

  it("vector-searches when embeddings exist", () => {
    const a = store.addUtterance("jonas party saturday", "ambient");
    const b = store.addUtterance("the oven is broken", "ambient");
    store.setEmbedding("utterances", a, unitVector(0), "m");
    store.setEmbedding("utterances", b, unitVector(1), "m");
    const hits = store.search(unitVector(0), "party", { layer: "raw", topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(a);
  });

  it("falls back to LIKE search without a query vector", () => {
    store.addUtterance("jonas party saturday", "ambient");
    const hits = store.search(null, "party");
    expect(hits.some((h) => h.text.includes("party"))).toBe(true);
  });

  it("facts layer: excludes expired facts from search", () => {
    const u = store.addUtterance("x", "ambient");
    store.addFact("party on saturday", [u], Date.now() - 1);   // already expired
    const hits = store.search(null, "party", { layer: "fact" });
    expect(hits).toEqual([]);
  });

  it("forget deletes matching rows and reports them", () => {
    store.addUtterance("secret thing happened", "ambient");
    const result = store.forget("secret thing");
    expect(result.deleted).toBe(1);
    expect(result.texts[0]).toContain("secret");
    expect(store.search(null, "secret")).toEqual([]);
  });

  it("suggestion log round-trips", () => {
    const id = store.addSuggestion("reminder", "Create reminder?", { title: "x" });
    store.setSuggestionStatus(id, "dismissed");
    expect(store.recentSuggestions(0).map((s) => s.id)).toEqual([id]);
  });

  it("meta round-trips", () => {
    expect(store.getMeta("lastDigest")).toBeNull();
    store.setMeta("lastDigest", "123");
    expect(store.getMeta("lastDigest")).toBe("123");
  });
});

function unitVector(hotIndex: number): Float32Array {
  const v = new Float32Array(768);
  v[hotIndex] = 1;
  return v;
}
```

- [ ] **Step 3: Run, verify fail** — `npx vitest run src/main/ambient/memoryStore.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `memoryStore.ts`**

Schema (run in constructor; `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  speaker TEXT,
  embed_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_utterances_ts ON utterances(ts);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  source_utterance_ids TEXT NOT NULL,
  expires_at INTEGER,
  embed_model TEXT
);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'shown'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Plus, only when the extension loads: `CREATE VIRTUAL TABLE IF NOT EXISTS vec_utterances USING vec0(embedding float[768])` and `vec_facts` likewise; rowid mirrors the base-table id. Implementation notes:
- Constructor: `new DatabaseSync(dbPath, { allowExtension: true })`, `db.exec("PRAGMA journal_mode = WAL")` (skip for `:memory:`), try/catch `db.loadExtension(sqliteVec.getLoadablePath())` → sets `vectorSearchAvailable`.
- `node:sqlite` returns INTEGER as bigint in some paths — normalize ids with `Number(...)`.
- Bind vectors as `new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)`.
- `pendingEmbeddings`: rows where `embed_model IS NULL` (utterances then facts, oldest first) — but only when `vectorSearchAvailable`; otherwise return `[]` (nothing to embed into).
- `setEmbedding`: upsert into the vec table (`DELETE` then `INSERT`), set `embed_model`.
- `search`: layer `both` = facts first then raw, de-duplicated, `topK` (default 5) per layer. Vector path: `WHERE embedding MATCH ? AND k = ?` … `ORDER BY distance` (sqlite-vec KNN syntax: `SELECT rowid, distance FROM vec_utterances WHERE embedding MATCH ? ORDER BY distance LIMIT ?`); join back to the base table; `score = 1 - distance/2` (cosine distance ∈ [0,2]). Text fallback: `WHERE text LIKE '%' || ? || '%' ORDER BY ts DESC LIMIT ?` with score 0.5. Facts always exclude `expires_at IS NOT NULL AND expires_at < now`.
- `forget`: `LIKE`-match both tables, capture texts, delete rows + their vec rows.
- `recentWindow`: `SELECT ... ORDER BY ts DESC LIMIT 200`, then walk forward accumulating until `maxWords` reached, return reversed slice.

- [ ] **Step 5: Run tests + typecheck + lint** — `npx vitest run src/main/ambient/ && npm run typecheck && npm run lint` → pass. (If `node:sqlite` needs a vitest config tweak to be treated as external, make it in `electron.vite.config.ts`/vitest config, not by mocking.)

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/ambient/memoryStore.ts apps/electron/src/main/ambient/memoryStore.test.ts apps/electron/package.json package-lock.json
git commit -m "feat(ambient): sqlite-vec memory store (utterances, facts, suggestions)"
```

---

### Task 5: Ollama client + embedding backfill worker

**Files:**
- Create: `apps/electron/src/main/ambient/ollama.ts`
- Create: `apps/electron/src/main/ambient/ollama.test.ts`
- Create: `apps/electron/src/main/ambient/embedWorker.ts`
- Create: `apps/electron/src/main/ambient/embedWorker.test.ts`

**Interfaces:**
- Produces (used by Tasks 6, 9, 10):
  ```ts
  export interface OllamaClient {
    embed(text: string): Promise<Float32Array | null>;                     // null on any failure
    chatJSON(system: string, user: string, schema: Record<string, unknown>): Promise<unknown | null>;
    embedModel: string;
  }
  export function createOllamaClient(options?: { baseUrl?: string; chatModel?: string; embedModel?: string; fetchFn?: typeof fetch }): OllamaClient;

  export class EmbedWorker {
    constructor(options: { store: MemoryStore; ollama: OllamaClient; intervalMs?: number });  // default 15_000
    start(): void;
    stop(): void;
    async tick(): Promise<number>;   // processes up to 16 pending; returns count embedded (exposed for tests)
  }
  ```
- Defaults: `baseUrl` = `process.env.FAMILYHUB_OLLAMA_URL ?? "http://127.0.0.1:11434"`, `chatModel` = `process.env.FAMILYHUB_AMBIENT_LLM ?? "qwen3:4b"`, `embedModel` = `process.env.FAMILYHUB_AMBIENT_EMBED_MODEL ?? "nomic-embed-text"`.
- `embed`: POST `/api/embed` `{model, input}` → first array in `embeddings`; returns null unless it has length 768. `chatJSON`: POST `/api/chat` `{model, messages:[{role:"system"...},{role:"user"...}], stream:false, think:false, format: schema, options:{temperature:0}}` → `JSON.parse(body.message.content)`, null on any error/timeout (AbortController, 20 s).

- [ ] **Step 1: Write failing tests** — inject `fetchFn`; cover: embed happy path (768-dim), embed wrong dim → null, embed network error → null, chatJSON parses `message.content` JSON, chatJSON malformed → null. EmbedWorker: `tick()` embeds pending rows via a `MemoryStore(":memory:")` + stub client (returns unit vector), sets them non-pending; a null embed leaves the row pending and does not throw; `start()`/`stop()` manage the interval (use `vi.useFakeTimers()`).

- [ ] **Step 2: Run, verify fail.** `npx vitest run src/main/ambient/ollama.test.ts src/main/ambient/embedWorker.test.ts`

- [ ] **Step 3: Implement both modules.** Straightforward from the interfaces; every network call in try/catch; never log per-call errors more than once per state change (keep a `wasAvailable` flag; log transitions only).

- [ ] **Step 4: Run tests + typecheck + lint** → pass.

- [ ] **Step 5: Commit** — `git add apps/electron/src/main/ambient/{ollama,embedWorker}*.ts && git commit -m "feat(ambient): ollama client and embedding backfill worker"`

---

### Task 6: Wire Phase 1 into `LiveController` + `ipc.ts`

**Files:**
- Modify: `apps/electron/src/main/assistant/liveController.ts`
- Modify: `apps/electron/src/main/assistant/liveController.test.ts`
- Modify: `apps/electron/src/main/assistant/ipc.ts`

**Interfaces:**
- `LiveControllerOptions` gains `onAmbientUtterance?: (utterance: AmbientUtterance) => void;` — controller forwards the transcriber's `onUtterance` to it. Nothing else in the controller changes.
- `ipc.ts` (inside `registerAssistantIpc`, only when `FAMILYHUB_AMBIENT` is not disabled):
  - `const memory = new MemoryStore(join(homedir(), ".familyhub", "memory.sqlite"))` (import `homedir` from `node:os`).
  - `const ollama = createOllamaClient()`; `new EmbedWorker({ store: memory, ollama }).start()`.
  - Controller option: `onAmbientUtterance: (u) => { memory.addUtterance(u.text, "ambient", Math.round(u.t1 * 1000)); }`.
  - Session capture: wrap the existing sink — `noteHeard: (text) => { service.noteHeard(text); memory.addUtterance(text, "session_user"); }` and `noteAssistantReply` likewise with `"session_james"`.

- [ ] **Step 1: Write failing controller test** (extend `FakeTranscriber` in `liveController.test.ts` with `emitUtterance(u)` calling `handlers.onUtterance?.(u)`; assert a controller built with `onAmbientUtterance` receives it, and that a controller without the option doesn't crash).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — controller: store the option, pass `onUtterance: (utterance) => this.onAmbientUtterance?.(utterance)` in the `transcriber.start({...})` handlers object. ipc.ts: wiring above; guard everything behind `const ambientEnabled = !["0","off","false","no"].includes((process.env.FAMILYHUB_AMBIENT ?? "1").trim().toLowerCase())`; MemoryStore construction inside try/catch (a failed store disables ambient wiring with one `service.noteInfo` line, never blocks startup).

- [ ] **Step 4: Run the full electron suite** — `npx vitest run && npm run typecheck && npm run lint` → pass.

- [ ] **Step 5: Manual smoke (dev):** `npm run dev`, speak near the mic, then `sqlite3 ~/.familyhub/memory.sqlite 'SELECT ts, source, text FROM utterances ORDER BY id DESC LIMIT 5'` — rows appear; wake "Hey James" still opens a session.

- [ ] **Step 6: Commit** — `git commit -m "feat(ambient): store ambient + session transcripts in memory (phase 1 complete)"` (add the three files).

---

## Phase 2 — Memory for James (Tasks 7–9)

### Task 7: `search_memory` / `forget_memory` tool declarations

**Files:**
- Modify: `apps/electron/src/main/assistant/liveSession.ts`

**Interfaces:**
- Produces: `export const memoryToolNames = { search: "search_memory", forget: "forget_memory" } as const;` — consumed by Task 8.

- [ ] **Step 1: Add declarations** to the `functionDeclarations` array (match existing style):

```ts
      {
        name: memoryToolNames.search,
        description:
          "Search the household's long-term memory: everything said in the kitchen (ambient) and in past conversations with you. Use it whenever the user references something previously said, asks what was mentioned/decided/planned, or when household context would improve your answer (e.g. 'when is Jonas's party?').",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "What to look for, phrased as the fact you want (e.g. 'Jonas party date')." },
            daysBack: { type: Type.NUMBER, description: "Optionally limit to the last N days." },
          },
          required: ["query"],
        },
      },
      {
        name: memoryToolNames.forget,
        description:
          "Delete matching entries from household memory. Use when someone says to forget something (e.g. 'James, forget what we said about the surprise'). Confirm out loud what was deleted.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "Words identifying what to forget." },
          },
          required: ["query"],
        },
      },
```

Also append one sentence to the system instruction text built in `buildSystemInstruction` (find the instruction string in this file): `"You have long-term household memory via the search_memory tool — everything previously said in the kitchen. Search it before saying you don't know something about the family's plans, dates, or preferences."`

- [ ] **Step 2: Typecheck + full suite** — `npm run typecheck && npx vitest run` → pass.

- [ ] **Step 3: Commit** — `git commit -m "feat(ambient): declare search_memory/forget_memory tools"` (liveSession.ts).

### Task 8: Run memory tools in `ipc.ts`

**Files:**
- Modify: `apps/electron/src/main/assistant/ipc.ts`

**Interfaces:**
- Consumes: `memoryToolNames` (Task 7), `MemoryStore.search/forget` (Task 4), `ollama.embed` (Task 5).

- [ ] **Step 1: Implement the two `runTool` cases** (memory objects are in scope from Task 6; when ambient is disabled return `{ ok:false, error:"Memory is not enabled." }`):

```ts
      case memoryToolNames.search: {
        if (!memory) return { ok: false, error: "Memory is not enabled." };
        const query = str(args.query);
        const daysBack = typeof args.daysBack === "number" ? args.daysBack : undefined;
        const vector = ollama ? await ollama.embed(query) : null;
        const opts: SearchOptions = { topK: 5, layer: "both" };
        if (daysBack !== undefined) {
          opts.sinceTs = Date.now() - daysBack * 86_400_000;
        }
        const hits = memory.search(vector, query, opts);
        return {
          ok: true,
          results: hits.map((hit) => ({
            when: new Date(hit.ts).toISOString(),
            layer: hit.layer,
            source: hit.source,
            text: hit.text,
          })),
        };
      }
      case memoryToolNames.forget: {
        if (!memory) return { ok: false, error: "Memory is not enabled." };
        const result = memory.forget(str(args.query));
        return { ok: true, deleted: result.deleted, texts: result.texts.slice(0, 5) };
      }
```

- [ ] **Step 2: Typecheck + suite + lint** → pass.
- [ ] **Step 3: Manual QA:** with Phase-1 data in the DB, say "Hey James — what did we say about …" and confirm the tool fires (watch `~/.familyhub/live-debug.log` for `toolCall: search_memory`).
- [ ] **Step 4: Commit** — `git commit -m "feat(ambient): serve memory search/forget tools from the store"`.

### Task 9: Nightly facts digest

**Files:**
- Create: `apps/electron/src/main/ambient/factsDigest.ts`
- Create: `apps/electron/src/main/ambient/factsDigest.test.ts`
- Modify: `apps/electron/src/main/assistant/ipc.ts` (scheduling)

**Interfaces:**
- Produces:
  ```ts
  export async function runDigest(store: MemoryStore, ollama: OllamaClient, now?: number): Promise<number>; // facts added
  export function scheduleDigest(store: MemoryStore, ollama: OllamaClient): () => void;  // returns cancel
  ```
- `runDigest`: reads utterances since `meta.lastDigestTs` (default: 24 h ago), chunks into ≤4000-word batches, per batch calls `ollama.chatJSON` with the schema `{"type":"object","properties":{"facts":{"type":"array","items":{"type":"object","properties":{"text":{"type":"string"},"expiresAt":{"type":["string","null"],"description":"ISO date after which stale, or null"}},"required":["text","expiresAt"]}}},"required":["facts"]}` and system prompt: `"You distill a day of household kitchen conversation into durable facts worth remembering (events with dates, plans, preferences, decisions, names). Resolve relative dates using the provided current date. Ignore chit-chat. Today is <ISO date>."`. Each fact → `store.addFact(text, [], expiresAtMs)` (event-dated facts get `expires_at = eventDate + 7 days`; the model returns the date, the code adds the 7 days). Sets `meta.lastDigestTs`.
- `scheduleDigest`: `setInterval` every 30 min; runs when local time is past 03:30 AND `lastDigestTs` is before today 03:30. Also runs once at startup if more than 26 h have passed (catch-up).

- [ ] **Step 1: Failing tests** — with stub ollama returning fixed facts: digest stores facts with correct expiry, advances `lastDigestTs`, returns count; null chatJSON → 0 facts, `lastDigestTs` NOT advanced; schedule logic tested via exported `shouldRunDigest(lastTs: number | null, now: number): boolean` helper (export it) with cases: never-ran → true; ran yesterday, now 04:00 → true; ran today 03:35, now 09:00 → false; now 02:00, ran yesterday → false.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement**, wire `scheduleDigest(memory, ollama)` into ipc.ts behind the ambient guard.
- [ ] **Step 4: Suite + typecheck + lint** → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(ambient): nightly facts digest into curated memory layer"`.

---

## Phase 3 — Proactive suggestions (Tasks 10–13)

### Task 10: `TriggerEngine`

**Files:**
- Create: `apps/electron/src/main/ambient/triggerEngine.ts`
- Create: `apps/electron/src/main/ambient/triggerEngine.test.ts`

**Interfaces:**
- Produces (used by Task 11):
  ```ts
  export interface TriggerSuggestion {
    kind: "reminder" | "calendar" | "question" | "shopping" | "other";
    confidence: number;
    suggestion: string;                  // human sentence for the card
    payload: Record<string, unknown>;    // e.g. { title, due } for reminder kind
  }
  export class TriggerEngine {
    constructor(options: {
      store: MemoryStore; ollama: OllamaClient;
      onSuggestion: (suggestion: TriggerSuggestion) => void;
      now?: () => number;                // injectable clock for tests
    });
    handleUtterance(text: string): void; // sync, fire-and-forget, latest-wins
    noteDismissed(): void;               // 2-minute global cooldown
    async idle(): Promise<void>;         // test helper: resolves when queue drains
  }
  ```
- Behavior (all from the spec): queue depth 1 latest-wins; fire only `trigger && confidence >= 0.7`; embedding dedupe vs suggestions of last 60 min at cosine > 0.85 (in-memory list of `{vector, at}`); 2-min suppression after `noteDismissed()`.
- LLM call: `ollama.chatJSON(system, window, schema)` with schema `{"type":"object","properties":{"trigger":{"type":"boolean"},"kind":{"enum":["reminder","calendar","question","shopping","other"]},"confidence":{"type":"number"},"suggestion":{"type":"string"},"payload":{"type":"object"}},"required":["trigger","kind","confidence","suggestion","payload"]}` and system prompt:

```
You watch a rolling transcript of a family's kitchen conversation. Decide whether the voice assistant (James) could usefully offer help RIGHT NOW based on the LAST thing said, using the rest as context. Today is <ISO datetime, local>.

Trigger ONLY for:
- A commitment/date/task someone might forget (suggest a reminder or calendar event; payload {"title", "due" ISO local}).
- A factual question someone asked aloud that an assistant could answer (kind "question"; payload {"question"}).
- Something to buy or restock (kind "shopping"; payload {"item"}).

Do NOT trigger on chit-chat, opinions, emotions, media playing in the background, or anything already handled. Be conservative: a wrong suggestion is worse than a missed one. suggestion is one short sentence, e.g. "Create a reminder: Jonas's party, Saturday July 18?"
```

The user message is the recent window: `store.recentWindow(500)` formatted as `"[HH:MM] text"` lines, newest last.

- [ ] **Step 1: Failing tests** (stub ollama; use `idle()` to await): fires onSuggestion when stub returns trigger/0.9; does not fire below 0.7 or trigger:false; latest-wins (3 rapid `handleUtterance` while stub hangs on a controllable promise → at most 2 LLM calls, last text wins); dedupe (same suggestion vector twice in <60 min → one onSuggestion); dismissal cooldown (after `noteDismissed()`, an immediate trigger is suppressed; with `now` advanced +121 s it fires); ollama null → no fire, no throw.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Dedupe embeds via `ollama.embed(suggestion)`; if embed fails, dedupe on lowercased-string equality instead.
- [ ] **Step 4: Suite + typecheck + lint** → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(ambient): trigger engine (latest-wins window classification)"`.

### Task 11: `SuggestionService` + main-process wiring

**Files:**
- Create: `apps/electron/src/main/ambient/suggestionService.ts`
- Create: `apps/electron/src/main/ambient/suggestionService.test.ts`
- Modify: `apps/electron/src/main/assistant/liveController.ts` (LiveStateEvent variants only)
- Modify: `apps/electron/src/main/assistant/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

**Interfaces:**
- `LiveStateEvent` union gains:
  ```ts
  | { type: "suggestion"; id: number; kind: string; text: string }
  | { type: "suggestionResolved"; id: number; status: "accepted" | "dismissed" | "expired" }
  ```
- ```ts
  export class SuggestionService {
    constructor(options: {
      store: MemoryStore;
      sendLive: (event: LiveStateEvent) => void;
      runTool: ToolRunner;                        // reuse the ipc.ts ToolRunner
      onDismissed: () => void;                    // → triggerEngine.noteDismissed()
      timeoutMs?: number;                         // default 30_000
      now?: () => number;
    });
    show(suggestion: TriggerSuggestion): void;    // one at a time; a new one replaces (expires) the old
    handleVoice(text: string): void;              // voice-accept while visible
    async accept(id: number): Promise<void>;
    dismiss(id: number): void;
  }
  ```
- Voice accept regex (exact): `/\b(?:yes|yeah|sure|ok(?:ay)?|do it)\b[\s\S]{0,20}\bjames\b|\bjames\b[\s\S]{0,20}\b(?:yes|yeah|sure|ok(?:ay)?|do it)\b/i`
- Accept mapping: `reminder` → `runTool("create_reminder", { title: payload.title, due: payload.due })` — verify the exact tool name in `calendarToolNames.createReminder` and use THAT constant; `calendar` → `calendarToolNames.createEvent` with `{ title, start: payload.due }`; `shopping` → `createReminder` with `{ title: "Buy " + payload.item, list: "Groceries" }`; `question`/`other` → no tool; the card's accept affordance for those kinds is handled in the renderer (shows "Say 'Hey James' to ask" — no accept button).
- Preload: inside the `assistant` object add `suggestionAction: (id: number, action: "accept" | "dismiss") => ipcRenderer.invoke("assistant:suggestionAction", id, action) as Promise<boolean>` — and add it to the renderer's `window.familyHub` type declaration (find it: `grep -rn "familyHub" apps/electron/src/renderer/src/*.d.ts apps/electron/src/preload`).
- ipc.ts: construct TriggerEngine + SuggestionService behind the ambient guard; `onAmbientUtterance` now ALSO calls `trigger.handleUtterance(u.text)` and `suggestions.handleVoice(u.text)`; `ipcMain.handle("assistant:suggestionAction", ...)` routes to accept/dismiss.

- [ ] **Step 1: Failing tests:** show → sendLive suggestion event + store row; auto-expire at timeout (fake timers) → suggestionResolved expired + store status; accept runs the mapped tool and resolves accepted; dismiss resolves dismissed + calls onDismissed; handleVoice with "sure james" accepts the visible card, with unrelated text does nothing, with no card does nothing; second show while one visible expires the first.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement all wiring.**
- [ ] **Step 4: Suite + typecheck + lint** → pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(ambient): suggestion service with voice/tap accept"`.

### Task 12: Renderer suggestion card

**Files:**
- Create: `apps/electron/src/renderer/src/SuggestionCard.tsx`
- Create: `apps/electron/src/renderer/src/suggestionCard.test.tsx`
- Modify: `apps/electron/src/renderer/src/App.tsx`
- Modify: the renderer stylesheet where global styles live (check `apps/electron/src/renderer/src/` for the CSS file App.tsx imports)

**Interfaces:**
- Consumes: `{ type: "suggestion" | "suggestionResolved" }` live events (Task 11) via the existing `window.familyHub.assistant.onLive` subscription in App.tsx (~line 142), and `window.familyHub.assistant.suggestionAction`.
- Component:
  ```tsx
  export interface ActiveCard { id: number; kind: string; text: string }
  export function SuggestionCard(props: { card: ActiveCard; onAccept: (id: number) => void; onDismiss: (id: number) => void }): JSX.Element
  ```

- [ ] **Step 1: Failing test** (renderToStaticMarkup, mirroring `familySetupStyles.test.ts` patterns): renders the text; kind "reminder" shows an Accept button; kind "question" shows the "Say “Hey James” to ask" hint and NO accept button; dismiss button always present; root element has class `ambient-suggestion`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement component + wiring.** In App.tsx: add `const [suggestion, setSuggestion] = useState<ActiveCard | null>(null)`; in the existing `onLive` switch add `case "suggestion": setSuggestion({ id: event.id, kind: event.kind, text: event.text }); break;` and `case "suggestionResolved": setSuggestion((current) => (current?.id === event.id ? null : current)); break;`. Render `{suggestion && <SuggestionCard card={suggestion} onAccept={...} onDismiss={...} />}` at the app root. On the `suggestion` event, play a soft two-tone chime with WebAudio (oscillator 880 Hz→1320 Hz, 120 ms each, gain 0.08, no external asset).
- [ ] **Step 4: CSS — collision-checked.** Namespace EVERY selector under `.ambient-suggestion`; before writing, `grep -rn "ambient-suggestion\|suggestion" <renderer css files>` to prove no existing selectors collide (this is the Family-Voices black-sidebar lesson: stale CSS + new DOM = broken screen). Card: fixed, bottom-right, max-width 420 px, dark translucent background, border-radius 16 px, high z-index (above dashboard, below any modal), fade/slide-in animation, large tap targets (min 44 px).
- [ ] **Step 5: Suite + typecheck + lint** → pass.
- [ ] **Step 6: Manual visual QA (REQUIRED, not optional):** `npm run dev`; trigger a fake suggestion (temporarily via devtools: send one through the trigger path by saying "don't forget tomorrow is the dentist" near the mic, or call the IPC directly); verify: card visible over the dashboard, chime audible, tap accept creates the reminder, auto-dismiss after 30 s, nothing else on the dashboard shifts. Screenshot in the task report.
- [ ] **Step 7: Commit** — `git commit -m "feat(ambient): suggestion card UI with chime"`.

### Task 13: Trigger-quality bench

**Files:**
- Create: `apps/electron/scripts/trigger-bench.mjs`
- Create: `apps/electron/scripts/trigger-corpus.jsonl`

**Interfaces:**
- Consumes the real Ollama HTTP API with the EXACT system prompt + schema from Task 10 (import nothing — copy the prompt into the script and add a comment in `triggerEngine.ts` saying the bench must be kept in sync).
- Corpus line: `{"window": "<multi-line transcript window>", "expect": true|false, "kind": "reminder"|null, "note": "why"}`

- [ ] **Step 1: Author the corpus** — 50 windows: 20 positives (reminders/dates: party/dentist/pickup/bill-due; questions: distance/weather/conversion/fact; shopping: out-of-milk) and 30 negatives (chit-chat, emotions, TV audio, recipe steps being read aloud, kids playing, already-answered questions, discussing PAST events). Vary phrasing, include Portuguese-English code-switching in ~5 windows (the household is bilingual).
- [ ] **Step 2: Write the bench script** — for each line: call Ollama, compare `trigger` to `expect`; print per-case pass/fail and summary `precision / recall / false-trigger rate`; exit 1 if recall < 0.8 on positives or >2 false triggers on the 30 negatives.
- [ ] **Step 3: Run it** — `node scripts/trigger-bench.mjs` (requires `ollama serve` + `ollama pull qwen3:4b`). Iterate on the Task-10 prompt (keeping code+bench in sync) until thresholds pass. Record final numbers in the commit message.
- [ ] **Step 4: Commit** — `git commit -m "test(ambient): trigger quality bench — precision X.XX recall X.XX"`.

---

### Task 14: Docs, knobs, and final verification

**Files:**
- Modify: `sidecar/README.md` (ambient section: models, knobs, protocol line)
- Modify: `docs/superpowers/specs/2026-07-11-ambient-mode-design.md` (only if implementation diverged — record what and why)

- [ ] **Step 1: Document** every env knob from Global Constraints, the Ollama prerequisite (`brew install ollama; ollama pull qwen3:4b; ollama pull nomic-embed-text`), the DB location, and the "forget" flow.
- [ ] **Step 2: Full verification:** `cd apps/electron && npx vitest run && npm run typecheck && npm run lint` and `cd sidecar && for t in test_*.py; do /Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python "$t" || exit 1; done`. All green.
- [ ] **Step 3: End-to-end manual QA (the spec's checklist):** ambient rows accumulate; "Hey James" wake unaffected; session speech lands tagged `session_user`/`session_james`; `search_memory` answers "when is Jonas's party?" after mentioning it ambiently; suggestion card round-trip (chime → voice "sure James" → reminder exists in Reminders.app); "James, forget that" deletes.
- [ ] **Step 4: Commit** — `git commit -m "docs(ambient): runbook + knobs"`.
