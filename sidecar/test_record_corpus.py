#!/usr/bin/env python3
"""Unit tests for record_corpus planning/layout (no mic, no audio).

Run: sidecar/.venv/bin/python sidecar/test_record_corpus.py
"""
import os
import sys
import tempfile
import record_corpus as rc


def run():
    ok = True

    # clip_path zero-pads and lands under out_dir
    p = rc.clip_path("/tmp/x", 7)
    c = p.endswith("clip_000007.wav") and p.startswith("/tmp/x")
    print(f"[{'PASS' if c else 'FAIL'}] clip_path zero-pads (got {os.path.basename(p)})")
    ok &= c

    # plan_takes: empty dir wants all
    with tempfile.TemporaryDirectory() as d:
        c = rc.plan_takes(d, 6) == 6
        print(f"[{'PASS' if c else 'FAIL'}] plan_takes empty dir wants all")
        ok &= c

        # after 4 files, wants 2 more; resume-safe; never negative
        for i in range(4):
            open(rc.clip_path(d, i), "w").close()
        c = rc.plan_takes(d, 6) == 2 and rc.plan_takes(d, 3) == 0
        print(f"[{'PASS' if c else 'FAIL'}] plan_takes resumes from existing")
        ok &= c

    # corpus_dirs are under the canonical root
    posd, negd = rc.corpus_dirs()
    c = posd.endswith("wake-corpus/positive") and negd.endswith("wake-corpus/negative")
    print(f"[{'PASS' if c else 'FAIL'}] corpus_dirs canonical layout")
    ok &= c

    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
