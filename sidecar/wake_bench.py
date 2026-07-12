#!/usr/bin/env python3
"""Recall + false-wake benchmark for the wake engine — the source of truth for
tuning. Feeds the owner's recorded corpus through the REAL single-stage
StreamingWakeEngine and reports recall, false-wakes/hour and per-miss peaks.
With no corpus present it self-smokes on macOS `say` clips.

Run with the sidecar venv:
    sidecar/.venv/bin/python sidecar/wake_bench.py              # uses ~/.familyhub/wake-corpus
    sidecar/.venv/bin/python sidecar/wake_bench.py --roc        # threshold sweep
    sidecar/.venv/bin/python sidecar/wake_bench.py --tune --fp-budget 0.5
Corpus layout: ~/.familyhub/wake-corpus/{positive,negative}/*.wav (16 kHz mono).

The engine is single-stage (score >= threshold fires), so --roc/--tune don't
re-feed audio per threshold: each clip's peak score is recorded once with an
unreachable threshold, then any threshold's fire decision is peak >= t. The
default report DOES drive the real engine at the real threshold end-to-end.

The LAST stdout line is always a single JSON object — promote_model.sh parses
it (keys: recall, positives, positives_fired, false_wakes, negative_seconds,
false_wakes_per_hour, misses). Human-readable detail goes to stderr.
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


def classify_clip(engine, audio_int16):
    """Feed one clip through the engine; return (fired, peak_score).

    The clip is padded with real-ish leading context and trailing silence so
    the full phrase transits the 2 s embedding window."""
    engine.reset()
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
    return fired, float(getattr(engine, "observed_peak", 0.0))


def score_clips(clips, make_engine):
    """Record each clip's peak score with a never-firing engine.
    Returns [(name, peak, seconds)]."""
    engine = make_engine(threshold=999.0)
    rows = []
    for name, audio in clips:
        _, peak = classify_clip(engine, audio)
        rows.append((name, peak, len(audio) / SR))
    return rows


def report_from_peaks(pos_rows, neg_rows, threshold):
    fired = sum(1 for _, peak, _ in pos_rows if peak >= threshold)
    misses = [
        {"name": name, "reason": "nofire", "peak": round(peak, 3)}
        for name, peak, _ in pos_rows
        if peak < threshold
    ]
    false_wakes = sum(1 for _, peak, _ in neg_rows if peak >= threshold)
    neg_seconds = sum(secs + 2.5 for _, _, secs in neg_rows)  # incl. pad
    fwph = (false_wakes / neg_seconds * 3600.0) if neg_seconds > 0 else 0.0
    return {
        "recall": (fired / len(pos_rows)) if pos_rows else 0.0,
        "positives": len(pos_rows),
        "positives_fired": fired,
        "false_wakes": false_wakes,
        "negative_seconds": round(neg_seconds, 2),
        "false_wakes_per_hour": round(fwph, 2),
        "misses": misses,
    }


def bench(positive_clips, negative_clips, make_engine):
    """End-to-end bench driving the real engine at its real threshold.
    Returns the report dict; contract consumed by promote_model.sh."""
    engine = make_engine()
    fired = 0
    misses = []
    for name, audio in positive_clips:
        did_fire, peak = classify_clip(engine, audio)
        if did_fire:
            fired += 1
        else:
            misses.append({"name": name, "reason": "nofire", "peak": round(peak, 3)})

    false_wakes = 0
    neg_samples = 0
    for name, audio in negative_clips:
        neg_samples += len(audio) + SR // 2 + 2 * SR
        did_fire, _ = classify_clip(engine, audio)
        if did_fire:
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
        "false_wakes_per_hour": round(fwph, 2),
        "misses": misses,
    }


def real_engine_factory(threshold=None):
    import wake_listener as wl

    model = os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "models", "hey_james.onnx")
    )

    def make(threshold=threshold):
        thr = (
            float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", wl.DEFAULT_THRESHOLD))
            if threshold is None
            else threshold
        )
        return wl.StreamingWakeEngine(model, thr)

    return make


def load_corpus():
    def load_dir(sub):
        d = os.path.join(CORPUS, sub)
        if not os.path.isdir(d):
            return []
        return [
            (f, load_wav(os.path.join(d, f)))
            for f in sorted(os.listdir(d))
            if f.endswith(".wav")
        ]

    return load_dir("positive"), load_dir("negative")


def smoke_corpus():
    """Synthetic stand-in corpus so the harness runs end-to-end with no
    recordings. Luciana (pt-BR) covers the accented-positive class."""
    pos = [
        ("tts_default", say_pcm("hey James")),
        ("tts_daniel", say_pcm("hey James", "Daniel")),
        ("tts_luciana", say_pcm("hey James", "Luciana")),
    ]
    neg = [
        ("tts_came", say_pcm("he came home")),
        ("tts_jason", say_pcm("hey Jason", "Daniel")),
        ("tts_weather", say_pcm("what is the weather today")),
    ]
    return pos, neg


THRESHOLDS = [round(t, 2) for t in np.arange(0.05, 0.96, 0.05)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roc", action="store_true", help="sweep threshold and print recall/FP curve")
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--tune", action="store_true",
                    help="recommend FAMILYHUB_WAKE_THRESHOLD for the FP budget")
    ap.add_argument("--fp-budget", type=float, default=0.5,
                    help="max false-wakes/hour to allow when tuning (default 0.5 ≈ a few/day)")
    args = ap.parse_args()

    pos, neg = load_corpus()
    if not pos:
        print("(no owner corpus — running TTS smoke set)", file=sys.stderr)
        pos, neg = smoke_corpus()

    if args.tune or args.roc:
        factory = real_engine_factory()
        pos_rows = score_clips(pos, factory)
        neg_rows = score_clips(neg, factory)

        if args.roc:
            curve = []
            for thr in THRESHOLDS:
                r = report_from_peaks(pos_rows, neg_rows, thr)
                curve.append({"threshold": thr, "recall": r["recall"],
                              "false_wakes_per_hour": r["false_wakes_per_hour"]})
                print(f"thr={thr:.2f} recall={r['recall']:.2f} fw/h={r['false_wakes_per_hour']}",
                      file=sys.stderr)
            print(json.dumps(curve))
            return 0

        best = None
        for thr in THRESHOLDS:
            r = report_from_peaks(pos_rows, neg_rows, thr)
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
              f"(recall={best['recall']:.2f}, fw/h={best['false_wakes_per_hour']})",
              file=sys.stderr)
        print(json.dumps({"recommendation": best}))
        return 0

    report = bench(pos, neg, real_engine_factory(args.threshold))
    print(f"recall={report['recall']:.2f} ({report['positives_fired']}/{report['positives']})  "
          f"false_wakes={report['false_wakes']} over {report['negative_seconds']}s "
          f"= {report['false_wakes_per_hour']}/h", file=sys.stderr)
    for m in report["misses"]:
        print(f"  MISS {m['name']}: {m['reason']} peak={m['peak']}", file=sys.stderr)
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
