# "Hey James" wake rebuild (openWakeWord → Moonshine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two engine internals of the always-on local "hey james" wake sidecar — openWakeWord for the Stage-1 candidate detector and sherpa-onnx Moonshine tiny.en for the Stage-2 confirmer — while keeping the cascade architecture, stdio protocol, and Electron-side gate unchanged.

**Architecture:** A long-lived Python sidecar (`sidecar/wake_listener.py`) streams 16 kHz int16 PCM frames over stdio. A high-recall Stage-1 detector flags "hey james" candidates; a ~640 ms post-trigger window is buffered into a ring; a free Stage-2 decode of the ~2 s tail confirms only if it actually transcribes "james" (or a curated alias). On confirm it emits `{"type":"final","text":"hey james"}`, which the Electron `transcriptContainsWakePhrase` gate accepts. Only the Stage-1 and Stage-2 engine classes change; the ring buffer, post-trigger collection, cooldown, diagnostics, protocol, and `gating.ts`/`liveController.ts` are untouched.

**Tech Stack:** Python ≥3.10, numpy, onnxruntime (via `openwakeword`), `sherpa-onnx` (Moonshine offline recognizer), `vosk` (fallback engine only). Training (one-time, off-device): `openwakeword[train]` + `piper-tts` on GPU/Colab. Spec: `docs/superpowers/specs/2026-06-08-wake-openwakeword-moonshine-design.md`.

---

## File Structure

- `sidecar/wake_listener.py` — **modify.** Replace `LivekitEngine` with `OpenWakeWordEngine`; add `MoonshineConfirmer` and `text_contains_wake_token`; rewire `TwoStageEngine._confirm` to use Moonshine; update `build_engine`/`main` arg wiring; remove the standalone `livekit` engine; keep `VoskEngine` + `phrase_confirmed` for the fallback.
- `sidecar/test_confirm.py` — **modify.** Add unit tests for `text_contains_wake_token` (pure, no models). Keep existing `phrase_confirmed` tests (Vosk path).
- `sidecar/requirements.txt` — **modify.** `livekit-wakeword` → `openwakeword`; keep `sherpa-onnx`, `vosk`, `numpy`; fix the stale speaker-lock comment.
- `sidecar/setup.sh` — **modify.** Install new deps; pre-download openWakeWord feature models + Moonshine model; remove speaker-lock (silero/titanet) downloads; keep Vosk fallback download.
- `sidecar/selftest.py` — **modify (light).** Update the engine label/comment; corpus unchanged. Stays the behavioral contract.
- `sidecar/training/README.md` — **create.** Reproducible openWakeWord synthetic-training recipe producing `hey_james.onnx`.
- `sidecar/models/hey_james.onnx` — **create (committed artifact from training).**
- `sidecar/james.onnx` — **delete** (retired livekit Stage-1 model).
- `sidecar/README.md` — **modify.** Rewrite engine section; openWakeWord + Moonshine + Vosk fallback; remove livekit; fix retraining section.

---

## Task 1: Stage-2 wake-token text match (pure logic, TDD)

The Moonshine confirmer produces plain text (no per-word confidence like Vosk). The precision mechanism becomes "did the free decode actually transcribe the distinctive word". This task adds the pure matcher and its alias set, mirroring `apps/electron/src/main/assistant/gating.ts`.

**Files:**
- Modify: `sidecar/wake_listener.py` (add `WAKE_TOKEN_ALIASES` + `text_contains_wake_token` near `phrase_confirmed`, ~line 93)
- Test: `sidecar/test_confirm.py`

- [ ] **Step 1: Write the failing tests**

Add to `sidecar/test_confirm.py` (import the new symbol at top: `from wake_listener import phrase_confirmed, text_contains_wake_token`):

