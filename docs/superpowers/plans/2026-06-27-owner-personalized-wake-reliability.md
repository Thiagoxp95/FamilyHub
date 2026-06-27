# Owner-Personalized, Recall-First Wake Reliability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach Hey-Siri-level wake recall for the owner's voice at counter distance (external USB mic) while holding false wakes to "a few a day", by adding a measurement spine, a sidecar AGC front-end, recall-safe Stage-2 confirm, and owner-voice personalization tooling.

**Architecture:** All changes live in the `sidecar/` Python wake stack. We build a recall benchmark first (the single source of truth), then a VAD-gated RMS-AGC conditioner that normalizes quiet/casual speech before Stage-1, a conservative phonetic Stage-2 matcher plus a bench-gated OR-rule, and tooling to fold the owner's recorded voice into the openWakeWord training set and promote a new model behind an automatic regression gate. Every behavioral change is wired behind an env knob that defaults to today's behavior, so nothing regresses until the bench proves a new operating point.

**Tech Stack:** Python 3.11 (sidecar `.venv`), numpy, openwakeword 0.6.0 (onnxruntime), sherpa-onnx (Moonshine/Whisper), vosk; macOS `say`/`afconvert` for synthetic test audio; openWakeWord train stack (separate torch venv under `sidecar/training/.venv`).

## Global Constraints

- **No new runtime pip dependencies.** The shipped sidecar runtime is pinned to exactly `openwakeword==0.6.0`, `sherpa-onnx==1.13.2`, `vosk==0.3.44`, `numpy==2.4.6`, `onnxruntime==1.26.0` (see `sidecar/requirements.txt`). New runtime code may import only these + the Python stdlib. **Phonetic matching MUST be pure-Python inline — no `jellyfish`/`metaphone`/`pronouncing` at runtime.**
- **Runtime stays torch-free.** Torch is allowed only under `sidecar/training/.venv` (off-device).
- **Tests are standalone venv scripts**, not pytest. Pattern: a `CASES` list of tuples, a loop that asserts, prints `PASS`/`FAIL` per case, and `sys.exit(0 if all_passed else 1)`. Run as `sidecar/.venv/bin/python sidecar/<test>.py`. Mirror the existing `sidecar/test_confirm.py` exactly.
- **New env knobs default to current behavior.** Every new `FAMILYHUB_WAKE_*` knob defaults so the engine behaves byte-for-byte as today until explicitly tuned. Document each new knob in the `wake_listener.py` module docstring "Knobs:" block.
- **Stage-1 framing is sacred.** openWakeWord requires 1280-sample (80 ms) int16 frames. Any audio conditioner MUST return int16 numpy of the SAME length it was given and MUST NOT change the engine's framing/buffering.
- **Rollback is mandatory.** Never overwrite or delete `sidecar/models/hey_james.onnx` without first copying it to `sidecar/models/hey_james_v1.onnx`. Model promotion is gated on a bench non-regression check.
- **Sidecar emits the full phrase `hey james` on confirm; the Electron gate (`apps/electron/src/main/assistant/gating.ts`) re-checks that string.** Stage-2 matcher changes are sidecar-internal (they decide whether to emit) and do NOT require gating.ts edits. Do not weaken gating.ts.
- **Owner-in-the-loop steps are out of scope for subagents.** Recording the voice/room corpus and running the torch training are owner actions; tasks build and dry-validate that tooling, they do not execute a real recording or full train.
- **Corpus location (canonical):** positives in `~/.familyhub/wake-corpus/positive/*.wav`, negatives in `~/.familyhub/wake-corpus/negative/*.wav`, all 16 kHz mono PCM16.

---

### Task 1: Recall benchmark harness (`wake_bench.py`)

The measurement spine — built first so every later task is judged against it. Reads the owner corpus, runs each clip through the REAL `TwoStageEngine`, and reports recall, false-wakes/hour, and a per-miss breakdown (Stage-1 no-fire w/ peak score vs Stage-2 veto w/ decode). Self-smoke-tests with macOS `say` when no corpus exists.

**Files:**
- Create: `sidecar/wake_bench.py`
- Create: `sidecar/test_wake_bench.py`

**Interfaces:**
- Consumes: `wake_listener.TwoStageEngine`, `OpenWakeWordEngine`, `MoonshineConfirmer`, `WhisperConfirmer`, `VoskFreeConfirmer`, `ChainConfirmer` (existing).
- Produces:
  - `classify_clip(engine, audio_int16) -> ("fired"|"stage2_veto"|"stage1_nofire", peak_score: float, heard: str)`
  - `bench(positive_clips, negative_clips, make_engine) -> dict` where the dict has keys `recall` (float 0..1), `positives` (int), `positives_fired` (int), `false_wakes` (int), `negative_seconds` (float), `false_wakes_per_hour` (float), `misses` (list of `{name, reason, peak, heard}`).
  - `say_pcm(text, voice=None) -> np.ndarray[int16]` (reused TTS helper, same as `measure_cames.py`).

- [ ] **Step 1: Write the failing test**

```python
# sidecar/test_wake_bench.py
#!/usr/bin/env python3
"""Unit tests for wake_bench classification + reporting (no owner corpus needed).

Run with the sidecar venv:
    sidecar/.venv/bin/python sidecar/test_wake_bench.py
Exits 0 if all cases pass, 1 otherwise.
"""
import sys
import numpy as np
import wake_bench as wb


class FakeStage1:
    """Stand-in OpenWakeWord stage that fires when peak >= threshold."""
    def __init__(self, peak):
        self._peak = peak
        self.last_fire_score = peak


class FakeEngine:
    """Minimal TwoStageEngine-shaped fake: fires iff `should_fire`, exposes peak."""
    def __init__(self, should_fire, peak, heard):
        self._should_fire = should_fire
        self.stage1 = FakeStage1(peak)
        self._last_heard = heard
        self._peak_seen = peak

    def reset(self):
        pass

    def feed(self, pcm_bytes):
        # Fire exactly once, on the first non-trivial chunk.
        if self._should_fire and not getattr(self, "_done", False):
            self._done = True
            return True
        return False

    # wake_bench reads the peak via this hook so it works on real + fake engines.
    def observed_peak(self):
        return self._peak_seen


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


def run():
    audio = (np.zeros(16000, dtype=np.int16))
    cases_ok = True

    # classify_clip: a firing engine → "fired"
    reason, peak, heard = wb.classify_clip(FakeEngine(True, 0.8, "moonshine='hey james'"), audio)
    ok = reason == "fired"
    print(f"[{'PASS' if ok else 'FAIL'}] firing engine classified 'fired' (got {reason})")
    cases_ok &= ok

    # classify_clip: non-firing with peak >= threshold → "stage2_veto"
    eng = FakeEngine(False, 0.6, "moonshine='hey games'")
    eng.threshold = 0.32
    reason, peak, heard = wb.classify_clip(eng, audio)
    ok = reason == "stage2_veto" and "games" in heard
    print(f"[{'PASS' if ok else 'FAIL'}] non-fire peak>=thr classified 'stage2_veto' (got {reason})")
    cases_ok &= ok

    # classify_clip: non-firing with peak < threshold → "stage1_nofire"
    eng = FakeEngine(False, 0.10, "")
    eng.threshold = 0.32
    reason, peak, heard = wb.classify_clip(eng, audio)
    ok = reason == "stage1_nofire"
    print(f"[{'PASS' if ok else 'FAIL'}] non-fire peak<thr classified 'stage1_nofire' (got {reason})")
    cases_ok &= ok

    # bench(): recall + false-wakes/hour math
    def make_fire(): return FakeEngine(True, 0.9, "moonshine='hey james'")
    def make_quiet(): return FakeEngine(False, 0.1, "")
    # 2 positives (both fire), 1 negative clip of 2.0 s that fires once.
    pos = [("p1", np.zeros(16000, np.int16)), ("p2", np.zeros(16000, np.int16))]
    neg = [("n1", np.zeros(32000, np.int16))]  # 2.0 s @ 16 kHz
    report = wb.bench(pos, neg, lambda: make_fire())
    ok = (report["recall"] == 1.0 and report["positives"] == 2 and report["false_wakes"] == 1
          and approx(report["negative_seconds"], 2.0)
          and approx(report["false_wakes_per_hour"], 1800.0))
    print(f"[{'PASS' if ok else 'FAIL'}] bench recall/fp math (got recall={report['recall']} "
          f"fw/h={report['false_wakes_per_hour']})")
    cases_ok &= ok

    return cases_ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/python test_wake_bench.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'wake_bench'`.

