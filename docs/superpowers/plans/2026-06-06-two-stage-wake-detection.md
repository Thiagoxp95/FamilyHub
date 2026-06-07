# Two-Stage "Hey James" Wake Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the ~9.4/hr false-positive rate of the wake word by adding a second confirmation stage: a greedy `james.onnx` candidate detector (Stage 1) feeds a strict Vosk "hey james" verifier (Stage 2), all inside the existing sidecar.

**Architecture:** A new `TwoStageEngine` in `sidecar/wake_listener.py` becomes the default engine. It keeps a rolling ~3 s PCM ring buffer, feeds every frame to a reused `LivekitEngine` (Stage 1, threshold lowered to be high-recall), and on a candidate re-decodes the ring buffer with a fresh Vosk recognizer constrained to a `["hey james", "[unk]"]` grammar. It wakes only when Vosk confirms the contiguous phrase "hey james" above a confidence gate. The TypeScript side is untouched (sidecar self-selects engine from env; the emitted `"hey james"` still matches the existing `["james"]` gate).

**Tech Stack:** Python 3.11, `numpy`, `vosk` (KaldiRecognizer + grammar), `livekit.wakeword` (ONNX, onnxruntime). No new dependencies — both models already ship in `sidecar/`.

---

## File Structure

- **Modify** `sidecar/wake_listener.py` — add pure helper `phrase_confirmed()`, add `TwoStageEngine`, wire it as the default engine in `build_engine()` / `main()`, add the `--wake-phrase` / `--confirm-confidence` knobs, lower the Stage-1 threshold default, emit the phrase as the wake text.
- **Create** `sidecar/test_confirm.py` — dependency-free unit tests (plain asserts, run by the venv python) for `phrase_confirmed()`. No models loaded.
- **Modify** `sidecar/selftest.py` — change the offline end-to-end semantics from "wake on bare James" to "wake on 'Hey James', stay quiet on bare 'James' and near-misses".

**Intentionally NOT changed:** any TypeScript. `WakeWordSidecar` spawns `wake_listener.py` with no `--engine` arg, so the Python default drives the engine. `liveController.ts`'s default `wakePhrases = ["james"]` already matches the emitted `"hey james"` (token match). Changing it to `["hey james"]` would risk the multi-word gating regex for zero benefit, so it stays.

---

## Task 1: Pure phrase-confirmation helper (TDD)

The confirmation logic — "did Vosk hear the phrase tokens contiguously, in order, each above the confidence gate?" — is pure and model-free. Build and test it in isolation first.

**Files:**
- Create: `sidecar/test_confirm.py`
- Modify: `sidecar/wake_listener.py` (add `phrase_confirmed`)

- [ ] **Step 1: Write the failing test**

Create `sidecar/test_confirm.py`:

```python
#!/usr/bin/env python3
"""Unit tests for phrase_confirmed() — pure, no models loaded.

Run with the sidecar venv:
    sidecar/.venv/bin/python sidecar/test_confirm.py
Exits 0 if all cases pass, 1 otherwise.
"""

import sys

from wake_listener import phrase_confirmed

HEY_JAMES = ["hey", "james"]
MIN_CONF = 0.6


def w(word, conf):
    return {"word": word, "conf": conf}


CASES = [
    ("both tokens high conf", [w("hey", 0.98), w("james", 0.95)], True),
    ("james below gate", [w("hey", 0.98), w("james", 0.30)], False),
    ("hey below gate", [w("hey", 0.20), w("james", 0.95)], False),
    ("bare james, no hey", [w("james", 0.99)], False),
    ("wrong order", [w("james", 0.90), w("hey", 0.90)], False),
    (
        "embedded contiguous run",
        [w("um", 0.9), w("hey", 0.9), w("james", 0.9), w("please", 0.9)],
        True,
    ),
    ("hey jason not james", [w("hey", 0.95), w("jason", 0.95)], False),
    ("empty result", [], False),
    ("missing conf defaults low", [w("hey", 0.9), {"word": "james"}], False),
]


def main():
    ok = True
    for label, words, expected in CASES:
        got = phrase_confirmed(words, HEY_JAMES, MIN_CONF)
        status = "ok" if got == expected else "FAIL"
        if got != expected:
            ok = False
        print(f"  {status:4} {label:28} expected={expected} got={got}")
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `sidecar/.venv/bin/python sidecar/test_confirm.py`
Expected: FAIL — `ImportError: cannot import name 'phrase_confirmed' from 'wake_listener'`.

- [ ] **Step 3: Add the minimal implementation**

In `sidecar/wake_listener.py`, after the `emit()` function (around line 45, before `class LivekitEngine`), add:

```python
def phrase_confirmed(words, phrase_tokens, min_confidence):
    """True iff `phrase_tokens` appear as a contiguous, in-order run within
    Vosk's result `words`, each with conf >= min_confidence.

    `words` is Vosk's result list: [{"word": str, "conf": float, ...}, ...].
    `phrase_tokens` is a lowercased token list, e.g. ["hey", "james"].
    """
    n = len(phrase_tokens)
    if n == 0:
        return False
    spoken = [
        (str(entry.get("word", "")).lower(), float(entry.get("conf", 0.0)))
        for entry in words
    ]
    for i in range(len(spoken) - n + 1):
        window = spoken[i : i + n]
        if all(window[j][0] == phrase_tokens[j] for j in range(n)) and all(
            conf >= min_confidence for _, conf in window
        ):
            return True
    return False
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `sidecar/.venv/bin/python sidecar/test_confirm.py`
Expected: every line `ok`, final line `PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add sidecar/wake_listener.py sidecar/test_confirm.py
git commit -m "feat(wake): pure phrase_confirmed() helper for two-stage verifier"
```

