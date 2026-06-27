#!/usr/bin/env python3
"""Guided recorder for the owner wake corpus (positives + room negatives).

Captures YOUR "hey james" across realistic variation (the misses are
voice/volume/articulation-specific, so synthetic clips can't substitute) plus
your room's ambient negatives. Output feeds BOTH the bench (wake_bench.py) and
the personalized retrain (training/). Re-running resumes.

Run from a terminal at your normal counter spot, near the USB mic:
    sidecar/.venv/bin/python sidecar/record_corpus.py            # both
    sidecar/.venv/bin/python sidecar/record_corpus.py positive   # just positives
    sidecar/.venv/bin/python sidecar/record_corpus.py negative   # just negatives
"""
import os
import re
import sys
import time

SAMPLE_RATE = 16000
CLIP_SECONDS = 3.0
NEG_CLIP_SECONDS = 8.0  # ambient negatives are longer
ROOT = os.path.expanduser("~/.familyhub/wake-corpus")

# Say "hey james" each time, varying ONE thing per prompt — these variations are
# exactly where the current model misses.
POSITIVE_PROMPTS = [
    "normal voice, facing the mic",
    "quiet / almost mumbled",
    "fast, run the words together",
    "slow and clearly separated",
    "turned away from the mic",
    "from a step or two further back",
    "casual, like you're busy cooking",
    "normal voice again (different time of day if you can)",
]
POSITIVE_TAKES_PER_PROMPT = 6  # ~48 positives total

# Room negatives: capture whatever is normally on, plus the came/games family.
NEGATIVE_PROMPTS = [
    ("TV or YouTube playing at normal volume — stay silent", 4),
    ("music playing — stay silent", 3),
    ("normal kitchen conversation, NOT saying hey james", 4),
    ("say: he came home", 3),
    ("say: hey games", 3),
    ("say: she came by", 2),
]


def corpus_dirs():
    return os.path.join(ROOT, "positive"), os.path.join(ROOT, "negative")


def clip_path(out_dir, index):
    return os.path.join(out_dir, f"clip_{index:06d}.wav")


_CLIP_RE = re.compile(r"clip_(\d+)\.wav$")


def next_index(out_dir):
    """Next clip index = (max existing clip_NNNNNN.wav number) + 1, or 0 if none.

    Parses the numeric suffix instead of counting files, so a resume after some
    clips were deleted never re-uses a live number: if only clip_000005.wav
    remains, the next clip is clip_000006.wav (not clip_000001.wav, which a
    count-based index would pick and silently clobber clip_000005 later)."""
    hi = -1
    if os.path.isdir(out_dir):
        for f in os.listdir(out_dir):
            m = _CLIP_RE.match(f)
            if m:
                hi = max(hi, int(m.group(1)))
    return hi + 1


def plan_takes(out_dir, want):
    existing = 0
    if os.path.isdir(out_dir):
        existing = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    return max(0, want - existing)


def _record(out_dir, seconds, label):
    import sounddevice as sd
    import soundfile as sf

    os.makedirs(out_dir, exist_ok=True)
    index = next_index(out_dir)
    print(f"   SAY/RECORD NOW ({label}) …", flush=True)
    audio = sd.rec(int(seconds * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="int16")
    sd.wait()
    sf.write(clip_path(out_dir, index), audio, SAMPLE_RATE, subtype="PCM_16")
    time.sleep(0.3)


def record_positives():
    posd, _ = corpus_dirs()
    target = len(POSITIVE_PROMPTS) * POSITIVE_TAKES_PER_PROMPT
    for prompt in POSITIVE_PROMPTS:
        # Recompute remaining each prompt so a resume (some clips already on disk)
        # records only what is still missing and stops once the target is met.
        n = min(POSITIVE_TAKES_PER_PROMPT, plan_takes(posd, target))
        if n == 0:
            break
        print(f"\n-- POSITIVE: \"hey james\" — {prompt}")
        for i in range(n):
            print(f"   [{i + 1}/{n}] get ready…", end="", flush=True)
            time.sleep(0.8)
            _record(posd, CLIP_SECONDS, prompt)


def record_negatives():
    _, negd = corpus_dirs()
    target = sum(t for _, t in NEGATIVE_PROMPTS)
    for prompt, takes in NEGATIVE_PROMPTS:
        n = min(takes, plan_takes(negd, target))
        if n == 0:
            break
        print(f"\n-- NEGATIVE: {prompt}  ({n} takes)")
        for i in range(n):
            print(f"   [{i + 1}/{n}] get ready…", end="", flush=True)
            time.sleep(0.8)
            _record(negd, NEG_CLIP_SECONDS, prompt)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    print("\n=== wake corpus recording ===")
    print("Speak from your normal counter spot, near the USB mic. Ctrl-C to stop (resumable).")
    if which in ("both", "positive"):
        record_positives()
    if which in ("both", "negative"):
        record_negatives()
    posd, negd = corpus_dirs()
    print(f"\nDone. Positives in {posd}/, negatives in {negd}/.")
    print("Next: sidecar/.venv/bin/python sidecar/wake_bench.py   (baseline), then tell Claude.")


if __name__ == "__main__":
    main()