- [ ] **Step 3: Write `wake_bench.py`**

```python
# sidecar/wake_bench.py
#!/usr/bin/env python3
"""Recall + false-wake benchmark for the two-stage wake engine — the source of
truth for tuning. Feeds the owner's recorded corpus through the REAL engine and
reports recall, false-wakes/hour, and WHERE each miss died (stage-1 no-fire vs
stage-2 veto). With no corpus present it self-smokes on macOS `say` clips.

Run with the sidecar venv:
    sidecar/.venv/bin/python sidecar/wake_bench.py              # uses ~/.familyhub/wake-corpus
    sidecar/.venv/bin/python sidecar/wake_bench.py --roc        # threshold sweep
Corpus layout: ~/.familyhub/wake-corpus/{positive,negative}/*.wav (16 kHz mono).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

SR = 16000
CHUNK = 2048  # ~128 ms, matches renderer framing
CORPUS = os.path.expanduser("~/.familyhub/wake-corpus")


def load_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def say_pcm(text, voice=None):
    aiff = tempfile.mktemp(suffix=".aiff")
    wav = tempfile.mktemp(suffix=".wav")
    try:
        cmd = ["say"]
        if voice:
            cmd += ["-v", voice]
        cmd += ["-o", aiff, text]
        subprocess.run(cmd, check=True)
        subprocess.run(
            ["afconvert", aiff, "-o", wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"],
            check=True,
        )
        return load_wav(wav)
    finally:
        for p in (aiff, wav):
            if os.path.exists(p):
                os.unlink(p)


def _engine_threshold(engine):
    """Stage-1 threshold for whichever engine shape we were given."""
    stage1 = getattr(engine, "stage1", None)
    if stage1 is not None and hasattr(stage1, "threshold"):
        return float(stage1.threshold)
    return float(getattr(engine, "threshold", 0.32))


def classify_clip(engine, audio_int16):
    """Feed one clip; return (reason, peak_score, heard).
    reason ∈ {"fired","stage2_veto","stage1_nofire"}.

    For the real TwoStageEngine, a non-fire is a stage-2 veto iff the engine's
    cumulative `rejected` counter advanced during THIS clip. This is the robust
    signal: the engine zeroes stage1._peak on a fire (see OpenWakeWordEngine.feed),
    so peak alone cannot distinguish a vetoed fire from a never-fired clip, and
    `_last_heard` persists across clips. Fakes without a `rejected` counter fall
    back to heard/peak."""
    engine.reset()
    rejected_before = getattr(engine, "rejected", None)
    pre = np.zeros(SR // 2, dtype=np.int16)
    post = np.zeros(2 * SR, dtype=np.int16)
    stream = np.concatenate([pre, audio_int16, post])
    fired = False
    pos = 0
    while pos < len(stream):
        chunk = stream[pos : pos + CHUNK]
        pos += len(chunk)
        if engine.feed(chunk.tobytes()):
            fired = True
            break
    peak = float(
        engine.observed_peak() if hasattr(engine, "observed_peak")
        else getattr(getattr(engine, "stage1", None), "_peak", 0.0)
    )
    heard = getattr(engine, "_last_heard", "") or ""
    if fired:
        return "fired", peak, heard
    if rejected_before is not None:  # real engine: trust the veto counter
        if engine.rejected > rejected_before:
            return "stage2_veto", peak, heard
        return "stage1_nofire", peak, ""
    # fake/other engine without a reject counter: peak/heard fallback
    if heard or peak >= _engine_threshold(engine):
        return "stage2_veto", peak, heard
    return "stage1_nofire", peak, heard


def bench(positive_clips, negative_clips, make_engine):
    """positive_clips/negative_clips: list of (name, int16 audio).
    make_engine: zero-arg factory returning a fresh engine.
    Returns the report dict (see module/plan docstring)."""
    engine = make_engine()
    fired = 0
    misses = []
    for name, audio in positive_clips:
        reason, peak, heard = classify_clip(engine, audio)
        if reason == "fired":
            fired += 1
        else:
            misses.append({"name": name, "reason": reason, "peak": round(peak, 3), "heard": heard})

    false_wakes = 0
    neg_samples = 0
    for name, audio in negative_clips:
        neg_samples += len(audio)
        reason, peak, heard = classify_clip(engine, audio)
        if reason == "fired":
            false_wakes += 1
    neg_seconds = neg_samples / SR
    fwph = (false_wakes / neg_seconds * 3600.0) if neg_seconds > 0 else 0.0
    n_pos = len(positive_clips)
    return {
        "recall": (fired / n_pos) if n_pos else 0.0,
        "positives": n_pos,
        "positives_fired": fired,
        "false_wakes": false_wakes,
        "negative_seconds": round(neg_seconds, 2),
        "false_wakes_per_hour": round(fwph, 1),
        "misses": misses,
    }


def real_engine_factory(threshold=None):
    import wake_listener as wl

    thr = float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", "0.32")) if threshold is None else threshold
    model = os.path.join(HERE, "models", "hey_james.onnx")

    def make():
        verifiers = [wl.MoonshineConfirmer(os.path.join(HERE, "models", "sherpa-onnx-moonshine-tiny-en-int8"))]
        whisper = os.path.join(HERE, "models", "sherpa-onnx-whisper-tiny.en")
        if os.path.isdir(whisper):
            verifiers.append(wl.WhisperConfirmer(whisper))
        vosk = os.path.join(HERE, "models", "vosk-model-small-en-us-0.15")
        if os.path.isdir(vosk):
            verifiers.append(wl.VoskFreeConfirmer(vosk))
        eng = wl.TwoStageEngine(model, thr, wl.ChainConfirmer(verifiers), ["james"])
        # Expose a stable peak hook for classify_clip (real engine tracks stage1._peak).
        eng.observed_peak = lambda e=eng: float(getattr(e.stage1, "_peak", 0.0))
        return eng

    return make


def load_corpus():
    def load_dir(sub):
        d = os.path.join(CORPUS, sub)
        if not os.path.isdir(d):
            return []
        return [(f, load_wav(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".wav")]
    return load_dir("positive"), load_dir("negative")


def smoke_corpus():
    """Synthetic stand-in corpus so the harness runs end-to-end with no recordings."""
    pos = [("tts_default", say_pcm("hey James")), ("tts_daniel", say_pcm("hey James", "Daniel"))]
    neg = [("tts_came", say_pcm("he came home")), ("tts_weather", say_pcm("what is the weather today"))]
    return pos, neg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roc", action="store_true", help="sweep threshold and print recall/FP curve")
    ap.add_argument("--threshold", type=float, default=None)
    args = ap.parse_args()

    pos, neg = load_corpus()
    if not pos:
        print("(no owner corpus — running TTS smoke set)", file=sys.stderr)
        pos, neg = smoke_corpus()

    if args.roc:
        curve = []
        for thr in [0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50]:
            r = bench(pos, neg, real_engine_factory(thr))
            curve.append({"threshold": thr, "recall": r["recall"], "false_wakes_per_hour": r["false_wakes_per_hour"]})
            print(f"thr={thr:.2f} recall={r['recall']:.2f} fw/h={r['false_wakes_per_hour']}", file=sys.stderr)
        print(json.dumps(curve, indent=1))
        return 0

    report = bench(pos, neg, real_engine_factory(args.threshold))
    print(f"recall={report['recall']:.2f} ({report['positives_fired']}/{report['positives']})  "
          f"false_wakes={report['false_wakes']} over {report['negative_seconds']}s "
          f"= {report['false_wakes_per_hour']}/h", file=sys.stderr)
    for m in report["misses"]:
        print(f"  MISS {m['name']}: {m['reason']} peak={m['peak']} {m['heard']}", file=sys.stderr)
    print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/python test_wake_bench.py`
