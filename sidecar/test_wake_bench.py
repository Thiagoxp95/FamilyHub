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
        self._done = False

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