```python
def test_text_match():
    # exact
    assert text_contains_wake_token("hey james", ["james"]) is True
    # alias from gating.ts list
    assert text_contains_wake_token("hey jaymes", ["james"]) is True
    assert text_contains_wake_token("a hames", ["james"]) is True
    # whole-word only — substrings of other words must not match
    assert text_contains_wake_token("hey jameson", ["james"]) is False
    assert text_contains_wake_token("what are their names", ["james"]) is False
    # near-misses the model would decode differently
    assert text_contains_wake_token("hey jason", ["james"]) is False
    assert text_contains_wake_token("hey games", ["james"]) is False
    assert text_contains_wake_token("hey cames", ["james"]) is False
    # punctuation / case
    assert text_contains_wake_token("Hey, JAMES!", ["james"]) is True
    # empty
    assert text_contains_wake_token("", ["james"]) is False
    print("text_contains_wake_token: ok")
```

And call `test_text_match()` from `main()` alongside the existing test calls.

- [ ] **Step 2: Run to verify it fails**

Run: `sidecar/.venv/bin/python sidecar/test_confirm.py`
Expected: FAIL — `ImportError: cannot import name 'text_contains_wake_token'`.

- [ ] **Step 3: Implement the matcher**

In `sidecar/wake_listener.py`, after `phrase_confirmed` (around line 93), add:

```python
# Curated ASR mis-hearings of the distinctive wake token, mirroring the alias
# set in apps/electron/src/main/assistant/gating.ts so the sidecar's Stage-2
# confirm and the Electron-side gate agree on which near-misses count.
WAKE_TOKEN_ALIASES = {
    "james": ("james", "jaymes", "jaimes", "jamez", "jaymz", "hames", "jaymez"),
}


def text_contains_wake_token(text, distinctive_tokens):
    """True iff any distinctive token (or a curated alias of it) appears as a
    WHOLE word in a free-decode transcript. Whole-word, not substring, so
    'jameson'/'names' do not match."""
    normalized = "".join(
        c if (c.isalnum() or c.isspace()) else " " for c in text.lower()
    )
    words = set(normalized.split())
    for token in distinctive_tokens:
        for alias in WAKE_TOKEN_ALIASES.get(token, (token,)):
            if alias in words:
                return True
    return False
```

- [ ] **Step 4: Run to verify it passes**

Run: `sidecar/.venv/bin/python sidecar/test_confirm.py`
Expected: PASS — prints `text_contains_wake_token: ok` and the existing `phrase_confirmed` lines; exit 0.

- [ ] **Step 5: Commit**

```bash
git add sidecar/wake_listener.py sidecar/test_confirm.py
git commit -m "feat(wake): add Stage-2 wake-token text matcher with gating-mirrored aliases"
```

---

## Task 2: Dependencies + setup (openWakeWord, Moonshine; drop speaker-lock)

**Files:**
- Modify: `sidecar/requirements.txt`
- Modify: `sidecar/setup.sh`

- [ ] **Step 1: Rewrite `requirements.txt`**

Replace the whole file with:

```
# Wake-word engines. Torch-free at RUNTIME (training uses torch but is off-device):
#   openwakeword (default Stage-1 candidate detector) — custom ONNX "hey james"
#     model over onnxruntime; ships its own melspectrogram/embedding preprocessors.
#   sherpa-onnx — Stage-2 confirm: a Moonshine tiny.en offline recognizer free-decodes
#     the post-trigger tail to confirm the distinctive word was actually spoken.
#   vosk (fallback wake engine) — offline ASR constrained to a keyword grammar.
# numpy is used by every engine and selftest.py.
openwakeword
sherpa-onnx
vosk
numpy
```

- [ ] **Step 2: Rewrite `setup.sh` model section**

Replace the body after `pip install -r requirements.txt` (from the `# Vosk confirmation/fallback model.` comment through the final two `echo` lines) with:

