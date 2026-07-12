#!/usr/bin/env python3
"""Unit tests for wake_bench classification + reporting (no owner corpus needed).

Run with the sidecar venv:
    sidecar/.venv/bin/python sidecar/test_wake_bench.py
Exits 0 if all cases pass, 1 otherwise.
"""
import sys

import numpy as np

import wake_bench as wb


class FakeEngine:
    """Duck-types StreamingWakeEngine for classify_clip: feed/reset +
    observed_peak attribute."""

    def __init__(self, should_fire, peak):
        self.should_fire = should_fire
        self.peak = peak
        self.observed_peak = 0.0
        self.resets = 0

    def reset(self):
        self.resets += 1
        self.observed_peak = 0.0

    def feed(self, pcm_bytes):
        self.observed_peak = self.peak
        return self.should_fire


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


def run():
    audio = np.zeros(16000, dtype=np.int16)

    # classify_clip: fire + peak reporting
    fired, peak = wb.classify_clip(FakeEngine(True, 0.9), audio)
    assert fired and approx(peak, 0.9), (fired, peak)
    fired, peak = wb.classify_clip(FakeEngine(False, 0.2), audio)
    assert not fired and approx(peak, 0.2), (fired, peak)

    # bench(): report shape + recall math (contract parsed by promote_model.sh)
    clips = [("a", audio), ("b", audio)]
    report = wb.bench(clips, clips, lambda: FakeEngine(True, 0.8))
    assert report["recall"] == 1.0 and report["positives"] == 2
    assert report["positives_fired"] == 2 and report["misses"] == []
    assert report["false_wakes"] == 2  # fires on negatives too
    assert report["negative_seconds"] > 0 and report["false_wakes_per_hour"] > 0
    for key in ("recall", "positives", "positives_fired", "false_wakes",
                "negative_seconds", "false_wakes_per_hour", "misses"):
        assert key in report, key

    report = wb.bench(clips, clips, lambda: FakeEngine(False, 0.15))
    assert report["recall"] == 0.0 and report["false_wakes"] == 0
    assert len(report["misses"]) == 2
    assert report["misses"][0]["reason"] == "nofire"
    assert approx(report["misses"][0]["peak"], 0.15)

    # report_from_peaks: threshold math for --roc/--tune
    pos_rows = [("p1", 0.9, 2.0), ("p2", 0.4, 2.0), ("p3", 0.1, 2.0)]
    neg_rows = [("n1", 0.5, 2.0), ("n2", 0.05, 2.0)]
    r = wb.report_from_peaks(pos_rows, neg_rows, 0.3)
    assert approx(r["recall"], 2 / 3), r["recall"]
    assert r["false_wakes"] == 1
    assert [m["name"] for m in r["misses"]] == ["p3"]
    r = wb.report_from_peaks(pos_rows, neg_rows, 0.95)
    assert r["recall"] == 0.0 and r["false_wakes"] == 0

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(run())
