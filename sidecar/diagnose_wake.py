#!/usr/bin/env python3
"""Measurement harness for tuning the two-stage wake engine.

Feeds held-out test clips (lkww-train output under
~/.familyhub/lkww-train/work/output/hey_james/) through the REAL engine classes
in-process and reports recall, false-positive rate, stage-1 score
distributions, and detection latency relative to end-of-utterance. Use this to
re-tune FAMILYHUB_WAKE_THRESHOLD / FAMILYHUB_WAKE_S1_BYPASS /
FAMILYHUB_WAKE_POST_TRIGGER_MS whenever the model or verifier chain changes —
NOTE the held-out "negative" clips are deliberately ADVERSARIAL (james-family
confusables, some containing the literal word "james"), so neg fire-rates here
overstate real-room false positives by a wide margin.

Modes:
  scores   — peak stage-1 score per clip (threshold=inf, never fires) so a
             threshold ROC can be computed offline in one pass.
  pipeline — full two-stage run at the configured env; reports recall/FP/latency.
  confirm  — for positives, what Stage 2 actually hears + confirm wall time.

Run with the sidecar venv:
    sidecar/.venv/bin/python sidecar/diagnose_wake.py scores --pos 300 --neg 600
"""

import argparse
import json
import os
import sys
import time
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

DATA = os.path.expanduser("~/.familyhub/lkww-train/work/output/hey_james")
SR = 16000
CHUNK = 2048  # samples per feed() call, ~128 ms, matches renderer framing


def load_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def clips(subdir, limit):
    d = os.path.join(DATA, subdir)
    names = sorted(f for f in os.listdir(d) if f.endswith(".wav"))[:limit]
    return [(n, load_wav(os.path.join(d, n))) for n in names]


def speech_end_sample(audio, win=320, rel_thresh=0.05):
    """Last sample index where energy exceeds rel_thresh * peak RMS."""
    n = len(audio) // win
    x = audio[: n * win].astype(np.float64).reshape(n, win)
    rms = np.sqrt((x**2).mean(axis=1))
    peak = rms.max() or 1.0
    hot = np.nonzero(rms >= rel_thresh * peak)[0]
    return int((hot[-1] + 1) * win) if len(hot) else len(audio)


def feed_clip(engine, audio, pre_s=0.5, post_s=2.0):
    """Feed silence+clip+silence through engine.feed in CHUNK pieces.
    Returns (fired, fire_offset_ms_after_speech_end)."""
    pre = np.zeros(int(pre_s * SR), dtype=np.int16)
    post = np.zeros(int(post_s * SR), dtype=np.int16)
    stream = np.concatenate([pre, audio, post])
    end_sample = len(pre) + speech_end_sample(audio)
    fired_at = None
    pos = 0
    while pos < len(stream):
        chunk = stream[pos : pos + CHUNK]
        pos += len(chunk)
        if engine.feed(chunk.tobytes()) and fired_at is None:
            fired_at = pos
    if fired_at is None:
        return False, None
    return True, (fired_at - end_sample) * 1000.0 / SR


def make_engine(threshold, stage2, post_trigger_ms, model=None):
    os.environ["FAMILYHUB_WAKE_POST_TRIGGER_MS"] = str(post_trigger_ms)
    import wake_listener as wl

    model = model or os.path.join(HERE, "models", "hey_james.onnx")
    confirmer = None
    if stage2:
        verifiers = [
            wl.MoonshineConfirmer(
                os.path.join(HERE, "models", "sherpa-onnx-moonshine-tiny-en-int8")
            ),
            wl.WhisperConfirmer(
                os.path.join(HERE, "models", "sherpa-onnx-whisper-tiny.en")
            ),
            wl.VoskFreeConfirmer(
                os.path.join(HERE, "models", "vosk-model-small-en-us-0.15")
            ),
        ]
        confirmer = wl.ChainConfirmer(verifiers)
    return wl.TwoStageEngine(model, threshold, confirmer, ["james"])


