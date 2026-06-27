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


def plan_takes(out_dir, want):
    existing = 0
    if os.path.isdir(out_dir):
        existing = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    return max(0, want - existing)


def _record(out_dir, seconds, label):
    import sounddevice as sd
    import soundfile as sf

    os.makedirs(out_dir, exist_ok=True)
    existing = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    print(f"   SAY/RECORD NOW ({label}) …", flush=True)
    audio = sd.rec(int(seconds * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="int16")
    sd.wait()
    sf.write(clip_path(out_dir, existing), audio, SAMPLE_RATE, subtype="PCM_16")
    time.sleep(0.3)


def record_positives():
    posd, _ = corpus_dirs()
    for prompt in POSITIVE_PROMPTS:
        print(f"\n-- POSITIVE: \"hey james\" — {prompt}")
        for i in range(POSITIVE_TAKES_PER_PROMPT):
            print(f"   [{i + 1}/{POSITIVE_TAKES_PER_PROMPT}] get ready…", end="", flush=True)
            time.sleep(0.8)
            _record(posd, CLIP_SECONDS, prompt)


def record_negatives():
    _, negd = corpus_dirs()
    for prompt, takes in NEGATIVE_PROMPTS:
        print(f"\n-- NEGATIVE: {prompt}  ({takes} takes)")
        for i in range(takes):
            print(f"   [{i + 1}/{takes}] get ready…", end="", flush=True)
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