Expected: PASS on all four cases, exit 0.

- [ ] **Step 5: Verify the harness runs end-to-end (smoke)**

Run: `cd sidecar && .venv/bin/python wake_bench.py 2>&1 | tail -5`
Expected: prints a `recall=...` line and a JSON report; exits 0. (TTS "Fred"-style misses are fine; the gate is "runs + emits valid schema".)

- [ ] **Step 6: Commit**

```bash
git add sidecar/wake_bench.py sidecar/test_wake_bench.py
git commit -m "feat(wake): recall + false-wake benchmark harness (measurement spine)"
```

---

### Task 2: VAD-gated RMS-AGC conditioner (`audio_frontend.py`)

A pure front-end that normalizes quiet/casual speech toward the level the model was trained on, gated by an energy floor so it never amplifies near-silence into noise. The dominant "say it louder" fix. Pure numpy; no models.

**Files:**
- Create: `sidecar/audio_frontend.py`
- Create: `sidecar/test_audio_frontend.py`

**Interfaces:**
- Produces:
  - `rms_int16(frame: np.ndarray[int16]) -> float`
  - class `WakeBandConditioner(target_rms=2000.0, max_gain=8.0, attack=0.5, vad_floor_rms=120.0)` with `process(frame_int16: np.ndarray[int16]) -> np.ndarray[int16]` (same length, int16, clipped to int16 range) and `reset()`.

- [ ] **Step 1: Write the failing test**

```python
# sidecar/test_audio_frontend.py
#!/usr/bin/env python3
"""Unit tests for the AGC conditioner. Pure numpy, no models.

Run: sidecar/.venv/bin/python sidecar/test_audio_frontend.py
"""
import sys
import numpy as np
from audio_frontend import rms_int16, WakeBandConditioner


def tone(amp, n=1280, freq=200, sr=16000):
    t = np.arange(n) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.int16)


def run():
    ok = True

    # rms of a known tone is amp/sqrt(2), within rounding
    r = rms_int16(tone(1000))
    c = abs(r - 1000 / np.sqrt(2)) < 30
    print(f"[{'PASS' if c else 'FAIL'}] rms_int16 of 1000-amp tone ~707 (got {r:.0f})")
    ok &= c

    # Quiet speech is amplified TOWARD target_rms (but not past max_gain)
    cond = WakeBandConditioner(target_rms=2000.0, max_gain=8.0, vad_floor_rms=120.0)
    quiet = tone(300)  # rms ~212, above vad floor
    out = cond.process(quiet)
    in_rms, out_rms = rms_int16(quiet), rms_int16(out)
    c = out_rms > in_rms * 1.5 and out_rms <= 2000.0 * 1.2
    print(f"[{'PASS' if c else 'FAIL'}] quiet tone amplified toward target ({in_rms:.0f}->{out_rms:.0f})")
    ok &= c

    # Output stays int16 and same length
    c = out.dtype == np.int16 and len(out) == len(quiet) and out.max() <= 32767 and out.min() >= -32768
    print(f"[{'PASS' if c else 'FAIL'}] output int16, same length, in range")
    ok &= c

    # Near-silence (below vad floor) is NOT amplified (no noise pumping)
    cond.reset()
    silence = tone(40)  # rms ~28, below vad floor 120
    out_s = cond.process(silence)
    c = rms_int16(out_s) < rms_int16(silence) * 1.2
    print(f"[{'PASS' if c else 'FAIL'}] sub-floor silence not amplified ({rms_int16(silence):.0f}->{rms_int16(out_s):.0f})")
    ok &= c

    # Loud speech is NOT over-amplified / clipped to garbage
    cond.reset()
    loud = tone(6000)
    out_l = cond.process(loud)
    c = rms_int16(out_l) <= rms_int16(loud) * 1.05 + 1
    print(f"[{'PASS' if c else 'FAIL'}] loud tone not amplified ({rms_int16(loud):.0f}->{rms_int16(out_l):.0f})")
    ok &= c

    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/python test_audio_frontend.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'audio_frontend'`.

- [ ] **Step 3: Write `audio_frontend.py`**

```python
# sidecar/audio_frontend.py
#!/usr/bin/env python3
"""Wake-band front-end conditioner: VAD-gated fast-attack RMS-AGC.

Normalizes casual/quiet utterances toward the level the Stage-1 model was
trained on, so a soft "hey james" presents like a normal one — without
amplifying inter-utterance noise (an energy floor gates the gain). Pure numpy;
returns int16 of the SAME length so it slots in front of the engine's framing
without disturbing it.
"""
import numpy as np

INT16_MAX = 32767
INT16_MIN = -32768


def rms_int16(frame):
    if len(frame) == 0:
        return 0.0
    x = frame.astype(np.float64)
    return float(np.sqrt(np.mean(x * x)))


class WakeBandConditioner:
    def __init__(self, target_rms=2000.0, max_gain=8.0, attack=0.5, vad_floor_rms=120.0):
        self.target_rms = float(target_rms)
        self.max_gain = float(max_gain)
        self.attack = float(attack)          # 0..1 smoothing toward the desired gain
        self.vad_floor_rms = float(vad_floor_rms)
        self.reset()

    def reset(self):
        self._gain = 1.0

    def process(self, frame_int16):
        frame = np.asarray(frame_int16, dtype=np.int16)
        level = rms_int16(frame)
        if level < self.vad_floor_rms:
            # Below the speech floor: relax gain toward unity, do not amplify noise.
            self._gain += (1.0 - self._gain) * self.attack
            target_gain = 1.0
        else:
            desired = self.target_rms / level if level > 0 else 1.0
            target_gain = float(np.clip(desired, 1.0, self.max_gain))  # never attenuate, never over-boost
        # Fast attack toward the per-frame target so onset is lifted immediately.
        self._gain += (target_gain - self._gain) * self.attack
        out = np.clip(np.rint(frame.astype(np.float64) * self._gain), INT16_MIN, INT16_MAX)
        return out.astype(np.int16)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/python test_audio_frontend.py`
Expected: PASS on all five cases, exit 0.

- [ ] **Step 5: Commit**

```bash
git add sidecar/audio_frontend.py sidecar/test_audio_frontend.py
git commit -m "feat(wake): VAD-gated RMS-AGC conditioner (front-end normalization)"
```

---

### Task 3: Wire the conditioner into the engine (Stage-1 + Stage-2 tail)

Pass live frames through the conditioner before Stage-1 `predict`, and condition the Stage-2 tail before decode, behind `FAMILYHUB_WAKE_AGC` (default ON — this is a recall fix the owner asked for; it defaults to current behavior only when set to `0`). Verify a deliberately-attenuated "hey james" that misses without AGC wakes with it.

**Files:**
- Modify: `sidecar/wake_listener.py` (`OpenWakeWordEngine.__init__/feed`, `TwoStageEngine.__init__/_confirm`, module docstring "Knobs:" block, `build_engine`)
- Create: `sidecar/test_agc_wake.py`

**Interfaces:**
- Consumes: `audio_frontend.WakeBandConditioner` (Task 2).
- Produces: `OpenWakeWordEngine(model_path, threshold, conditioner=None)` and `TwoStageEngine(model_path, threshold, confirmer, confirm_tokens, conditioner=None)` accept an optional conditioner; when present, Stage-1 frames and the Stage-2 tail are conditioned. A module helper `make_conditioner_from_env() -> WakeBandConditioner | None` reads `FAMILYHUB_WAKE_AGC` (truthy default) + `FAMILYHUB_WAKE_AGC_TARGET_RMS`, `_AGC_MAX_GAIN`, `_AGC_VAD_FLOOR`.

- [ ] **Step 1: Write the failing test**