def mode_scores(args):
    """Peak stage-1 score per clip with firing disabled."""
    import wake_listener as wl

    eng = wl.OpenWakeWordEngine(
        args.model or os.path.join(HERE, "models", "hey_james.onnx"), 999.0
    )
    out = {}
    for label, sub, limit in (
        ("pos", "positive_test", args.pos),
        ("neg", "negative_test", args.neg),
        ("bg", "background_test", args.bg),
    ):
        peaks = []
        t0 = time.time()
        for _, audio in clips(sub, limit):
            eng.reset()
            stream = np.concatenate(
                [np.zeros(SR // 2, np.int16), audio, np.zeros(SR, np.int16)]
            )
            peak = 0.0
            pos = 0
            while pos < len(stream):
                chunk = stream[pos : pos + CHUNK]
                pos += len(chunk)
                chunkbytes = chunk.tobytes()
                # mirror feed() framing but read scores directly
                eng._leftover = np.concatenate(
                    [eng._leftover, np.frombuffer(chunkbytes, dtype=np.int16)]
                )
                while len(eng._leftover) >= eng.FRAME:
                    frame = eng._leftover[: eng.FRAME]
                    eng._leftover = eng._leftover[eng.FRAME :]
                    scores = eng.model.predict(frame)
                    peak = max(peak, max((float(v) for v in scores.values()), default=0.0))
            peaks.append(peak)
        out[label] = peaks
        print(
            f"[scores] {label}: n={len(peaks)} took {time.time()-t0:.1f}s",
            file=sys.stderr,
        )
    print(json.dumps(out))


def mode_pipeline(args):
    eng = make_engine(args.threshold, args.stage2, args.post_trigger, args.model)
    results = {}
    for label, sub, limit in (
        ("pos", "positive_test", args.pos),
        ("neg", "negative_test", args.neg),
        ("bg", "background_test", args.bg),
    ):
        fired = 0
        lat = []
        t0 = time.time()
        for _, audio in clips(sub, limit):
            eng.reset()
            f, offset = feed_clip(eng, audio)
            if f:
                fired += 1
                lat.append(offset)
        n = max(1, len(clips(sub, limit)))
        results[label] = {
            "n": n,
            "fired": fired,
            "latency_ms": {
                "p50": float(np.percentile(lat, 50)) if lat else None,
                "p90": float(np.percentile(lat, 90)) if lat else None,
            },
            "wall_s": round(time.time() - t0, 1),
        }
        print(f"[pipeline] {label}: {results[label]}", file=sys.stderr)
    print(json.dumps(results))


def mode_confirm(args):
    """What Moonshine hears on stage-1-firing positives, + decode wall time."""
    import wake_listener as wl

    eng = make_engine(args.threshold, True, args.post_trigger, args.model)
    heard = []
    decode_times = []
    orig_confirm = eng.confirmer.confirm

    def timed_confirm(samples, tokens):
        t0 = time.time()
        result = orig_confirm(samples, tokens)
        decode_times.append(time.time() - t0)
        return result

    eng.confirmer.confirm = timed_confirm
    confirmed = vetoed = nofire = 0
    for name, audio in clips("positive_test", args.pos):
        eng.reset()
        f, _ = feed_clip(eng, audio)
        if f:
            confirmed += 1
        elif getattr(eng, "_last_heard", ""):
            vetoed += 1
            heard.append((name, eng._last_heard))
        else:
            nofire += 1
    print(
        json.dumps(
            {
                "confirmed": confirmed,
                "vetoed": vetoed,
                "stage1_nofire": nofire,
                "decode_ms_p50": float(np.percentile(decode_times, 50) * 1000)
                if decode_times
                else None,
                "decode_ms_p90": float(np.percentile(decode_times, 90) * 1000)
                if decode_times
                else None,
                "vetoed_heard": heard[:40],
            }
        )
    )


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["scores", "pipeline", "confirm"])
    p.add_argument("--pos", type=int, default=300)
    p.add_argument("--neg", type=int, default=600)
    p.add_argument("--bg", type=int, default=80)
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--stage2", type=int, default=0)
    p.add_argument("--post-trigger", type=float, default=640)
    p.add_argument("--model", default=None)
    args = p.parse_args()
    {"scores": mode_scores, "pipeline": mode_pipeline, "confirm": mode_confirm}[
        args.mode
    ](args)


if __name__ == "__main__":
    main()