---

## Task 2: TwoStageEngine + wiring + env knobs

Add the engine and make it the default. This is verified end-to-end in Task 3; here we add the code and a construction smoke check.

**Files:**
- Modify: `sidecar/wake_listener.py` (add `TwoStageEngine`, update `build_engine`, `main`, argparse)

- [ ] **Step 1: Add the `TwoStageEngine` class**

In `sidecar/wake_listener.py`, after `class VoskEngine` (before `def build_engine`), add:

```python
class TwoStageEngine:
    """Stage 1: livekit james.onnx candidate (high recall). Stage 2: Vosk
    re-decodes the trailing ring buffer against a tight 'hey james' grammar and
    must confirm the phrase. A false wake needs BOTH stages wrong at once."""

    FRAME = 1280  # 80 ms @ 16 kHz, matches LivekitEngine
    RING_FRAMES = 38  # ~3.0 s trailing window (holds "hey" + pause + "james")

    def __init__(self, model_path, threshold, vosk_model_path, phrase, min_confidence):
        from vosk import Model, SetLogLevel

        SetLogLevel(-1)
        self.stage1 = LivekitEngine(model_path, threshold)
        self.vosk_model = Model(vosk_model_path)
        self.phrase = phrase
        self.phrase_tokens = [t.lower() for t in phrase.split() if t]
        self.min_conf = min_confidence
        self.grammar = json.dumps([phrase, "[unk]"])
        self.rejected = 0
        self.reset()

    def reset(self):
        self.stage1.reset()
        self.ring = deque(
            [np.zeros(self.FRAME, dtype=np.int16)] * self.RING_FRAMES,
            maxlen=self.RING_FRAMES,
        )
        self._leftover = np.zeros(0, dtype=np.int16)

    def _push_ring(self, pcm_bytes):
        chunk = np.frombuffer(pcm_bytes, dtype=np.int16)
        self._leftover = np.concatenate([self._leftover, chunk])
        while len(self._leftover) >= self.FRAME:
            self.ring.append(self._leftover[: self.FRAME])
            self._leftover = self._leftover[self.FRAME :]

    def _confirm(self):
        from vosk import KaldiRecognizer

        rec = KaldiRecognizer(self.vosk_model, SAMPLE_RATE, self.grammar)
        rec.SetWords(True)
        audio = np.concatenate(list(self.ring)).astype(np.int16).tobytes()
        rec.AcceptWaveform(audio)
        result = json.loads(rec.FinalResult())
        return phrase_confirmed(result.get("result", []), self.phrase_tokens, self.min_conf)

    def feed(self, pcm_bytes):
        self._push_ring(pcm_bytes)
        if self.stage1.feed(pcm_bytes):  # Stage-1 candidate
            if self._confirm():
                return True
            self.rejected += 1
            print(
                f"wake: stage-2 vetoed candidate (rejected={self.rejected})",
                file=sys.stderr,
                flush=True,
            )
        return False
```

- [ ] **Step 2: Add the new argparse knobs**

In `main()`, the current argparse block (lines ~138-153) ends with `--min-confidence`. Replace the `--engine` and `--threshold` arguments and add two new ones so the block reads:

