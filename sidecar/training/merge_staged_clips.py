#!/usr/bin/env python3
"""Merge staged clip sets (macOS `say` voices, VoxCPM2 accented personas, …)
into the livekit-wakeword training layout BEFORE `livekit-wakeword augment`.

The augment stage only processes files named clip_NNNNNN.wav (strict regex in
livekit.wakeword.data.augment), so every merged clip is renumbered to continue
the destination's numbering — never copied under its original name.

Usage (paths relative to ~/.familyhub/lkww-train unless absolute):
    python3 merge_staged_clips.py \
        --dest work/output/hey_james_v2 \
        --src work/say_staging \
        --src work/output/hey_james_v2_voxcpm

Each --src must contain some of: positive_train/ positive_test/
negative_train/ negative_test/ — matching split dirs are merged 1:1.
"""

import argparse
import os
import re
import shutil
import sys

ROOT = os.path.expanduser("~/.familyhub/lkww-train")
SPLITS = ("positive_train", "positive_test", "negative_train", "negative_test")
CLIP_RE = re.compile(r"^clip_(\d{6})\.wav$")


def resolve(path):
    return path if os.path.isabs(path) else os.path.join(ROOT, path)


def next_index(dest_dir):
    top = -1
    for name in os.listdir(dest_dir):
        m = CLIP_RE.match(name)
        if m:
            top = max(top, int(m.group(1)))
    return top + 1


def merge_split(src_dir, dest_dir):
    if not os.path.isdir(src_dir):
        return 0
    os.makedirs(dest_dir, exist_ok=True)
    index = next_index(dest_dir)
    copied = 0
    for name in sorted(os.listdir(src_dir)):
        if not name.endswith(".wav"):
            continue
        shutil.copyfile(
            os.path.join(src_dir, name),
            os.path.join(dest_dir, f"clip_{index:06d}.wav"),
        )
        index += 1
        copied += 1
    return copied


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", required=True, help="model output dir (has positive_train/ …)")
    ap.add_argument("--src", action="append", required=True, help="staging dir; repeatable")
    args = ap.parse_args()

    dest = resolve(args.dest)
    total = 0
    for src in args.src:
        src = resolve(src)
        for split in SPLITS:
            n = merge_split(os.path.join(src, split), os.path.join(dest, split))
            if n:
                print(f"{split}: +{n} from {src}")
            total += n
    print(f"merged {total} clips into {dest}")
    return 0 if total else 1


if __name__ == "__main__":
    sys.exit(main())
