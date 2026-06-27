#!/usr/bin/env python3
"""The OR-rule: a Stage-1 score >= s2_or_score wakes even if Stage-2 would veto.
Default (1.01) keeps the rule OFF. Uses a fake confirmer that always vetoes.

Run: sidecar/.venv/bin/python sidecar/test_or_rule.py
"""
import os
import sys
import numpy as np

# Disable the high-confidence bypass so a clean "hey James" (~0.99 on Stage 1)
# traverses the Stage-2 / OR-rule path instead of firing instantly at bypass=0.90.
os.environ["FAMILYHUB_WAKE_S1_BYPASS"] = "1.1"
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
