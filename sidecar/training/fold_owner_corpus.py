#!/usr/bin/env python3
"""Fold the owner wake corpus into the openWakeWord training set, so the retrain
learns the owner's actual voice/room. Idempotent (skips already-folded clips by
destination filename).

openWakeWord's train.py reads training clips from
``{output_dir}/{model_name}/{positive_train,negative_train}`` (see its lines
648-651). With hey_james.yml (output_dir ./my_custom_model, model_name hey_james)
those are ``my_custom_model/hey_james/positive_train`` and
``.../negative_train`` — the dirs the trainer actually augments from. Positives →
positive_train; negatives → negative_train.

Run from sidecar/training with the TRAINING venv. Run this BEFORE run_full.sh:
train.py:667 counts the clips already in positive_train and only tops up to
n_samples, so seeding the owner clips first folds them into the training set
(rather than being ignored). Re-running is safe — already-folded clips are
skipped by destination filename.

    sidecar/training/.venv/bin/python sidecar/training/fold_owner_corpus.py
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.expanduser("~/.familyhub/wake-corpus")
# The dirs openWakeWord train.py actually reads training clips from:
# {output_dir}/{model_name}/{positive_train,negative_train} (train.py:648-651).
# For hey_james.yml that is my_custom_model/hey_james/{positive,negative}_train.
# Adjust if hey_james.yml output_dir/model_name changes.
POS_DST = os.path.join(HERE, "my_custom_model", "hey_james", "positive_train")
NEG_DST = os.path.join(HERE, "my_custom_model", "hey_james", "negative_train")


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