```bash
mkdir -p models

# Stage-1 openWakeWord shared feature models (melspectrogram + embedding). Bundled
# with the pip package but fetched on first use; pre-fetch so the runtime is offline.
./.venv/bin/python -c "import openwakeword.utils as u; u.download_models()"

# Stage-2 Moonshine tiny.en (sherpa-onnx int8 bundle).
MOONSHINE="sherpa-onnx-moonshine-tiny-en-int8"
MOONSHINE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MOONSHINE}.tar.bz2"
if [ ! -d "models/${MOONSHINE}" ]; then
  echo "Downloading Moonshine tiny.en (~50 MB)…"
  curl -sL -o "models/${MOONSHINE}.tar.bz2" "$MOONSHINE_URL"
  (cd models && tar xjf "${MOONSHINE}.tar.bz2" && rm -f "${MOONSHINE}.tar.bz2")
fi

# Vosk fallback model (engine=vosk only).
VOSK_MODEL="vosk-model-small-en-us-0.15"
VOSK_URL="https://alphacephei.com/vosk/models/${VOSK_MODEL}.zip"
if [ ! -d "models/${VOSK_MODEL}" ]; then
  echo "Downloading Vosk fallback model (~40 MB)…"
  curl -sL -o "models/${VOSK_MODEL}.zip" "$VOSK_URL"
  (cd models && unzip -q "${VOSK_MODEL}.zip" && rm -f "${VOSK_MODEL}.zip")
fi

echo "Sidecar ready at $(pwd) (default engine: twostage / openWakeWord → Moonshine)"
echo "Verify with: ./.venv/bin/python selftest.py"
```

Also update the top-of-file comment block (lines 2-5) to:

```bash
# Sets up the FamilyHub wake-word sidecar venv. The default twostage engine uses
# openWakeWord (Stage-1 candidate, committed hey_james.onnx) then sherpa-onnx
# Moonshine to confirm "hey james". Vosk is downloaded as an offline fallback engine.
```

Note: the silero-VAD and titanet speaker-embedding downloads are deleted here — speaker-lock was removed on this branch.

- [ ] **Step 3: Run setup to verify it succeeds**

