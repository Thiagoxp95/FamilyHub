#!/usr/bin/env python3
"""Wake-engine diagnostics over held-out training clips.

Modes:
  scores    — peak engine score per clip (threshold never fires); prints a
              percentile summary per split so threshold placement is visible.
              NOTE the held-out "negative" clips are deliberately ADVERSARIAL
              (james-family confusables), so neg score/fire rates here
              overstate real-room false positives by a wide margin.
  pipeline  — end-to-end recall / false-fires with the real engine at the real
              threshold, plus fire latency vs speech end (p50/p90).

Clips default to the livekit-wakeword held-out sets under
~/.familyhub/lkww-train/work/output/hey_james_v2/{positive_test,negative_test,
background_test}. Run with the sidecar venv:

    sidecar/.venv/bin/python sidecar/diagnose_wake.py scores
    sidecar/.venv/bin/python sidecar/diagnose_wake.py pipeline --limit 200
"""

import argparse
import os
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import wake_listener as wl  # noqa: E402

SR = 16000
CHUNK = 2048
DEFAULT_CLIPS = os.path.expanduser("~/.familyhub/lkww-train/work/output/hey_james_v2")


def load_wav(path):
    with wave.open(path, "rb") as w:
        if not (w.getframerate() == SR and w.getnchannels() == 1):
            raise ValueError(path)
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def iter_clips(root, split, limit):
    d = os.path.join(root, split)
    if not os.path.isdir(d):
        return
    names = sorted(f for f in os.listdir(d) if f.endswith(".wav"))[:limit]
    for name in names:
        yield name, load_wav(os.path.join(d, name))


def make_engine(threshold):
    model = os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "models", "hey_james.onnx")
    )
    return wl.StreamingWakeEngine(model, threshold)


def speech_end_sample(audio, frame=320, floor_ratio=0.1):
    """Last sample index that still contains speech-ish energy."""
    frames = audio[: len(audio) // frame * frame].reshape(-1, frame).astype(np.float32)
    rms = np.sqrt((frames**2).mean(axis=1))
    if rms.max() <= 0:
        return len(audio)
    active = np.nonzero(rms >= rms.max() * floor_ratio)[0]
    return int((active[-1] + 1) * frame) if len(active) else len(audio)


def feed_clip(engine, audio, pad_pre=SR // 2, pad_post=2 * SR):
    """Feed one padded clip; return (fired, fire_sample_offset, peak)."""
    engine.reset()
    stream = np.concatenate(
        [np.zeros(pad_pre, np.int16), audio, np.zeros(pad_post, np.int16)]
    )
    pos = 0
    fire_at = None
    while pos < len(stream):
        chunk = stream[pos : pos + CHUNK]
        pos += len(chunk)
        if engine.feed(chunk.tobytes()) and fire_at is None:
            fire_at = pos
    return fire_at is not None, fire_at, float(engine.observed_peak)


def pct(values, q):
    return float(np.percentile(values, q)) if len(values) else float("nan")


def mode_scores(args):
    engine = make_engine(999.0)
    for split in ("positive_test", "negative_test", "background_test"):
        peaks = []
        for _name, audio in iter_clips(args.clips, split, args.limit):
            _, _, peak = feed_clip(engine, audio)
            peaks.append(peak)
        if not peaks:
            print(f"{split:16} (no clips)")
            continue
        peaks = np.array(peaks)
        print(
            f"{split:16} n={len(peaks):4d} p10={pct(peaks,10):.3f} "
            f"p50={pct(peaks,50):.3f} p90={pct(peaks,90):.3f} max={peaks.max():.3f}"
        )
    return 0


def mode_pipeline(args):
    thr = float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", wl.DEFAULT_THRESHOLD))
    engine = make_engine(thr)

    fired = 0
    latencies = []
    misses = []
    n_pos = 0
    for name, audio in iter_clips(args.clips, "positive_test", args.limit):
        n_pos += 1
        did_fire, fire_at, peak = feed_clip(engine, audio)
        if did_fire:
            fired += 1
            end = speech_end_sample(audio) + SR // 2  # + pre-pad
            latencies.append((fire_at - end) / SR * 1000.0)
        else:
            misses.append((name, peak))
    print(f"positives: recall={fired}/{n_pos} at threshold {thr}")
    if latencies:
        print(
            f"fire latency vs speech end: p50={pct(latencies,50):.0f}ms "
            f"p90={pct(latencies,90):.0f}ms"
        )
    for name, peak in misses[:15]:
        print(f"  MISS {name} peak={peak:.3f}")

    for split in ("negative_test", "background_test"):
        n = fp = 0
        seconds = 0.0
        for _name, audio in iter_clips(args.clips, split, args.limit):
            n += 1
            seconds += (len(audio) + SR // 2 + 2 * SR) / SR
            did_fire, _, _ = feed_clip(engine, audio)
            fp += int(did_fire)
        rate = fp / seconds * 3600 if seconds else 0.0
        print(f"{split}: {fp}/{n} fired ({rate:.2f} false-wakes/hour equivalent)")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["scores", "pipeline"])
    ap.add_argument("--clips", default=DEFAULT_CLIPS)
    ap.add_argument("--limit", type=int, default=300)
    args = ap.parse_args()
    return mode_scores(args) if args.mode == "scores" else mode_pipeline(args)


if __name__ == "__main__":
    sys.exit(main())