```python
    parser.add_argument(
        "--engine",
        choices=["twostage", "livekit", "vosk"],
        default=os.environ.get("FAMILYHUB_WAKE_ENGINE", "twostage"),
    )
    parser.add_argument("--wake-words", default=DEFAULT_WAKE_WORDS)
    parser.add_argument("--model", default=None, help="livekit ONNX classifier path")
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", "0.5")),
    )
    parser.add_argument(
        "--wake-phrase",
        default=os.environ.get("FAMILYHUB_WAKE_PHRASE", "hey james"),
        help="two-stage Stage-2 confirmation phrase",
    )
    parser.add_argument(
        "--confirm-confidence",
        type=float,
        default=float(os.environ.get("FAMILYHUB_WAKE_CONFIRM_CONFIDENCE", "0.6")),
    )
    parser.add_argument("--vosk-model", default=None)
    parser.add_argument("--min-confidence", type=float, default=0.7)
```

Note: `--threshold` now defaults to `0.5` (Stage-1, greedy by design). The single-stage `livekit` debug engine shares this default; pass `--threshold 0.8` to reproduce its old standalone behavior.

- [ ] **Step 3: Wire the engine into `build_engine`**

Replace the entire `build_engine` function with:

```python
def build_engine(args, wake_words):
    if args.engine == "vosk":
        model = args.vosk_model or os.path.join(
            HERE, "models", "vosk-model-small-en-us-0.15"
        )
        return VoskEngine(model, wake_words, args.min_confidence), f"vosk:{model}"
    if args.engine == "livekit":
        model = args.model or os.environ.get(
            "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "james.onnx")
        )
        return (
            LivekitEngine(model, args.threshold),
            f"livekit:{model}@{args.threshold}",
        )
    # twostage (default)
    model = args.model or os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "james.onnx")
    )
    vosk_model = args.vosk_model or os.environ.get(
        "FAMILYHUB_VOSK_MODEL",
        os.path.join(HERE, "models", "vosk-model-small-en-us-0.15"),
    )
    engine = TwoStageEngine(
        model, args.threshold, vosk_model, args.wake_phrase, args.confirm_confidence
    )
    description = (
        f"twostage:'{args.wake_phrase}' s1={args.threshold} "
        f"s2={args.confirm_confidence}"
    )
    return engine, description
```

- [ ] **Step 4: Emit the phrase as the wake text**

In `main()`, replace the line `wake_text = wake_words[0]` (around line 161) with:

```python
    wake_text = args.wake_phrase if args.engine == "twostage" else wake_words[0]
```

- [ ] **Step 5: Smoke-check that all three engines construct**

Run:

```bash
sidecar/.venv/bin/python -c "
import argparse, wake_listener as wl
for eng in ('twostage','livekit','vosk'):
    args = argparse.Namespace(engine=eng, wake_words='james', model=None,
        threshold=0.5, vosk_model=None, min_confidence=0.7,
        wake_phrase='hey james', confirm_confidence=0.6)
    e, desc = wl.build_engine(args, ['james'])
    print(eng, 'OK ->', desc)
"
```

Expected: three lines `twostage OK -> ...`, `livekit OK -> ...`, `vosk OK -> ...`, no traceback.

- [ ] **Step 6: Re-run the pure unit test (regression)**

Run: `sidecar/.venv/bin/python sidecar/test_confirm.py`
Expected: `PASS` (unchanged — the helper still behaves).

- [ ] **Step 7: Commit**

```bash
git add sidecar/wake_listener.py
git commit -m "feat(wake): TwoStageEngine (james.onnx -> Vosk 'hey james' confirm) as default"
```

---

## Task 3: End-to-end offline self-test for "Hey James" semantics

Rewrite the offline self-test so it proves the new product behavior: "Hey James" wakes; bare "James", near-misses, and silence stay quiet. This runs the real `twostage` engine end-to-end via stdio (exactly as the app does).

**Files:**
- Modify: `sidecar/selftest.py`

- [ ] **Step 1: Update the module docstring**

Replace the docstring (lines 2-12) of `sidecar/selftest.py` with:

```python
"""Offline sanity check for the two-stage wake-word sidecar.

Synthesizes speech with macOS `say`, streams it through wake_listener.py exactly
as the app does (base64 16 kHz frames over stdio), and checks that "Hey James"
wakes while bare "James", near-misses, ordinary speech, and silence do not. Run
with the sidecar venv:

    sidecar/.venv/bin/python sidecar/selftest.py

Exits 0 if "Hey James" wakes and every negative stays quiet.
"""
```

- [ ] **Step 2: Replace the positives/negatives in `main()`**

In `sidecar/selftest.py`, replace the `positives = [...]` and `negatives = [...]` blocks (lines ~79-85) with:

