#!/usr/bin/env python3
"""Offline sanity check for the Parakeet wake-word sidecar.

Synthesizes speech with macOS `say`, streams it through parakeet_listener.py
exactly as the app does (base64 16 kHz frames over stdio), and checks that an
isolated "James" and a full phrase are both transcribed. Run with the sidecar
venv:

    sidecar/.venv/bin/python sidecar/selftest.py

Exits 0 if isolated "James" is detected, 1 otherwise.
"""

import base64
import json
import os
import subprocess
import sys
import threading
import tempfile

import numpy as np

SR = 16000
FRAME = 2048  # ~128 ms, matching the renderer's frame size
HERE = os.path.dirname(os.path.abspath(__file__))


def say_pcm16(text):
    """Render `text` with macOS `say` and return 16 kHz mono int16 samples."""
    import librosa  # noqa: PLC0415 - heavy import, only needed here

    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as f:
        aiff = f.name
    try:
        subprocess.run(["say", "-o", aiff, text], check=True)
        audio, _ = librosa.load(aiff, sr=SR, mono=True)
    finally:
        os.unlink(aiff)
    return (np.clip(audio, -1, 1) * 32767).astype(np.int16)


def run_through_sidecar(stream_i16):
    frames = [
        base64.b64encode(stream_i16[i : i + FRAME].tobytes()).decode()
        for i in range(0, len(stream_i16), FRAME)
    ]
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "parakeet_listener.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )

    def feed():
        for line in frames:
            proc.stdin.write(line + "\n")
        proc.stdin.close()

    threading.Thread(target=feed, daemon=True).start()
    transcripts = []
    for line in proc.stdout:
        msg = json.loads(line)
        if msg.get("text"):
            transcripts.append((msg["type"], msg["text"]))
    return transcripts


def silence(seconds):
    return np.zeros(int(seconds * SR), dtype=np.int16)


def main():
    print("Synthesizing speech via `say`…")
    james = say_pcm16("James")
    phrase = say_pcm16("James, what's the weather in Toronto today?")

    print("\n[1/2] isolated 'James' (between silence):")
    stream = np.concatenate([silence(1.5), james, silence(1.5)])
    isolated = run_through_sidecar(stream)
    for kind, text in isolated:
        print(f"    {kind:7} {text!r}")
    isolated_ok = any("james" in t.lower() for _, t in isolated)

    print("\n[2/2] phrase:")
    stream = np.concatenate([silence(1.0), phrase, silence(1.5)])
    phrase_out = run_through_sidecar(stream)
    for kind, text in phrase_out:
        print(f"    {kind:7} {text!r}")
    phrase_ok = any("james" in t.lower() for _, t in phrase_out)

    print()
    print(f"  isolated 'James' detected: {'YES' if isolated_ok else 'NO'}")
    print(f"  phrase 'James' detected  : {'YES' if phrase_ok else 'NO'}")

    if isolated_ok:
        print("\nPASS — the sidecar catches the wake word.")
        return 0
    print("\nFAIL — isolated 'James' was not detected.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
