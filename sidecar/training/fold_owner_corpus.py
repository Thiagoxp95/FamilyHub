#!/usr/bin/env python3
"""Fold the owner wake corpus into the livekit-wakeword training set, so the
retrain learns the owner's actual voice/room — the single most-validated lever
for accent recall (Home Assistant cut accent false-rejects 18%→5% with real
recordings; synthetic-only pipelines plateau).

Owner clips from ~/.familyhub/wake-corpus/{positive,negative} (recorded with
record_corpus.py, 16 kHz mono) are copied into
~/.familyhub/lkww-train/work/output/<model>/{positive,negative}_train as
clip_NNNNNN.wav continuations (the augment stage only accepts that naming),
oversampled --dup times so a few dozen real clips carry weight against 25k
synthetic ones. Run BEFORE `livekit-wakeword augment`.

    python3 fold_owner_corpus.py [--model hey_james_v2] [--dup 25]
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from merge_staged_clips import merge_split  # noqa: E402

CORPUS = os.path.expanduser("~/.familyhub/wake-corpus")
OUTPUT = os.path.expanduser("~/.familyhub/lkww-train/work/output")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="hey_james_v2")
    ap.add_argument("--dup", type=int, default=25,
                    help="times each owner clip is folded in (oversampling weight)")
    args = ap.parse_args()

    dest = os.path.join(OUTPUT, args.model)
    pos = neg = 0
    for _ in range(max(1, args.dup)):
        pos += merge_split(os.path.join(CORPUS, "positive"),
                           os.path.join(dest, "positive_train"))
        neg += merge_split(os.path.join(CORPUS, "negative"),
                           os.path.join(dest, "negative_train"))
    print(f"folded {pos} owner-positive and {neg} owner-negative copies into {dest}")
    if pos == 0:
        print("WARNING: no owner positives found — record with record_corpus.py first",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
