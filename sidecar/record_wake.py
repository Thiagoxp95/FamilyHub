#!/usr/bin/env python3
"""Record real "Hey James" clips to fold into wake-word training as positives.

Run this on the APPLIANCE (its mic, in the kitchen) for the best result — the
recordings then carry the real mic + room characteristics the model will see.

Setup (one time):
    pip3 install sounddevice soundfile
    # macOS will prompt for microphone access for your terminal — allow it
    # (System Settings → Privacy & Security → Microphone).

Record 40 clips:
    python3 record_wake.py 40 hey_james_clips

It walks you through one utterance at a time: wait for "SAY IT NOW", say
"Hey James" once, naturally. Vary it a little across the 40 — normal voice, a bit
louder, from across the room, a couple while music/TV is on. Re-running resumes
from where you left off. Then copy the whole `hey_james_clips/` folder to the
training machine and tell Claude the path.
"""

import os
import sys
import time

import sounddevice as sd
import soundfile as sf

SAMPLE_RATE = 16000
CLIP_SECONDS = 2.0


def main():
    n_target = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "hey_james_clips"
    os.makedirs(out_dir, exist_ok=True)

    existing = len(
        [f for f in os.listdir(out_dir) if f.startswith("clip_") and f.endswith(".wav")]
    )
    print(f"\nRecording 'Hey James' → {out_dir}/  (have {existing}, target {n_target})")
    print("Say the phrase ONCE per prompt, right after 'SAY IT NOW'. Ctrl-C to stop.\n")

    for i in range(existing, n_target):
        print(f"[{i + 1}/{n_target}] get ready…", end="", flush=True)
        time.sleep(0.7)
        print("  SAY IT NOW: \"Hey James\"")
        audio = sd.rec(
            int(CLIP_SECONDS * SAMPLE_RATE),
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
        )
        sd.wait()
        path = os.path.join(out_dir, f"clip_{i:06d}.wav")
        sf.write(path, audio, SAMPLE_RATE, subtype="PCM_16")
        time.sleep(0.25)

    total = len([f for f in os.listdir(out_dir) if f.endswith(".wav")])
    print(f"\nDone — {total} clips in {out_dir}/. Copy that folder to the training machine.")


if __name__ == "__main__":
    main()
