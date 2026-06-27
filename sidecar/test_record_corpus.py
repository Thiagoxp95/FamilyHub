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

    # next_index parses the max clip number (+1), NOT the file count, so a resume
    # after deletions never re-uses a live index and clobbers an existing clip.
    with tempfile.TemporaryDirectory() as d:
        c = rc.next_index(d) == 0
        print(f"[{'PASS' if c else 'FAIL'}] next_index empty dir is 0 (got {rc.next_index(d)})")
        ok &= c

        # non-contiguous: only clip_000005.wav present → next is 000006, not 000001
        open(rc.clip_path(d, 5), "w").close()
        got = rc.next_index(d)
        c = got == 6 and rc.clip_path(d, got).endswith("clip_000006.wav")
        print(f"[{'PASS' if c else 'FAIL'}] next_index skips to max+1 on a gap (got {got})")
        ok &= c

        # ignores non-clip files when computing the next index
        open(os.path.join(d, "notes.txt"), "w").close()
        c = rc.next_index(d) == 6
        print(f"[{'PASS' if c else 'FAIL'}] next_index ignores non-clip files (got {rc.next_index(d)})")
        ok &= c

    # corpus_dirs are under the canonical root
    posd, negd = rc.corpus_dirs()
    c = posd.endswith("wake-corpus/positive") and negd.endswith("wake-corpus/negative")
    print(f"[{'PASS' if c else 'FAIL'}] corpus_dirs canonical layout")
    ok &= c

    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
