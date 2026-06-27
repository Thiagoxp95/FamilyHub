#!/usr/bin/env python3
"""Fold the owner wake corpus into the openWakeWord training set, so the retrain
learns the owner's actual voice/room. Idempotent (skips already-folded clips).

Positives → generated-positive clips dir; negatives → adversarial-negative clips
dir. Run from sidecar/training with the TRAINING venv after generate_clips has
created my_custom_model/, OR before run_full.sh to seed real positives.

    sidecar/training/.venv/bin/python sidecar/training/fold_owner_corpus.py
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.expanduser("~/.familyhub/wake-corpus")
# openWakeWord train.py writes generated clips under output_dir; these are the
# conventional subdirs it reads back for augmentation. Adjust if hey_james.yml
# output_dir changes.
POS_DST = os.path.join(HERE, "my_custom_model", "positive_clips")
NEG_DST = os.path.join(HERE, "my_custom_model", "adversarial_negative_clips")


def fold(src_dir, dst_dir, prefix):
    if not os.path.isdir(src_dir):
        print(f"  (no {src_dir} — skipping)")
        return 0
    os.makedirs(dst_dir, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(src_dir)):
        if not f.endswith(".wav"):
            continue
        dst = os.path.join(dst_dir, f"{prefix}_{f}")
        if not os.path.exists(dst):
            shutil.copy2(os.path.join(src_dir, f), dst)
            n += 1
    return n


def main():
    pos = fold(os.path.join(CORPUS, "positive"), POS_DST, "owner")
    neg = fold(os.path.join(CORPUS, "negative"), NEG_DST, "owner")
    print(f"folded {pos} owner positives -> {POS_DST}")
    print(f"folded {neg} owner negatives -> {NEG_DST}")
    if pos == 0:
        print("WARNING: no owner positives found — record with record_corpus.py first", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
