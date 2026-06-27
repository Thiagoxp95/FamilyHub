#!/usr/bin/env python3
"""Behavioral test: an attenuated 'hey James' that Stage-2 vetoes without AGC
should wake WITH AGC. Uses macOS `say`, no owner clips.

Calibration notes:
  - openWakeWord Stage-1 is amplitude-invariant (scores 0.987 at all levels),
    so separation is demonstrated at Stage-2 (Moonshine confirm), not Stage-1.
  - FAMILYHUB_WAKE_S1_BYPASS=1.1 forces every Stage-1 candidate through Stage-2.
  - factor=0.006 (~44 dB down) puts the clip below Moonshine's raw decoding
    floor (rms≈15) but above what AGC can lift with vad_floor_rms=5.
  - WakeBandConditioner(vad_floor_rms=5.0) amplifies at rms=15 (default 120
    would not); max_gain=8 lifts output to rms≈69, which Moonshine decodes.

Run: sidecar/.venv/bin/python sidecar/test_agc_wake.py
"""
import os
import sys
import numpy as np

os.environ.setdefault("FAMILYHUB_WAKE_POST_TRIGGER_MS", "320")
# Force Stage-2 always (Stage-1 scores 0.987 regardless of amplitude for clean
# TTS; bypass would fire immediately and skip the Stage-2 where AGC separation
# is visible).
os.environ["FAMILYHUB_WAKE_S1_BYPASS"] = "1.1"
import wake_listener as wl
from wake_bench import say_pcm  # reuse TTS helper

SR = 16000
CHUNK = 2048

# Calibrated attenuation: ~44 dB down → rms≈15, Moonshine raw decode fails
ATTENUATION = 0.006


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
    # ~44 dB down: rms≈15, Moonshine raw decode fails ("Page aims.")
    quiet = (loud.astype(np.float64) * ATTENUATION).astype(np.int16)

    no_agc = make(0.32, None)
    fired_quiet_noagc = feed(no_agc, quiet)

    from audio_frontend import WakeBandConditioner
    # vad_floor_rms=5.0: amplifies at rms=15 (default 120 would not).
    # max_gain=8 lifts output to rms≈69 which Moonshine decodes correctly.
    with_agc = make(0.32, WakeBandConditioner(vad_floor_rms=5.0))
    fired_quiet_agc = feed(with_agc, quiet)

    # The whole point: AGC recovers a quiet utterance the raw path misses.
    c = (not fired_quiet_noagc) and fired_quiet_agc
    print(f"[{'PASS' if c else 'FAIL'}] AGC recovers attenuated wake "
          f"(raw_fired={fired_quiet_noagc}, agc_fired={fired_quiet_agc})")
    ok &= c

    # AGC must not break a normal-volume wake.
    with_agc2 = make(0.32, WakeBandConditioner(vad_floor_rms=5.0))
    c2 = feed(with_agc2, loud)
    print(f"[{'PASS' if c2 else 'FAIL'}] AGC still wakes on normal-volume utterance")
    ok &= c2
    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
