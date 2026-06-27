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