```python
    positives = [("'Hey James'", say_pcm("Hey James"))]
    for voice in ("Daniel", "Karen"):
        positives.append((f"'Hey James' ({voice})", say_pcm("Hey James", voice)))
    positives.append(
        ("'Hey James turn on the lights'", say_pcm("Hey James turn on the lights"))
    )
    negatives = [
        ("bare 'James'", say_pcm("James")),
        ("'what's the weather'", say_pcm("what is the weather like today")),
        ("'the name of the guy is John'", say_pcm("the name of the guy is John")),
        ("'hey Jason'", say_pcm("hey Jason")),
        ("'hey can you hear me'", say_pcm("hey can you hear me")),
    ]
```

- [ ] **Step 3: Run the self-test (the real end-to-end gate)**

Run: `sidecar/.venv/bin/python sidecar/selftest.py`
Expected: every `Should WAKE` line shows `WAKE`, every `Should stay quiet` line shows `quiet`, final line `PASS — wakes on 'James', quiet otherwise.`, exit 0.

If a `Should WAKE` line MISSES: lower Stage-1 threshold (`FAMILYHUB_WAKE_THRESHOLD=0.4 sidecar/.venv/bin/python sidecar/selftest.py`) and/or the confirm gate (`FAMILYHUB_WAKE_CONFIRM_CONFIDENCE=0.5`). If a negative FALSE-WAKEs: raise `FAMILYHUB_WAKE_CONFIRM_CONFIDENCE` (e.g. `0.7`). Settle on the value that passes, then bake it into the argparse default in `wake_listener.py` (update `FAMILYHUB_WAKE_CONFIRM_CONFIDENCE`/`FAMILYHUB_WAKE_THRESHOLD` defaults to match) and re-run.

- [ ] **Step 4: Commit**

```bash
git add sidecar/selftest.py sidecar/wake_listener.py
git commit -m "test(wake): offline self-test for 'Hey James' (bare 'James' now quiet)"
```

---

## Task 4: Regression sweep

Confirm nothing else broke, then a final commit if any default was tuned.

**Files:** none (verification only)

- [ ] **Step 1: TypeScript suite still green (no TS was changed, this is a safety net)**

Run from `apps/electron`: `npm test`
Expected: all suites pass. `localTranscriber.test.ts` (protocol parsing) and `wakeDetection.test.ts` (gating regex + old Google path) are engine-agnostic and must be unaffected.

- [ ] **Step 2: Typecheck + lint (only relevant if TS was touched; run anyway)**

Run from `apps/electron`: `npm run typecheck && npm run lint`
Expected: clean. (No TS changed, so this should pass trivially.)

- [ ] **Step 3: Final confirmation run of both Python checks**

Run:
```bash
sidecar/.venv/bin/python sidecar/test_confirm.py
sidecar/.venv/bin/python sidecar/selftest.py
```
Expected: both print `PASS` and exit 0.

- [ ] **Step 4: Commit any tuning (skip if Task 3 needed no default change)**

```bash
git add sidecar/wake_listener.py
git commit -m "chore(wake): pin tuned stage-1/confirm thresholds from self-test"
```

---

## Notes for the implementer

- **No new dependencies, no model downloads.** `sidecar/models/vosk-model-small-en-us-0.15` and `sidecar/james.onnx` already exist.
- **Vosk loads ~once per process.** The self-test spawns a fresh process per utterance, so it pays the model load each time and takes ~30-60 s overall. The real app spawns the sidecar once. This is expected.
- **`import wake_listener` is cheap** — `vosk`/`livekit.wakeword` are imported lazily inside the engine classes, and `main()` is guarded by `if __name__ == "__main__"`, so `test_confirm.py` loads no models.
- **Runtime config lives in `~/.familyhub/.env`** (loaded by the Electron main process and forwarded to the sidecar's environment). To switch engines or tune at runtime without editing code, set `FAMILYHUB_WAKE_ENGINE` / `FAMILYHUB_WAKE_THRESHOLD` / `FAMILYHUB_WAKE_CONFIRM_CONFIDENCE` / `FAMILYHUB_WAKE_PHRASE` there.
- **Scope discipline:** the working tree has unrelated WIP (eventkit, liveSession, etc.). Every `git add` above names exact files — never `git add -A`.
- **Real-world tuning is the actual finish line.** Offline `say` voices pass easily; the rejected-candidate stderr counter exists so the owner can watch Stage 2 veto real false candidates in the kitchen and tune the two thresholds against real audio.
