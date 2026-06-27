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
        if not (w.getframerate() == SR and w.getnchannels() == 1):
            raise ValueError(path)
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def say_pcm(text, voice=None):
    aiff = tempfile.NamedTemporaryFile(suffix=".aiff", delete=False).name
    wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
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
    ap.add_argument("--tune", action="store_true",
                    help="recommend threshold/bypass/or-score for the FP budget")
    ap.add_argument("--fp-budget", type=float, default=0.5,
                    help="max false-wakes/hour to allow when tuning (default 0.5 ≈ a few/day)")
    args = ap.parse_args()

    pos, neg = load_corpus()
    if not pos:
        print("(no owner corpus — running TTS smoke set)", file=sys.stderr)
        pos, neg = smoke_corpus()

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