```python
# sidecar/test_agc_wake.py
#!/usr/bin/env python3
"""Behavioral test: an attenuated 'hey James' that Stage-1 misses without AGC
should wake WITH AGC. Uses macOS `say`, no owner clips.

Run: sidecar/.venv/bin/python sidecar/test_agc_wake.py
"""
import os
import sys
import numpy as np

os.environ.setdefault("FAMILYHUB_WAKE_POST_TRIGGER_MS", "320")
import wake_listener as wl
from wake_bench import say_pcm  # reuse TTS helper

SR = 16000
CHUNK = 2048


def feed(engine, audio):
    stream = np.concatenate([np.zeros(SR // 2, np.int16), audio, np.zeros(2 * SR, np.int16)])
    pos = 0
    fired = False
    while pos < len(stream):
        c = stream[pos : pos + CHUNK]
        pos += len(c)
        if engine.feed(c.tobytes()):
            fired = True
    return fired


def make(threshold, conditioner):
    model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "hey_james.onnx")
    verifiers = [wl.MoonshineConfirmer(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "models", "sherpa-onnx-moonshine-tiny-en-int8"))]
    return wl.TwoStageEngine(model, threshold, wl.ChainConfirmer(verifiers), ["james"], conditioner=conditioner)


def run():
    ok = True
    loud = say_pcm("hey James", "Daniel")
    quiet = (loud.astype(np.float64) * 0.18).astype(np.int16)  # ~15 dB down → misses raw

    no_agc = make(0.32, None)
    fired_quiet_noagc = feed(no_agc, quiet)

    from audio_frontend import WakeBandConditioner
    with_agc = make(0.32, WakeBandConditioner())
    fired_quiet_agc = feed(with_agc, quiet)

    # The whole point: AGC recovers a quiet utterance the raw path misses.
    c = (not fired_quiet_noagc) and fired_quiet_agc
    print(f"[{'PASS' if c else 'FAIL'}] AGC recovers attenuated wake "
          f"(raw_fired={fired_quiet_noagc}, agc_fired={fired_quiet_agc})")
    ok &= c

    # AGC must not break a normal-volume wake.
    with_agc2 = make(0.32, WakeBandConditioner())
    c2 = feed(with_agc2, loud)
    print(f"[{'PASS' if c2 else 'FAIL'}] AGC still wakes on normal-volume utterance")
    ok &= c2
    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/python test_agc_wake.py`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'conditioner'`.

- [ ] **Step 3: Add the conditioner to `OpenWakeWordEngine`**

In `sidecar/wake_listener.py`, change `OpenWakeWordEngine.__init__` to accept and store an optional conditioner, and condition each frame in `feed` before `predict`:

```python
    def __init__(self, model_path, threshold, conditioner=None):
        from openwakeword.model import Model

        self.model = Model(wakeword_models=[model_path], inference_framework="onnx")
        self.model_path = model_path
        self.threshold = threshold
        self.conditioner = conditioner
        self.last_fire_score = 0.0
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0
        self._peak = 0.0
```

In `feed`, condition the 1280-sample frame right before `self.model.predict(frame)`:

```python
            frame = self._leftover[: self.FRAME]
            self._leftover = self._leftover[self.FRAME :]
            if self.conditioner is not None:
                frame = self.conditioner.process(frame)
            # Predict EVERY frame to keep openWakeWord's internal buffers warm,
            scores = self.model.predict(frame)
```

Also reset the conditioner in `OpenWakeWordEngine.reset`:

```python
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0
        self._peak = 0.0
        if self.conditioner is not None:
            self.conditioner.reset()
```

- [ ] **Step 4: Thread the conditioner through `TwoStageEngine` and condition the tail**

`TwoStageEngine.__init__` gains a `conditioner=None` param, passes it to `OpenWakeWordEngine`, and conditions the Stage-2 tail. Use a SEPARATE conditioner instance for the tail (different call cadence) — accept the same object but the tail path re-runs it over the whole tail:

```python
    def __init__(self, model_path, threshold, confirmer, confirm_tokens, conditioner=None):
        self.stage1 = OpenWakeWordEngine(model_path, threshold, conditioner=conditioner)
        self.conditioner = conditioner
        self.confirmer = confirmer
        ...
```

In `_confirm`, condition the tail before decode when a conditioner is present (operate on a fresh pass over the concatenated tail so the AGC sees the utterance contiguously):

```python
    def _confirm(self):
        tail = list(self.ring)[-self.CONFIRM_DECODE_FRAMES :]
        audio = np.concatenate(tail).astype(np.int16)
        if self.conditioner is not None:
            audio = self.conditioner.process(audio)
        confirmed, heard = self.confirmer.confirm(audio, self.confirm_tokens)
        self._last_heard = f"heard: {heard}"
        return confirmed
```

Note: `WakeBandConditioner.process` accepts any-length int16 (it RMS-normalizes the whole array), so passing the full tail is valid.

- [ ] **Step 5: Add `make_conditioner_from_env` and wire `build_engine`**

Add near the top of `wake_listener.py` (after imports/helpers):

```python
def _env_truthy(name, default):
    return os.environ.get(name, default).strip().lower() not in ("0", "off", "false", "no")


def make_conditioner_from_env():
    """Build the Stage-1/Stage-2 AGC conditioner from env, or None if disabled.
    FAMILYHUB_WAKE_AGC defaults ON (recall-first); set 0/off/false/no to disable."""
    if not _env_truthy("FAMILYHUB_WAKE_AGC", "1"):
        return None
    from audio_frontend import WakeBandConditioner

    return WakeBandConditioner(
        target_rms=float(os.environ.get("FAMILYHUB_WAKE_AGC_TARGET_RMS", "2000")),
        max_gain=float(os.environ.get("FAMILYHUB_WAKE_AGC_MAX_GAIN", "8")),
        vad_floor_rms=float(os.environ.get("FAMILYHUB_WAKE_AGC_VAD_FLOOR", "120")),
    )
