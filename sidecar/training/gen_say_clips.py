#!/usr/bin/env python3
"""Generate "hey james" positives (and confusable negatives) with macOS `say`
across all real English + Portuguese voices, as 16 kHz mono WAV staged for
merging into the livekit-wakeword training set.

Third TTS engine family (vs piper VITS + VoxCPM2) => timbre diversity, and the
pt_BR voices give Portuguese-accented English positives (the owner's accent
class). Pure stdlib.
"""

import os
import random
import re
import subprocess
import sys
import tempfile

STAGING = os.path.expanduser("~/.familyhub/lkww-train/work/say_staging")

# Novelty/singing voices that would poison training data.
DENYLIST = {
    "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News",
    "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
    "Albert",  # frog croak
    "Deranged", "Hysterical",
}

POSITIVE_PHRASES = ["hey James", "hey, James"]
NEGATIVE_PHRASES = [
    # Confusable-family negatives need DENSITY in this voice family: with only
    # one rate and a short list, the first trained model scored bare "James"/
    # "hey games" at 0.9+ in say voices while rejecting the same phrases in
    # piper voices — the say positives taught "say-timbre + james-ish => wake"
    # without enough say-voice contrast. Phrases containing the bare wake token
    # teach that "james" WITHOUT the "hey" prefix must stay quiet.
    "hey Jason", "hey Jane", "hey Jamie", "hey Shane", "hey games",
    "hey gems", "hey jams", "hey chains", "hey change", "hey Dave",
    "hey dreams", "hey names", "James", "okay James", "James is here",
    "ask James later", "he came home", "she came by", "the game starts now",
]
POS_RATES = [130, 160, 190, 220]
NEG_RATES = [150, 200]
TEST_FRACTION = 0.15


def list_voices():
    out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, check=True).stdout
    voices = []
    for line in out.splitlines():
        # "<name> <lang>    # <demo>" — name may contain spaces/parens, so
        # anchor on the lang code being the last token before the '#'.
        m = re.match(r"^(.+?)\s+([a-z]{2}[_-][A-Za-z-]+)\s*#", line)
        if not m:
            continue
        name, lang = m.group(1).strip(), m.group(2)
        if not (lang.startswith("en") or lang.startswith("pt")):
            continue
        base = name.split(" (")[0]
        if base in DENYLIST:
            continue
        voices.append((name, lang))
    return voices


def synth(voice, text, rate, out_wav):
    aiff = tempfile.mktemp(suffix=".aiff")
    try:
        subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", aiff, text],
                       check=True, capture_output=True)
        subprocess.run(["afconvert", aiff, "-o", out_wav,
                        "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"],
                       check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError:
        return False
    finally:
        if os.path.exists(aiff):
            os.unlink(aiff)


def main():
    rng = random.Random(42)
    for d in ("positive_train", "positive_test", "negative_train", "negative_test"):
        os.makedirs(os.path.join(STAGING, d), exist_ok=True)

    voices = list_voices()
    print(f"{len(voices)} voices: {[v for v, _ in voices]}", flush=True)

    jobs = []  # (kind, voice, phrase, rate)
    for voice, _lang in voices:
        for phrase in POSITIVE_PHRASES:
            for rate in POS_RATES:
                jobs.append(("positive", voice, phrase, rate))
        for phrase in NEGATIVE_PHRASES:
            for rate in NEG_RATES:
                jobs.append(("negative", voice, phrase, rate))

    counts = {"positive": 0, "negative": 0, "fail": 0}
    for idx, (kind, voice, phrase, rate) in enumerate(jobs):
        split = "test" if rng.random() < TEST_FRACTION else "train"
        # idx disambiguates phrase variants that slugify identically
        # ("hey James" vs "hey, James").
        slug = re.sub(r"[^a-z0-9]+", "_", f"{voice}_{phrase}_{rate}".lower()).strip("_")
        out = os.path.join(STAGING, f"{kind}_{split}", f"say_{idx:04d}_{slug}.wav")
        if synth(voice, phrase, rate, out):
            counts[kind] += 1
        else:
            counts["fail"] += 1
            print(f"FAIL {voice} {phrase!r}", flush=True)
    print(f"done: {counts}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
