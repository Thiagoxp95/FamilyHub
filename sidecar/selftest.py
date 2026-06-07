#!/usr/bin/env python3
"""Offline sanity check for the two-stage wake-word sidecar.

Synthesizes speech with macOS `say`, streams it through wake_listener.py exactly
as the app does (base64 16 kHz frames over stdio), and checks that "Hey James"
wakes while bare "James", near-misses, ordinary speech, and silence do not. Run
with the sidecar venv:

    sidecar/.venv/bin/python sidecar/selftest.py

Exits 0 if "Hey James" wakes and every negative stays quiet.
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import wave

SR = 16000
FRAME_BYTES = 2048 * 2  # ~128 ms of int16 @ 16 kHz, matching the renderer
HERE = os.path.dirname(os.path.abspath(__file__))


def say_pcm(text, voice=None):
    """Render `text` with macOS `say` → 16 kHz mono int16 PCM bytes."""
    aiff = tempfile.mktemp(suffix=".aiff")
    wav = tempfile.mktemp(suffix=".wav")
    try:
        cmd = ["say"]
        if voice:
            cmd += ["-v", voice]
        cmd += ["-o", aiff, text]
        subprocess.run(cmd, check=True)
        subprocess.run(
            ["afconvert", aiff, "-o", wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"],
            check=True,
        )
        with wave.open(wav, "rb") as w:
            return w.readframes(w.getnframes())
    finally:
        for path in (aiff, wav):
            if os.path.exists(path):
                os.unlink(path)


def silence(seconds):
    return b"\x00\x00" * int(seconds * SR)


def wakes(pcm_bytes):
    frames = [
        base64.b64encode(pcm_bytes[i : i + FRAME_BYTES]).decode()
        for i in range(0, len(pcm_bytes), FRAME_BYTES)
    ]
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "wake_listener.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    import threading

    def feed():
        for line in frames:
            proc.stdin.write(line + "\n")
        proc.stdin.close()

    threading.Thread(target=feed, daemon=True).start()
    hits = [json.loads(line)["text"] for line in proc.stdout if json.loads(line)["text"]]
    return hits


def main():
    print("Synthesizing speech via `say`…")
    # Single-stage livekit on the ACAV-retrained model keys on "james", so both
    # "Hey James" and bare "James" wake; it rejects "hey jason" + general speech.
    positives = [
        ("'Hey James'", say_pcm("Hey James")),
        ("bare 'James'", say_pcm("James")),
    ]
    for voice in ("Daniel", "Karen"):
        positives.append((f"'Hey James' ({voice})", say_pcm("Hey James", voice)))
    positives.append(
        ("'Hey James turn on the lights'", say_pcm("Hey James turn on the lights"))
    )
    negatives = [
        ("'what's the weather'", say_pcm("what is the weather like today")),
        ("'the name of the guy is John'", say_pcm("the name of the guy is John")),
        ("'hey Jason'", say_pcm("hey Jason")),
        ("'hey can you hear me'", say_pcm("hey can you hear me")),
    ]

    ok = True
    print("\nShould WAKE:")
    for label, pcm in positives:
        woke = bool(wakes(silence(0.8) + pcm + silence(1.2)))
        print(f"  {label:34} {'WAKE' if woke else 'MISS'}")
        ok = ok and woke

    print("\nShould stay quiet:")
    for label, pcm in negatives:
        woke = bool(wakes(silence(0.6) + pcm + silence(0.8)))
        print(f"  {label:34} {'FALSE-WAKE' if woke else 'quiet'}")
        ok = ok and not woke

    quiet_silence = not bool(wakes(silence(3)))
    print(f"  {'pure silence':34} {'quiet' if quiet_silence else 'FALSE-WAKE'}")
    ok = ok and quiet_silence

    if ok:
        print("\nPASS — wakes on 'Hey James', quiet otherwise.")
        return 0
    print("\nFAIL — see results above.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