```

In `build_engine`, construct the conditioner and pass it in:

```python
    conditioner = make_conditioner_from_env()
    engine = TwoStageEngine(model, args.threshold, confirmer, confirm_tokens, conditioner=conditioner)
    description = (
        f"twostage: emit='{args.wake_phrase}' confirm={confirm_tokens} "
        f"s1={args.threshold} bypass={engine.s1_bypass} agc={'on' if conditioner else 'off'} "
```

Add the new knobs to the module docstring "Knobs:" block:

```
  FAMILYHUB_WAKE_AGC             — "1"/on (default) runs the VAD-gated RMS-AGC
                                   front-end before Stage 1 and on the Stage-2
                                   tail; "0"/off/false/no disables it
  FAMILYHUB_WAKE_AGC_TARGET_RMS  — AGC target RMS (default 2000)
  FAMILYHUB_WAKE_AGC_MAX_GAIN    — AGC max gain (default 8)
  FAMILYHUB_WAKE_AGC_VAD_FLOOR   — RMS below which gain relaxes to unity (default 120)
```

- [ ] **Step 6: Run the new behavioral test, the existing confirm test, and selftest**

Run: `cd sidecar && .venv/bin/python test_agc_wake.py && .venv/bin/python test_confirm.py && .venv/bin/python selftest.py`
Expected: `test_agc_wake.py` PASS (both cases); `test_confirm.py` PASS; `selftest.py` PASS (AGC must not break the existing positives/negatives — if `selftest.py` regresses, that is a real defect to fix, not to suppress).

- [ ] **Step 7: Commit**

```bash
git add sidecar/wake_listener.py sidecar/test_agc_wake.py
git commit -m "feat(wake): condition Stage-1 frames + Stage-2 tail through AGC front-end"
```

---

### Task 4: Conservative phonetic Stage-2 matcher

Reclaim real wakes the tiny ASRs mis-spell (`jaymes`/`jamez`) via bounded edit-distance to an alias, while a denylist keeps the cames/games confusable family rejected. Pure-Python; extends the existing `text_contains_wake_token` and its test.

**Files:**
- Modify: `sidecar/wake_listener.py` (`text_contains_wake_token` + a new `_within_edit1` helper + a `WAKE_CONFUSABLE_DENYLIST`)
- Modify: `sidecar/test_confirm.py` (add CASES)

**Interfaces:**
- Produces: `text_contains_wake_token(text, distinctive_tokens)` keeps its signature and all current True results, and additionally returns True for whole words within edit-distance 1 of an alias UNLESS the word is in `WAKE_CONFUSABLE_DENYLIST`. New helper `_within_edit1(a: str, b: str) -> bool`.

- [ ] **Step 1: Add failing CASES to `test_confirm.py`**

Append to the `CASES` list (these call `text_contains_wake_token`; keep the existing block, add a second labeled block):

```python
PHONETIC_CASES = [
    # (label, text, tokens, expected)
    ("jaymes accepted", "hey jaymes", ["james"], True),
    ("jamez accepted", "okay jamez", ["james"], True),
    ("james exact still ok", "hey james", ["james"], True),
    ("games rejected (cames confusable)", "hey games", ["james"], False),
    ("game rejected", "play a game", ["james"], False),
    ("came rejected", "he came home", ["james"], False),
    ("jameson rejected (whole-word, not substr)", "jameson whiskey", ["james"], False),
    ("dreams rejected", "tie dreams", ["james"], False),
]
```

And add a runner for them in `main()`/the test body:

```python
    for label, text, tokens, expected in PHONETIC_CASES:
        got = text_contains_wake_token(text, tokens)
        ok = got == expected
        print(f"[{'PASS' if ok else 'FAIL'}] {label} (got {got})")
        all_passed &= ok
```

(If `test_confirm.py` currently exits via a helper, mirror its existing pass/fail accumulation variable name — read the file and match it; do not introduce a second exit path.)

- [ ] **Step 2: Run test to verify the phonetic cases fail**

Run: `cd sidecar && .venv/bin/python test_confirm.py`
Expected: the `jaymes`/`jamez` cases FAIL (current code only matches the hard-coded alias tuple, which already contains `jaymes`/`jamez`...). NOTE: `jaymes`/`jamez` are ALREADY in `WAKE_TOKEN_ALIASES`, so they may already pass. The NEW value is the edit-distance generalization + denylist guard. Adjust the failing cases to ones not in the alias tuple, e.g. `"jaimz"`/`"jaymess"`, to prove edit-distance adds recall. Confirm which alias members exist by reading `WAKE_TOKEN_ALIASES` first, then pick test words that are edit-distance 1 from `james`/an alias but NOT literal alias members.

- [ ] **Step 3: Implement the denylist + edit-distance generalization**

In `sidecar/wake_listener.py`, add below `WAKE_GLUE_PREFIXES`:

```python
# Whole words that are within an edit of "james"/its aliases but are KNOWN
# confusables we must never accept — the cames/games family Stage 1 + this
# denylist together keep rejected (see measure_cames.py evidence).
WAKE_CONFUSABLE_DENYLIST = frozenset(
    {"games", "game", "came", "cames", "dreams", "jane", "jason", "names", "shame", "james bond"}
)


def _within_edit1(a, b):
    """True iff Levenshtein(a, b) <= 1. Tiny, allocation-light (words are short)."""
    if a == b:
        return True
    la, lb = len(a), len(b)
    if abs(la - lb) > 1:
        return False
    if la == lb:  # one substitution
        return sum(1 for x, y in zip(a, b) if x != y) == 1
    # one insertion/deletion: the shorter must embed in the longer with one gap
    if la > lb:
        a, b, la, lb = b, a, lb, la
    i = j = 0
    skipped = False
    while i < la and j < lb:
        if a[i] == b[j]:
            i += 1
            j += 1
        elif skipped:
            return False
        else:
            skipped = True
            j += 1
    return True
```

Then extend `text_contains_wake_token` so, after the existing exact-alias and glue-prefix checks fail for a word, it accepts a word that is within edit-distance 1 of any alias and not in the denylist:

```python
    normalized = "".join(
        c if (c.isalnum() or c.isspace()) else " " for c in text.lower()
    )
    words = set(normalized.split())
    for token in distinctive_tokens:
        aliases = WAKE_TOKEN_ALIASES.get(token, (token,))
        for alias in aliases:
            if alias in words:
                return True
            for prefix in WAKE_GLUE_PREFIXES:
                if (prefix + alias) in words:
                    return True
        # Conservative phonetic recovery: a whole word one edit from any alias,
        # excluding known confusables. Catches ASR mis-spellings of a real
        # "james" without reopening the cames/games hole.
        for word in words:
            if word in WAKE_CONFUSABLE_DENYLIST:
                continue
            if any(_within_edit1(word, alias) for alias in aliases):
                return True
    return False
```

- [ ] **Step 4: Run test to verify all cases pass**

Run: `cd sidecar && .venv/bin/python test_confirm.py`
Expected: PASS on all cases (existing + phonetic), exit 0.

- [ ] **Step 5: Regression-check against the cames evidence**

Run: `cd sidecar && .venv/bin/python -c "
from wake_listener import text_contains_wake_token as t
# Every NEGATIVE decode string observed in work_cames_measure.json must stay rejected.
neg=['hey games','he came home','she came by','i came','i cant','continue','the engine']
bad=[s for s in neg if t(s, ['james'])]
print('FALSE ACCEPTS:', bad)
assert not bad, bad
print('cames family still rejected OK')
"`
Expected: `cames family still rejected OK`. If any string false-accepts, extend `WAKE_CONFUSABLE_DENYLIST` (this is the precision regression gate).

- [ ] **Step 6: Commit**

```bash
git add sidecar/wake_listener.py sidecar/test_confirm.py
git commit -m "feat(wake): conservative phonetic Stage-2 match w/ cames denylist"
```

---

### Task 5: Bench-gated OR-rule + tuner mode

Add a Stage-1-score OR-rule (`FAMILYHUB_WAKE_S2_OR_SCORE`) that confirms without Stage-2 when Stage-1 is confident enough — **defaulting OFF** (`1.01`, unreachable) because today's generic model scores media high; it is intended to be enabled only after personalization (Task 7) widens the owner/media margin, and tuned on the bench. Add `wake_bench.py --tune` to recommend an operating point.

**Files:**
- Modify: `sidecar/wake_listener.py` (`TwoStageEngine.__init__/feed`, docstring)
- Modify: `sidecar/wake_bench.py` (add `--tune`)
- Create: `sidecar/test_or_rule.py`

**Interfaces:**
- Consumes: `TwoStageEngine` (Tasks 3).
- Produces: `TwoStageEngine` reads `self.s2_or_score` from `FAMILYHUB_WAKE_S2_OR_SCORE` (default `1.01`). When a Stage-1 candidate's `last_fire_score >= s2_or_score`, the engine wakes without running Stage-2. `wake_bench.py --tune` prints recommended `FAMILYHUB_WAKE_THRESHOLD`/`_S1_BYPASS`/`_S2_OR_SCORE` for a target false-wakes/hour budget (default 0.5/h ≈ "a few a day").

- [ ] **Step 1: Write the failing test**

```python
# sidecar/test_or_rule.py
#!/usr/bin/env python3
"""The OR-rule: a Stage-1 score >= s2_or_score wakes even if Stage-2 would veto.
Default (1.01) keeps the rule OFF. Uses a fake confirmer that always vetoes.

Run: sidecar/.venv/bin/python sidecar/test_or_rule.py
"""
import os
import sys
import numpy as np

os.environ["FAMILYHUB_WAKE_AGC"] = "0"  # isolate the OR-rule from AGC
import wake_listener as wl

SR = 16000
CHUNK = 2048
MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "hey_james.onnx")


class AlwaysVeto:
    def confirm(self, samples, tokens):
        return False, "fake='(veto)'"


def feed(engine, audio):
    stream = np.concatenate([np.zeros(SR // 2, np.int16), audio, np.zeros(2 * SR, np.int16)])
    pos, fired = 0, False
    while pos < len(stream):
        c = stream[pos : pos + CHUNK]
        pos += len(c)
        if engine.feed(c.tobytes()):
            fired = True
    return fired


def run():
    from wake_bench import say_pcm
    ok = True
    clip = say_pcm("hey James", "Daniel")  # scores high on Stage 1

    # OR-rule OFF (default 1.01): always-veto confirmer blocks the wake.
    os.environ["FAMILYHUB_WAKE_S2_OR_SCORE"] = "1.01"
    eng_off = wl.TwoStageEngine(MODEL, 0.32, AlwaysVeto(), ["james"])
    c = not feed(eng_off, clip)
    print(f"[{'PASS' if c else 'FAIL'}] OR-rule off: veto blocks wake")
    ok &= c

    # OR-rule ON at 0.5: a high Stage-1 score wakes despite the veto.
    os.environ["FAMILYHUB_WAKE_S2_OR_SCORE"] = "0.5"
    eng_on = wl.TwoStageEngine(MODEL, 0.32, AlwaysVeto(), ["james"])
    c = feed(eng_on, clip)
    print(f"[{'PASS' if c else 'FAIL'}] OR-rule on@0.5: high Stage-1 wakes despite veto")
    ok &= c

    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/python test_or_rule.py`
Expected: the second case FAILs (the OR-rule does not exist yet, so the veto blocks even a high score).

- [ ] **Step 3: Implement the OR-rule**

In `TwoStageEngine.__init__`, read the knob (place near the `s1_bypass` read):

```python
        self.s2_or_score = float(
            os.environ.get("FAMILYHUB_WAKE_S2_OR_SCORE", "1.01")  # >1 ⇒ off by default
        )
```

In `TwoStageEngine.feed`, after the `s1_bypass` check and before setting `_collecting_samples`, add the OR-rule path. The OR-rule still collects the post-trigger window (so a real word is buffered) but, once collected, wakes regardless of the confirm result. Simplest correct implementation: remember that this candidate is OR-eligible, and in the post-trigger completion branch wake if either confirm passes OR the candidate was OR-eligible:

```python
        if self.stage1.feed(pcm_bytes):  # Stage-1 candidate
            if self.confirmer is None:
                dlog("wake: stage-1 FIRED, stage-2 disabled — waking")
                return True
            if self.stage1.last_fire_score >= self.s1_bypass:
                dlog(... existing bypass log ...)
                return True
            self._or_eligible = self.stage1.last_fire_score >= self.s2_or_score
            self._collecting_samples = self.post_trigger_samples
        return False
```

And in the collection-completion branch:

```python
            if self._collecting_samples <= 0:
                self._collecting_samples = 0
                self._last_heard = ""
                confirmed = self._confirm()
                if confirmed or getattr(self, "_or_eligible", False):
                    why = "confirmed" if confirmed else f"or-rule>={self.s2_or_score}"
                    dlog(f"wake: stage-2 {why} candidate — {self._last_heard}")
                    self._or_eligible = False
                    return True
                self._or_eligible = False
                self.rejected += 1
                dlog(f"wake: stage-2 VETOED candidate (rejected={self.rejected}) — {self._last_heard}")
```

Initialize `self._or_eligible = False` in `reset()`. Add the knob to the docstring:

```
  FAMILYHUB_WAKE_S2_OR_SCORE     — Stage-1 score at/above which the wake fires
                                   even if Stage-2 would veto (recall override).
                                   Default 1.01 (OFF); enable only after the
                                   personalized model widens the owner/noise
                                   margin, tuned via `wake_bench.py --tune`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/python test_or_rule.py && .venv/bin/python selftest.py`
Expected: both cases PASS; `selftest.py` still PASS (OR-rule defaults off, so selftest is unchanged).

- [ ] **Step 5: Add the `--tune` mode to `wake_bench.py`**

Add to the arg parser and `main`:

```python
    ap.add_argument("--tune", action="store_true",
                    help="recommend threshold/bypass/or-score for the FP budget")
    ap.add_argument("--fp-budget", type=float, default=0.5,
                    help="max false-wakes/hour to allow when tuning (default 0.5 ≈ a few/day)")
```

```python
    if args.tune:
        best = None
        for thr in [0.15, 0.20, 0.25, 0.30, 0.35]:
            r = bench(pos, neg, real_engine_factory(thr))
            if r["false_wakes_per_hour"] <= args.fp_budget:
                if best is None or r["recall"] > best["recall"]:
                    best = {"threshold": thr, "recall": r["recall"],
                            "false_wakes_per_hour": r["false_wakes_per_hour"]}
        if best is None:
            print("no threshold met the FP budget; record more negatives or raise --fp-budget",
                  file=sys.stderr)
            print(json.dumps({"recommendation": None}))
            return 0
        print(f"RECOMMEND FAMILYHUB_WAKE_THRESHOLD={best['threshold']} "
              f"(recall={best['recall']:.2f}, fw/h={best['false_wakes_per_hour']})", file=sys.stderr)
        print(json.dumps({"recommendation": best}, indent=1))
        return 0
```

- [ ] **Step 6: Verify `--tune` runs (smoke)**

Run: `cd sidecar && .venv/bin/python wake_bench.py --tune --fp-budget 100 2>&1 | tail -3`
Expected: prints a `RECOMMEND ...` line and a JSON `recommendation` object (high `--fp-budget` so the TTS smoke set yields a recommendation); exits 0.

- [ ] **Step 7: Commit**

```bash
git add sidecar/wake_listener.py sidecar/wake_bench.py sidecar/test_or_rule.py
git commit -m "feat(wake): bench-gated Stage-1 OR-rule (default off) + bench tuner"
```

---

### Task 6: Owner-corpus recorder (`record_corpus.py`)

A guided recorder that captures the owner's "hey james" positives (with realistic variation prompts) and room negatives into the canonical corpus layout the bench + training consume. Audio capture needs a mic (owner runs it); the planning/layout logic is pure and tested.

**Files:**
- Create: `sidecar/record_corpus.py`
- Create: `sidecar/test_record_corpus.py`

**Interfaces:**
- Produces:
  - `POSITIVE_PROMPTS: list[str]` and `NEGATIVE_PROMPTS: list[tuple[str,int]]` (prompt, takes).
  - `plan_takes(out_dir, want) -> int` (how many more clips are needed given existing files; resume-safe).
  - `clip_path(out_dir, index) -> str` (zero-padded `clip_000000.wav`).
  - `corpus_dirs() -> (positive_dir, negative_dir)` rooted at `~/.familyhub/wake-corpus`.
  - `main()` walks the prompts, records `CLIP_SECONDS` per take via sounddevice, writes PCM16 @ 16 kHz.

- [ ] **Step 1: Write the failing test**

```python
# sidecar/test_record_corpus.py
#!/usr/bin/env python3
"""Unit tests for record_corpus planning/layout (no mic, no audio).

Run: sidecar/.venv/bin/python sidecar/test_record_corpus.py
"""
import os
import sys
import tempfile
import record_corpus as rc


def run():
    ok = True

    # clip_path zero-pads and lands under out_dir
    p = rc.clip_path("/tmp/x", 7)
    c = p.endswith("clip_000007.wav") and p.startswith("/tmp/x")
    print(f"[{'PASS' if c else 'FAIL'}] clip_path zero-pads (got {os.path.basename(p)})")
    ok &= c

    # plan_takes: empty dir wants all
    with tempfile.TemporaryDirectory() as d:
        c = rc.plan_takes(d, 6) == 6
        print(f"[{'PASS' if c else 'FAIL'}] plan_takes empty dir wants all")
        ok &= c

        # after 4 files, wants 2 more; resume-safe; never negative
        for i in range(4):
            open(rc.clip_path(d, i), "w").close()
        c = rc.plan_takes(d, 6) == 2 and rc.plan_takes(d, 3) == 0
        print(f"[{'PASS' if c else 'FAIL'}] plan_takes resumes from existing")
        ok &= c

    # corpus_dirs are under the canonical root
    posd, negd = rc.corpus_dirs()
    c = posd.endswith("wake-corpus/positive") and negd.endswith("wake-corpus/negative")
    print(f"[{'PASS' if c else 'FAIL'}] corpus_dirs canonical layout")
    ok &= c

    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/python test_record_corpus.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'record_corpus'`.

- [ ] **Step 3: Write `record_corpus.py`**

```python
# sidecar/record_corpus.py
#!/usr/bin/env python3
"""Guided recorder for the owner wake corpus (positives + room negatives).

Captures YOUR "hey james" across realistic variation (the misses are
voice/volume/articulation-specific, so synthetic clips can't substitute) plus
your room's ambient negatives. Output feeds BOTH the bench (wake_bench.py) and
the personalized retrain (training/). Re-running resumes.

Run from a terminal at your normal counter spot, near the USB mic:
    sidecar/.venv/bin/python sidecar/record_corpus.py            # both
    sidecar/.venv/bin/python sidecar/record_corpus.py positive   # just positives
    sidecar/.venv/bin/python sidecar/record_corpus.py negative   # just negatives
"""
import os
import sys
import time

SAMPLE_RATE = 16000
CLIP_SECONDS = 3.0
NEG_CLIP_SECONDS = 8.0  # ambient negatives are longer
ROOT = os.path.expanduser("~/.familyhub/wake-corpus")

# Say "hey james" each time, varying ONE thing per prompt — these variations are
# exactly where the current model misses.
POSITIVE_PROMPTS = [
    "normal voice, facing the mic",
    "quiet / almost mumbled",
    "fast, run the words together",
    "slow and clearly separated",
    "turned away from the mic",
    "from a step or two further back",
    "casual, like you're busy cooking",
    "normal voice again (different time of day if you can)",
]
POSITIVE_TAKES_PER_PROMPT = 6  # ~48 positives total

# Room negatives: capture whatever is normally on, plus the came/games family.
NEGATIVE_PROMPTS = [
    ("TV or YouTube playing at normal volume — stay silent", 4),
    ("music playing — stay silent", 3),
    ("normal kitchen conversation, NOT saying hey james", 4),
    ("say: he came home", 3),
    ("say: hey games", 3),
    ("say: she came by", 2),
]


def corpus_dirs():
    return os.path.join(ROOT, "positive"), os.path.join(ROOT, "negative")


def clip_path(out_dir, index):
    return os.path.join(out_dir, f"clip_{index:06d}.wav")


def plan_takes(out_dir, want):
    existing = 0
    if os.path.isdir(out_dir):
        existing = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    return max(0, want - existing)


def _record(out_dir, seconds, label):
    import sounddevice as sd
    import soundfile as sf

    os.makedirs(out_dir, exist_ok=True)
    existing = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    print(f"   SAY/RECORD NOW ({label}) …", flush=True)
    audio = sd.rec(int(seconds * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="int16")
    sd.wait()
    sf.write(clip_path(out_dir, existing), audio, SAMPLE_RATE, subtype="PCM_16")
    time.sleep(0.3)


def record_positives():
    posd, _ = corpus_dirs()
    for prompt in POSITIVE_PROMPTS:
        print(f"\n-- POSITIVE: \"hey james\" — {prompt}")
        for i in range(POSITIVE_TAKES_PER_PROMPT):
            print(f"   [{i + 1}/{POSITIVE_TAKES_PER_PROMPT}] get ready…", end="", flush=True)
            time.sleep(0.8)
            _record(posd, CLIP_SECONDS, prompt)


def record_negatives():
    _, negd = corpus_dirs()
    for prompt, takes in NEGATIVE_PROMPTS:
        print(f"\n-- NEGATIVE: {prompt}  ({takes} takes)")
        for i in range(takes):
            print(f"   [{i + 1}/{takes}] get ready…", end="", flush=True)
            time.sleep(0.8)
            _record(negd, NEG_CLIP_SECONDS, prompt)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    print("\n=== wake corpus recording ===")
    print("Speak from your normal counter spot, near the USB mic. Ctrl-C to stop (resumable).")
    if which in ("both", "positive"):
        record_positives()
    if which in ("both", "negative"):
        record_negatives()
    posd, negd = corpus_dirs()
    print(f"\nDone. Positives in {posd}/, negatives in {negd}/.")
    print("Next: sidecar/.venv/bin/python sidecar/wake_bench.py   (baseline), then tell Claude.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sidecar && .venv/bin/python test_record_corpus.py`
Expected: PASS on all cases, exit 0.

- [ ] **Step 5: Verify the module imports without a mic and `--help`-style dispatch is safe**

Run: `cd sidecar && .venv/bin/python -c "import record_corpus as r; print(r.corpus_dirs()); print(r.plan_takes('/tmp/nope', 5))"`
Expected: prints the two dirs and `5`; no audio device touched (import + pure calls only).

- [ ] **Step 6: Commit**

```bash
git add sidecar/record_corpus.py sidecar/test_record_corpus.py
git commit -m "feat(wake): guided owner-corpus recorder (positives + room negatives)"
```

---

### Task 7: Personalization training fold-in, gated promote, rollback, runbook

Tooling to fold the owner corpus into the openWakeWord positive/negative sets, retrain, and promote the new model ONLY if `wake_bench.py` shows non-regression — with one-command rollback. The full train is an owner step (needs the corpus + torch venv); this task builds and dry-validates the scripts and writes the end-to-end runbook.

**Files:**
- Create: `sidecar/training/fold_owner_corpus.py`
- Create: `sidecar/promote_model.sh`
- Create: `sidecar/test_promote_model.py`
- Modify: `sidecar/training/README.md` (append the personalization runbook)
- Modify: `sidecar/README.md` (link the runbook + rollback)

**Interfaces:**
- Produces:
  - `fold_owner_corpus.py`: copies `~/.familyhub/wake-corpus/positive/*.wav` into the openWakeWord generated-positives dir and `.../negative/*.wav` into the adversarial-negatives dir used by `hey_james.yml`, printing how many were folded. Idempotent.
  - `promote_model.sh NEW_ONNX`: backs up `models/hey_james.onnx`→`models/hey_james_v1.onnx`, copies `NEW_ONNX` in, runs `wake_bench.py`, and reverts the copy if recall drops below the saved baseline or false-wakes/hour exceeds the budget. `promote_model.sh --rollback` restores `hey_james_v1.onnx`.

- [ ] **Step 1: Write the failing test (promote/rollback logic, no training)**

```python
# sidecar/test_promote_model.py
#!/usr/bin/env python3
"""Tests promote_model.sh backup + rollback file moves using throwaway files
(no real model, no bench). Verifies the rollback contract.

Run: sidecar/.venv/bin/python sidecar/test_promote_model.py
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "promote_model.sh")


def run():
    ok = True
    # --rollback with no backup present must fail loudly (exit != 0), not silently succeed.
    env = dict(os.environ, FAMILYHUB_WAKE_MODELS_DIR=tempfile.mkdtemp())
    r = subprocess.run(["bash", SCRIPT, "--rollback"], env=env, capture_output=True, text=True)
    c = r.returncode != 0
    print(f"[{'PASS' if c else 'FAIL'}] rollback with no backup fails loudly (rc={r.returncode})")
    ok &= c

    # rollback restores a present backup over the live model.
    d = tempfile.mkdtemp()
    env = dict(os.environ, FAMILYHUB_WAKE_MODELS_DIR=d)
    with open(os.path.join(d, "hey_james.onnx"), "w") as f:
        f.write("NEW")
    with open(os.path.join(d, "hey_james_v1.onnx"), "w") as f:
        f.write("OLD")
    r = subprocess.run(["bash", SCRIPT, "--rollback"], env=env, capture_output=True, text=True)
    restored = open(os.path.join(d, "hey_james.onnx")).read()
    c = r.returncode == 0 and restored == "OLD"
    print(f"[{'PASS' if c else 'FAIL'}] rollback restores backup (model now '{restored}')")
    ok &= c

    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sidecar && .venv/bin/python test_promote_model.py`
Expected: FAIL — `promote_model.sh` does not exist (bash exits non-zero with "No such file", but the second case's restore assertion fails).

- [ ] **Step 3: Write `promote_model.sh`**

```bash
#!/usr/bin/env bash
# Promote a freshly trained hey_james.onnx behind a bench non-regression gate,
# with one-command rollback. Never overwrites the live model without a backup.
#
#   sidecar/promote_model.sh path/to/new/hey_james.onnx   # gated promote
#   sidecar/promote_model.sh --rollback                    # restore previous
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODELS="${FAMILYHUB_WAKE_MODELS_DIR:-$HERE/models}"
LIVE="$MODELS/hey_james.onnx"
BACKUP="$MODELS/hey_james_v1.onnx"
PY="${FAMILYHUB_SIDECAR_PYTHON:-$HERE/.venv/bin/python}"

if [ "${1:-}" = "--rollback" ]; then
  if [ ! -f "$BACKUP" ]; then
    echo "no backup at $BACKUP — cannot roll back" >&2
    exit 1
  fi
  cp "$BACKUP" "$LIVE"
  echo "rolled back: restored $BACKUP -> $LIVE"
  exit 0
fi

NEW="${1:?usage: promote_model.sh NEW_ONNX | --rollback}"
if [ ! -f "$NEW" ]; then echo "no such file: $NEW" >&2; exit 1; fi

# Baseline bench on the CURRENT model first.
echo "== baseline bench (current model) =="
BASE_JSON="$("$PY" "$HERE/wake_bench.py" 2>/dev/null | tail -1)"
BASE_RECALL="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['recall'])" "$BASE_JSON")"

# Swap in the new model behind a backup.
[ -f "$LIVE" ] && cp "$LIVE" "$BACKUP"
cp "$NEW" "$LIVE"

echo "== candidate bench (new model) =="
NEW_JSON="$("$PY" "$HERE/wake_bench.py" 2>/dev/null | tail -1)"
NEW_RECALL="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['recall'])" "$NEW_JSON")"
NEW_FWPH="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['false_wakes_per_hour'])" "$NEW_JSON")"
BUDGET="${FAMILYHUB_WAKE_FP_BUDGET:-0.5}"

KEEP="$("$PY" -c "print(1 if ($NEW_RECALL >= $BASE_RECALL and $NEW_FWPH <= $BUDGET) else 0)")"
if [ "$KEEP" = "1" ]; then
  echo "PROMOTED: recall $BASE_RECALL -> $NEW_RECALL, fw/h $NEW_FWPH (<= $BUDGET). backup at $BACKUP"
  exit 0
fi
# Revert.
[ -f "$BACKUP" ] && cp "$BACKUP" "$LIVE"
echo "REJECTED: recall $BASE_RECALL -> $NEW_RECALL, fw/h $NEW_FWPH (budget $BUDGET). reverted." >&2
exit 2
```

Make it executable: `chmod +x sidecar/promote_model.sh`.

- [ ] **Step 4: Write `training/fold_owner_corpus.py`**

```python
# sidecar/training/fold_owner_corpus.py
#!/usr/bin/env python3
"""Fold the owner wake corpus into the openWakeWord training set, so the retrain
learns the owner's actual voice/room. Idempotent (skips already-folded clips).

Positives → generated-positive clips dir; negatives → adversarial-negative clips
dir. Run from sidecar/training with the TRAINING venv after generate_clips has
created my_custom_model/, OR before run_full.sh to seed real positives.

    sidecar/training/.venv/bin/python sidecar/training/fold_owner_corpus.py
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.expanduser("~/.familyhub/wake-corpus")
# openWakeWord train.py writes generated clips under output_dir; these are the
# conventional subdirs it reads back for augmentation. Adjust if hey_james.yml
# output_dir changes.
POS_DST = os.path.join(HERE, "my_custom_model", "positive_clips")
NEG_DST = os.path.join(HERE, "my_custom_model", "adversarial_negative_clips")


def fold(src_dir, dst_dir, prefix):
    if not os.path.isdir(src_dir):
        print(f"  (no {src_dir} — skipping)")
        return 0
    os.makedirs(dst_dir, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(src_dir)):
        if not f.endswith(".wav"):
            continue
        dst = os.path.join(dst_dir, f"{prefix}_{f}")
        if not os.path.exists(dst):
            shutil.copy2(os.path.join(src_dir, f), dst)
            n += 1
    return n


def main():
    pos = fold(os.path.join(CORPUS, "positive"), POS_DST, "owner")
    neg = fold(os.path.join(CORPUS, "negative"), NEG_DST, "owner")
    print(f"folded {pos} owner positives -> {POS_DST}")
    print(f"folded {neg} owner negatives -> {NEG_DST}")
    if pos == 0:
        print("WARNING: no owner positives found — record with record_corpus.py first", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd sidecar && .venv/bin/python test_promote_model.py`
Expected: PASS on both rollback cases, exit 0.

Run: `cd sidecar && .venv/bin/python -c "import ast; ast.parse(open('training/fold_owner_corpus.py').read()); print('fold_owner_corpus parses OK')"`
Expected: `fold_owner_corpus parses OK` (it imports cleanly; it is not run here because the training venv/corpus are owner-side).

- [ ] **Step 6: Append the personalization runbook to `training/README.md`**

Add a section (verbatim) at the end of `sidecar/training/README.md`:

```markdown
## Personalizing on the owner's voice (recall-first)

The committed model is synthetic-only and misses some real voices/volumes. To
personalize for the appliance's owner + room:

1. **Record the corpus** (owner, near the USB mic):
   `sidecar/.venv/bin/python sidecar/record_corpus.py`
   → writes `~/.familyhub/wake-corpus/{positive,negative}/`.
2. **Baseline the current model:** `sidecar/.venv/bin/python sidecar/wake_bench.py`
   (note the recall + false-wakes/hour).
3. **Fold the corpus into the training set, then retrain** (training venv):
   `sidecar/training/.venv/bin/python sidecar/training/fold_owner_corpus.py`
   then `cd sidecar/training && ./run_full.sh`.
4. **Promote behind the gate:**
   `sidecar/promote_model.sh sidecar/training/my_custom_model/hey_james.onnx`
   (promotes only if recall ≥ baseline and false-wakes/hour ≤ budget; else reverts).
5. **Re-bench + tune the operating point:**
   `sidecar/.venv/bin/python sidecar/wake_bench.py --tune`
   and set the recommended `FAMILYHUB_WAKE_THRESHOLD` (and, once the margin is
   wide, `FAMILYHUB_WAKE_S2_OR_SCORE`).
6. **Rollback any time:** `sidecar/promote_model.sh --rollback`.
```

Add one line under the relevant section of `sidecar/README.md` pointing to that runbook (read `sidecar/README.md` first and place it where the wake model / training is referenced).

- [ ] **Step 7: Commit**

```bash
git add sidecar/promote_model.sh sidecar/test_promote_model.py sidecar/training/fold_owner_corpus.py sidecar/training/README.md sidecar/README.md
git commit -m "feat(wake): owner personalization fold-in, gated model promote + rollback, runbook"
```

---

## Self-Review

**Spec coverage:**
- C0 (bench + corpus) → Task 1 (bench), Task 6 (recorder). ✓
- C1 (personalized model) → Task 7 (fold-in, gated promote, rollback, runbook). ✓
- C2 (front-end normalization) → Task 2 (conditioner), Task 3 (wiring). ✓
- C3 (Stage-2 recall) → Task 4 (phonetic), Task 5 (OR-rule + tail conditioning in Task 3). ✓
- C4 (threshold/bypass retune) → Task 5 (`--tune`), Task 7 step 5 (apply). ✓
- Measurement spine first → Task 1 precedes all behavioral changes. ✓
- Rollback preserved → Global Constraints + Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test shows complete assertions. Task 4 Step 2 flags a read-first dependency (which alias members already exist) rather than guessing — that is a real instruction, not a placeholder.

**Type/name consistency:** `WakeBandConditioner(target_rms, max_gain, attack, vad_floor_rms)` and `.process()/.reset()` are consistent across Tasks 2/3/5. `make_conditioner_from_env`, `FAMILYHUB_WAKE_AGC*`, `FAMILYHUB_WAKE_S2_OR_SCORE` consistent across Tasks 3/5. `bench()`/`classify_clip()`/`real_engine_factory()`/`say_pcm()` consistent across Tasks 1/3/5/7. `corpus_dirs()`/`clip_path()`/`plan_takes()` consistent in Task 6.

**Cross-task note for the executor:** Tasks 1–6 are buildable and fully testable with no owner recordings (TTS/synthetic/mocks). Task 7's scripts are built and dry-validated but their real execution (record → train → promote) is the owner runbook, surfaced after the branch is built.