Run: `cd sidecar && PYTHON_BIN=python3.11 ./setup.sh`
Expected: completes; `sidecar/models/sherpa-onnx-moonshine-tiny-en-int8/` and `sidecar/models/vosk-model-small-en-us-0.15/` exist; openWakeWord feature models downloaded (under the venv's `openwakeword/resources/models`). `models/silero_vad.onnx` / `models/nemo_en_titanet_small.onnx` are NOT created.

- [ ] **Step 4: Commit**

```bash
git add sidecar/requirements.txt sidecar/setup.sh
git commit -m "build(wake): swap deps to openwakeword + sherpa-onnx Moonshine; drop speaker-lock models"
```

---

## Task 3: `OpenWakeWordEngine` (Stage-1 detector)

Replace `LivekitEngine`. openWakeWord keeps its own rolling melspectrogram+embedding buffers, so this engine does NOT maintain a trailing window — it just feeds 80 ms frames and reads the score. `predict()` is called every frame (even during cooldown) to keep those buffers warm.

**Files:**
- Modify: `sidecar/wake_listener.py:96-145` (replace the `LivekitEngine` class)

- [ ] **Step 1: Replace the class**

Replace the entire `class LivekitEngine:` block with:

```python
class OpenWakeWordEngine:
    """openWakeWord ONNX classifier (Stage-1 candidate detector). Feeds 80 ms
    (1280-sample) frames; the model keeps its own feature buffers, so — unlike the
    retired livekit engine — there is no external trailing window here."""

    FRAME = 1280  # 80 ms @ 16 kHz
    COOLDOWN_FRAMES = 25  # ~2 s — don't re-fire on the same utterance

    def __init__(self, model_path, threshold):
        from openwakeword.model import Model

        self.model = Model(wakeword_models=[model_path], inference_framework="onnx")
        # Key the prediction dict by whatever name openWakeWord derived from the file.
        self.key = next(iter(self.model.models.keys()))
        self.threshold = threshold
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0
        self._peak = 0.0  # running max of the current candidate burst (for dlog)

    def reset(self):
        self.model.reset()
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0
        self._peak = 0.0

    def feed(self, pcm_bytes):
        chunk = np.frombuffer(pcm_bytes, dtype=np.int16)
        self._leftover = np.concatenate([self._leftover, chunk])
        woke = False
        while len(self._leftover) >= self.FRAME:
            frame = self._leftover[: self.FRAME]
            self._leftover = self._leftover[self.FRAME :]
            # Predict EVERY frame to keep openWakeWord's internal buffers warm,
            # even while cooling down.
            scores = self.model.predict(frame)
            score = float(scores.get(self.key, 0.0))
            if self._cooldown > 0:
                self._cooldown -= 1
                continue
            # Report the PEAK score of each candidate burst (including ones that
            # never reach threshold) so real-voice recall stays observable.
            if score >= self._peak:
                self._peak = score
            elif self._peak >= 0.30 and score < self._peak * 0.6:
                dlog(f"wake: candidate peak score={self._peak:.3f} threshold={self.threshold} (no fire)")
                self._peak = 0.0
            if score >= self.threshold:
                woke = True
                self._cooldown = self.COOLDOWN_FRAMES
                dlog(f"wake: FIRED score={score:.3f} threshold={self.threshold}")
                self._peak = 0.0
        return woke
```

> Version note: confirm `Model.reset()` exists in the installed openWakeWord (`sidecar/.venv/bin/python -c "from openwakeword.model import Model; print(hasattr(Model, 'reset'))"`). If it prints `False`, implement `reset()` by re-instantiating `self.model` with the same args.

- [ ] **Step 2: Smoke-check it imports and instantiates**

(Deferred full behavior to selftest in Task 7, which needs `hey_james.onnx` from Task 6.) Verify the module still parses:

Run: `sidecar/.venv/bin/python -c "import wake_listener; print('ok')"` (from `sidecar/`)
Expected: prints `ok` (no `hey_james.onnx` needed for import).

- [ ] **Step 3: Commit**

```bash
git add sidecar/wake_listener.py
git commit -m "feat(wake): OpenWakeWordEngine Stage-1 detector replacing livekit"
```

---

## Task 4: `MoonshineConfirmer` + rewire `TwoStageEngine`

Replace the Vosk free decode in `TwoStageEngine._confirm` with a Moonshine decode + `text_contains_wake_token`. `TwoStageEngine.__init__` takes a confirmer + distinctive tokens instead of a Vosk model path + confidence.

**Files:**
- Modify: `sidecar/wake_listener.py` — add `MoonshineConfirmer`; edit `TwoStageEngine.__init__` (~206) and `_confirm` (~240)

- [ ] **Step 1: Add `MoonshineConfirmer`**

Add above `class TwoStageEngine:`:

```python
class MoonshineConfirmer:
    """sherpa-onnx Moonshine tiny.en offline recognizer. Free-decodes a short tail
    of int16 PCM and returns the transcript text."""

    def __init__(self, model_dir):
        import sherpa_onnx

        self.recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine(
            preprocessor=os.path.join(model_dir, "preprocess.onnx"),
            encoder=os.path.join(model_dir, "encode.int8.onnx"),
            uncached_decoder=os.path.join(model_dir, "uncached_decode.int8.onnx"),
            cached_decoder=os.path.join(model_dir, "cached_decode.int8.onnx"),
            tokens=os.path.join(model_dir, "tokens.txt"),
        )

    def decode(self, samples_int16):
        stream = self.recognizer.create_stream()
        samples = samples_int16.astype(np.float32) / 32768.0
        stream.accept_waveform(SAMPLE_RATE, samples)
        self.recognizer.decode_stream(stream)
        return stream.result.text
```

> The four ONNX filenames above match the `sherpa-onnx-moonshine-tiny-en-int8` bundle. If a future bundle renames them, adjust here only.

- [ ] **Step 2: Rewire `TwoStageEngine.__init__`**

Replace the signature + body (currently taking `vosk_model_path, phrase, min_confidence`) with one taking the confirmer + distinctive tokens:

```python
    def __init__(self, model_path, threshold, confirmer, confirm_tokens):
        self.stage1 = OpenWakeWordEngine(model_path, threshold)
        self.confirmer = confirmer
        self.confirm_tokens = confirm_tokens
        post_trigger_ms = float(
            os.environ.get("FAMILYHUB_WAKE_POST_TRIGGER_MS", self.DEFAULT_POST_TRIGGER_MS)
        )
        self.post_trigger_samples = int(SAMPLE_RATE * post_trigger_ms / 1000)
        self.rejected = 0
        self.reset()
```

(Remove the `from vosk import Model, SetLogLevel` / `SetLogLevel(-1)` / `self.vosk_model = ...` / `self.phrase_tokens` / `self.min_conf` lines from the old `__init__`.)

- [ ] **Step 3: Rewire `_confirm` to use Moonshine**

Replace the `_confirm` body with:

```python
    def _confirm(self):
        # Free (unconstrained) decode of only the last ~2 s (wake word + post-trigger),
        # NOT the full ring — older pre-roll just lets the model hallucinate a sentence
        # that hides the word. Moonshine decodes the tail fast; the word always lands here.
        tail = list(self.ring)[-self.CONFIRM_DECODE_FRAMES :]
        audio = np.concatenate(tail).astype(np.int16)
        text = self.confirmer.decode(audio)
        # Record what Stage 2 heard so a veto is diagnosable.
        self._last_heard = "heard='{}'".format(text)
        return text_contains_wake_token(text, self.confirm_tokens)
```

- [ ] **Step 4: Run unit tests (still green, no model load)**

Run: `sidecar/.venv/bin/python sidecar/test_confirm.py`
Expected: PASS (these tests don't load engines).

- [ ] **Step 5: Commit**

```bash
git add sidecar/wake_listener.py
git commit -m "feat(wake): Moonshine Stage-2 confirmer replacing Vosk free decode"
```

---

## Task 5: `build_engine` / `main` wiring; remove `livekit` engine

**Files:**
- Modify: `sidecar/wake_listener.py` — `build_engine` (~297) and `main` argparse (~336)

- [ ] **Step 1: Rewrite `build_engine`**

```python
def build_engine(args, wake_words):
    if args.engine == "vosk":
        model = args.vosk_model or os.path.join(
            HERE, "models", "vosk-model-small-en-us-0.15"
        )
        return VoskEngine(model, wake_words, args.min_confidence), f"vosk:{model}"
    # twostage (default): openWakeWord Stage-1 → Moonshine Stage-2 confirm.
    model = args.model or os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "models", "hey_james.onnx")
    )
    moonshine_dir = os.environ.get(
        "FAMILYHUB_MOONSHINE_MODEL",
        os.path.join(HERE, "models", "sherpa-onnx-moonshine-tiny-en-int8"),
    )
    confirm_tokens = [t.lower() for t in args.confirm_phrase.split() if t]
    engine = TwoStageEngine(
        model, args.threshold, MoonshineConfirmer(moonshine_dir), confirm_tokens
    )
    description = (
        f"twostage: emit='{args.wake_phrase}' confirm={confirm_tokens} "
        f"s1={args.threshold} (openWakeWord→Moonshine)"
    )
    return engine, description
```

- [ ] **Step 2: Update argparse in `main`**

Remove `"livekit"` from the `--engine` choices (now `["twostage", "vosk"]`). Delete the `--confirm-confidence` argument and the `--min-confidence` default note tied to confirm (keep `--min-confidence` for the Vosk fallback engine). Keep `--threshold`, `--wake-phrase`, `--confirm-phrase`, `--model`, `--vosk-model`, `--wake-words`. Update the `--threshold` help to drop the "standalone livekit" sentence:

```python
    parser.add_argument(
        "--engine",
        choices=["twostage", "vosk"],
        default=os.environ.get("FAMILYHUB_WAKE_ENGINE", "twostage"),
    )
```

```python
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", "0.5")),
        help="stage-1 openWakeWord candidate threshold; tuned low for two-stage recall.",
    )
```

Delete the now-unused `--confirm-confidence` argument block (lines ~364-368).

- [ ] **Step 3: Verify module parses and `--help` works**

Run: `sidecar/.venv/bin/python sidecar/wake_listener.py --help`
Expected: prints usage; `--engine {twostage,vosk}`; no `livekit`, no `--confirm-confidence`.

- [ ] **Step 4: Commit**

```bash
git add sidecar/wake_listener.py
git commit -m "refactor(wake): wire twostage to openWakeWord+Moonshine; drop livekit engine"
```

---

## Task 6: Train + commit `hey_james.onnx` (one-time, off-device)

openWakeWord has no pre-built "hey james" model; produce one via its synthetic pipeline. This runs on GPU/Colab, not on the appliance. The runtime code (Tasks 3–5) is already done; this produces the model file it loads.

**Files:**
- Create: `sidecar/training/README.md`
- Create (artifact): `sidecar/models/hey_james.onnx`
- Delete: `sidecar/james.onnx`

- [ ] **Step 1: Write `sidecar/training/README.md`**

```markdown
# Training the openWakeWord "hey james" model

One-time, off-device (GPU/Colab). Produces `../models/hey_james.onnx`, the
Stage-1 candidate detector. Runtime is torch-free; training is not.

## Recipe (openWakeWord automatic synthetic pipeline)

1. Environment (Colab GPU or a CUDA box):
   ```bash
   pip install openwakeword[train] piper-tts
   python -c "import openwakeword.utils as u; u.download_models()"
   ```
2. Generate positives with Piper TTS across many voices for the phrase
   "hey james", plus adversarial negatives ("hey jason", "james", "hey games"),
   and mix in room/background noise (FMA + audioset/ACAV negatives per the
   openWakeWord training notebook).
3. Train with the openWakeWord `train.py` / notebook flow; target FRR < 5% at
   < 0.5 false-accepts/hour on a held-out set including the negatives above.
4. (Optional, better real-room recall) Fold in real clips recorded on the
   appliance mic via `../record_wake.py`.
5. Export to ONNX and copy the classifier to `../models/hey_james.onnx`.

## Acceptance

`sidecar/selftest.py` must PASS with the exported model at the default
threshold (retune `FAMILYHUB_WAKE_THRESHOLD` if needed — prefer a Stage-1 fire
+ Stage-2 veto over a Stage-1 miss; recall-first).
```

- [ ] **Step 2: Produce the model**

Follow `sidecar/training/README.md` on GPU/Colab; copy the exported classifier to `sidecar/models/hey_james.onnx`.

- [ ] **Step 3: Verify it loads and scores**

Run (from `sidecar/`):
```bash
.venv/bin/python -c "from wake_listener import OpenWakeWordEngine; e=OpenWakeWordEngine('models/hey_james.onnx', 0.5); import numpy as np; print(e.feed(np.zeros(1280, dtype=np.int16).tobytes()))"
```
Expected: prints `False` (silence doesn't wake) with no error — confirms the model loads and scores.

- [ ] **Step 4: Remove the retired livekit model + commit**

```bash
git rm sidecar/james.onnx
git add sidecar/training/README.md sidecar/models/hey_james.onnx
git commit -m "feat(wake): add trained openWakeWord hey_james.onnx; drop retired james.onnx"
```

---

## Task 7: Selftest green (behavioral contract + threshold tuning)

**Files:**
- Modify: `sidecar/selftest.py` (label/comment only; corpus unchanged)

- [ ] **Step 1: Update the engine label**

In `sidecar/selftest.py`, update any wording that says the default engine confirms via Vosk to reflect `openWakeWord → Moonshine`. The positives/negatives corpus (lines ~79-93) stays exactly as-is — it is the contract.

- [ ] **Step 2: Run the selftest**

Run: `sidecar/.venv/bin/python sidecar/selftest.py`
Expected: `PASS — wakes on 'Hey James', quiet otherwise.` (exit 0). All three positive voices + the continuation WAKE; the five negatives + "hey Jason" + bare "James" + silence stay quiet.

- [ ] **Step 3: If it fails, tune (recall-first)**

- A real "Hey James" shows MISS → lower `FAMILYHUB_WAKE_THRESHOLD` (e.g. 0.4) and/or raise `FAMILYHUB_WAKE_POST_TRIGGER_MS` if `~/.familyhub/wake-debug.log` shows a truncated `heard='hey ja'` veto. Re-run.
- A negative shows FALSE-WAKE → that means Stage 2 transcribed the distinctive word; inspect the `heard='…'` log. If openWakeWord over-fires Stage 1, raise the threshold slightly (Stage 2 should still veto). Re-run.
- Bake the chosen default into `--threshold`'s default in `wake_listener.py` if it differs from 0.5.

- [ ] **Step 4: Confirm the Vosk fallback still passes**

Run: `FAMILYHUB_WAKE_ENGINE=vosk sidecar/.venv/bin/python sidecar/selftest.py`
Expected: `PASS` (the fallback path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add sidecar/selftest.py sidecar/wake_listener.py
git commit -m "test(wake): selftest green on openWakeWord+Moonshine; tune default threshold"
```

---

## Task 8: Docs cleanup (`README.md`, stale comments)

**Files:**
- Modify: `sidecar/README.md`

- [ ] **Step 1: Rewrite the engines section**

Replace the `## Engines (switchable)` bullet list with:

```markdown
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
```

- [ ] **Step 2: Replace the retraining section**

Replace `## Retraining the livekit model (optional, better accuracy)` with a short pointer to `training/README.md`:

```markdown
## Training the openWakeWord model

`models/hey_james.onnx` is produced off-device via openWakeWord's synthetic pipeline.
See `training/README.md` for the reproducible recipe (Piper TTS positives + noise/
negatives, ONNX export). For better real-room recall, fold in clips recorded on the
appliance with `record_wake.py`.
```

- [ ] **Step 3: Fix Setup/Protocol mentions of livekit/Vosk-confirm**

In `## Setup`, replace "installs both engines, and downloads the Vosk fallback/confirmation model … The livekit candidate model needs no download (`james.onnx` is committed)." with: "installs the engines and downloads the Moonshine confirm model + Vosk fallback model into `models/`. The openWakeWord `hey_james.onnx` is committed (no download)." Update the overrides list: drop `FAMILYHUB_WAKE_CONFIRM_CONFIDENCE`; add `FAMILYHUB_MOONSHINE_MODEL`.

- [ ] **Step 4: Verify no stale references remain**

Run: `grep -rin "livekit\|speaker.lock\|hard-lock\|confirm-confidence\|james.onnx" sidecar/README.md sidecar/setup.sh sidecar/requirements.txt`
Expected: only intended hits (e.g. `models/hey_james.onnx`); no `livekit`, no `speaker hard-lock`, no `confirm-confidence`.

- [ ] **Step 5: Commit**

```bash
git add sidecar/README.md
git commit -m "docs(wake): rewrite sidecar README for openWakeWord + Moonshine; drop stale livekit/speaker-lock"
```

---

## Self-Review

**Spec coverage:**
- Stage-1 → openWakeWord: Tasks 3 (engine), 6 (model). ✓
- Stage-2 → sherpa-onnx Moonshine: Tasks 1 (matcher), 4 (confirmer). ✓
- Keep cascade/ring/post-trigger/protocol/gate unchanged: Task 4 keeps ring + `CONFIRM_DECODE_FRAMES` + emit; `gating.ts` untouched. ✓
- Keep Vosk fallback, drop standalone livekit: Task 5. ✓
- Packaging (deps + downloads, drop speaker-lock): Task 2. ✓
- Selftest as contract + tuning: Task 7. ✓
- Training reproducibility: Task 6. ✓
- Docs/stale-comment cleanup: Tasks 2 (requirements comment), 8 (README). ✓

**Placeholder scan:** No TBD/TODO; every code step shows concrete code. The one external dependency (training on GPU/Colab) is an explicit task with a recipe and a load/score verification, not a placeholder.

**Type/name consistency:** `OpenWakeWordEngine(model_path, threshold)` used identically in Tasks 3, 5, 6. `MoonshineConfirmer(model_dir)` + `.decode(samples_int16)` consistent in Tasks 4, 5. `text_contains_wake_token(text, tokens)` consistent in Tasks 1, 4. `TwoStageEngine(model, threshold, confirmer, confirm_tokens)` matches between Tasks 4 and 5. Model path `models/hey_james.onnx` consistent in Tasks 5, 6, 8.
```
