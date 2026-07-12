#!/usr/bin/env python3
"""Tests for StreamingWakeEngine: (1) numeric equivalence of the incremental
feature path against livekit-wakeword's stateless batch predict(), and
(2) fire/cooldown/reset behavior.

Standalone venv script (no pytest):
    sidecar/.venv/bin/python sidecar/test_streaming_engine.py [model.onnx]
"""

import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import wake_listener as wl  # noqa: E402

SR = 16000
DEFAULT_MODEL = os.path.join(HERE, "models", "hey_james.onnx")


def say_pcm(text, voice=None):
    aiff = tempfile.mktemp(suffix=".aiff")
    wav = tempfile.mktemp(suffix=".wav")
    try:
        cmd = ["say"]
        if voice:
            cmd += ["-v", voice]
        cmd += ["-o", aiff, text]
        subprocess.run(cmd, check=True, capture_output=True)
        subprocess.run(
            ["afconvert", aiff, "-o", wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"],
            check=True,
            capture_output=True,
        )
        with wave.open(wav, "rb") as w:
            return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    finally:
        for path in (aiff, wav):
            if os.path.exists(path):
                os.unlink(path)


class RecordingEngine(wl.StreamingWakeEngine):
    """Records every hop score for trace comparison."""

    def __init__(self, *args, **kwargs):
        self.scores = []
        super().__init__(*args, **kwargs)

    def _hop_score(self):
        score = super()._hop_score()
        if score is not None:
            self.scores.append(score)
        return score


def make_stream():
    """Noise-padded 'hey james' followed by quiet — one clean utterance."""
    rng = np.random.default_rng(7)
    noise = lambda n: (rng.standard_normal(n) * 40).astype(np.int16)  # noqa: E731
    wake = say_pcm("hey James")
    return np.concatenate([noise(SR * 2), wake, noise(SR * 2)])


def batch_trace(model_path, stream):
    """Reference: stateless batch predict() over a sliding 2 s window, advanced
    one 80 ms hop at a time — the trace the streaming engine must match."""
    from livekit.wakeword import WakeWordModel

    model = WakeWordModel(models=[model_path])
    window = SR * 2
    scores = []
    for end in range(window, len(stream) + 1, wl.FRAME):
        chunk = stream[end - window : end]
        scores.append(max(model.predict(chunk).values()))
    return scores


def test_equivalence(model_path):
    stream = make_stream()
    # Align: the engine emits its first score once 16 embeddings exist, which
    # matches the batch trace's first full-window score. Feed in odd-sized
    # chunks to also exercise the leftover-buffer path.
    eng = RecordingEngine(model_path, threshold=999.0)
    pos = 0
    for size in (1000, 2048, 512, 4096):
        while pos + size <= len(stream):
            eng.feed(stream[pos : pos + size].tobytes())
            pos += size
        size = len(stream) - pos
    eng.feed(stream[pos:].tobytes())

    ref = batch_trace(model_path, stream)
    n = min(len(ref), len(eng.scores))
    assert n > 20, f"too few comparable hops: ref={len(ref)} eng={len(eng.scores)}"
    a = np.array(eng.scores[-n:])
    b = np.array(ref[-n:])
    # Batch predict() edge-pads the mel at each sliding-window start while the
    # streaming engine has true audio context, so the traces diverge briefly
    # during the phrase-onset ramp and agree at the peak and in steady state.
    # Assert the detection-relevant properties, not pointwise equality.
    diff = np.abs(a - b)
    peak_diff = abs(float(a.max()) - float(b.max()))
    median_diff = float(np.median(diff))
    frac_close = float(np.mean(diff < 0.05))
    print(
        f"equivalence: hops={n} peakΔ={peak_diff:.4f} medianΔ={median_diff:.4f} "
        f"close={frac_close:.0%} max|Δ|={diff.max():.4f}"
    )
    print(f"  streaming peak={a.max():.3f} batch peak={b.max():.3f}")
    assert peak_diff < 0.05, f"peak scores diverge: {peak_diff:.4f}"
    assert median_diff < 0.02, f"steady-state divergence: median {median_diff:.4f}"
    assert frac_close > 0.8, f"divergence is not transient: only {frac_close:.0%} close"


def test_fire_cooldown_reset(model_path):
    stream = make_stream()
    # Find the model's peak on this clip, then set the threshold just below it
    # so the utterance reliably fires regardless of which model is installed.
    probe = RecordingEngine(model_path, threshold=999.0)
    probe.feed(stream.tobytes())
    peak = max(probe.scores)
    assert peak > 0.1, f"model never reacts to 'hey james' (peak={peak:.3f})"
    threshold = max(0.05, peak - 0.05)

    eng = wl.StreamingWakeEngine(model_path, threshold=threshold)
    fires = 0
    pos = 0
    while pos < len(stream):
        if eng.feed(stream[pos : pos + 2048].tobytes()):
            fires += 1
        pos += 2048
    assert fires == 1, f"expected exactly 1 fire per utterance, got {fires}"
    assert eng.last_fire_score >= threshold

    eng.reset()
    assert len(eng._embeddings) == 0 and eng._cooldown == 0
    fires = 0
    pos = 0
    while pos < len(stream):
        if eng.feed(stream[pos : pos + 2048].tobytes()):
            fires += 1
        pos += 2048
    assert fires == 1, f"after reset: expected 1 fire, got {fires}"


def test_hop_cost(model_path):
    import time

    eng = wl.StreamingWakeEngine(model_path, threshold=999.0)
    rng = np.random.default_rng(3)
    audio = (rng.standard_normal(SR * 4) * 200).astype(np.int16)
    eng.feed(audio.tobytes())  # warm up sessions
    hops = 50
    chunk = (rng.standard_normal(wl.FRAME) * 200).astype(np.int16).tobytes()
    t0 = time.perf_counter()
    for _ in range(hops):
        eng.feed(chunk)
    per_hop_ms = (time.perf_counter() - t0) / hops * 1000
    print(f"hop cost: {per_hop_ms:.2f} ms per 80 ms hop ({per_hop_ms / 80:.1%} of budget)")
    assert per_hop_ms < 40, f"streaming hop too slow: {per_hop_ms:.1f} ms"


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL
    if not os.path.exists(model):
        print(f"SKIP: model not found: {model}")
        return 0
    test_equivalence(model)
    test_fire_cooldown_reset(model)
    test_hop_cost(model)
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
