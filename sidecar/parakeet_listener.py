#!/usr/bin/env python3
"""FamilyHub local ASR sidecar (Apple Silicon / MLX) with VAD segmentation.

Continuous streaming ASR is the wrong tool for wake-word detection: fed one
long-lived stream of small frames with silence/noise between utterances, it
drops isolated short words (a bare "James" after silence transcribes to "") and
hallucinates on ambient noise. The exact same audio transcribes perfectly when
decoded as a self-contained clip. So instead of streaming continuously we:

  1. Use voice-activity detection (webrtcvad, energy fallback) to find the
     start/end of each spoken utterance.
  2. Transcribe each utterance with a FRESH decode — reliable for short words.
  3. Emit an early "partial" once an utterance is ~0.9 s long (so the wake word
     at the start of a phrase is caught with low latency) and a "final" when the
     utterance ends.

Protocol (newline-delimited over stdio):
  stdin  : base64(int16 LINEAR16 @ 16 kHz mono) per line; OR a JSON control line
           such as {"cmd": "reset"} (base64 never starts with "{").
  stdout : one JSON object per line:
             {"type": "partial"|"final", "text": str,
              "words": [{"word": str, "startMs": int, "endMs": int}]}

The first emitted line is {"type":"partial","text":"","words":[]} as a ready
signal once the model has loaded (the renderer/controller treats the first
transcript as "listener ready").
"""

import argparse
import base64
import json
import sys

import numpy as np

SAMPLE_RATE = 16000
VAD_FRAME_SAMPLES = 480  # 30 ms @ 16 kHz (webrtcvad requires 10/20/30 ms frames)
ONSET_FRAMES = 2  # ~60 ms of speech opens an utterance
SILENCE_HANG_FRAMES = 18  # ~540 ms of trailing silence closes an utterance
PREROLL_SAMPLES = int(0.25 * SAMPLE_RATE)  # keep ~250 ms before onset so "J" isn't clipped
PARTIAL_AT_SAMPLES = int(0.9 * SAMPLE_RATE)  # first wake-partial once utterance reaches ~0.9 s
PARTIAL_WINDOW_SAMPLES = int(1.6 * SAMPLE_RATE)  # transcribe at most the first ~1.6 s for it
MAX_UTTERANCE_SAMPLES = 15 * SAMPLE_RATE  # safety cap on a single utterance


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def words_from_result(result):
    words = []
    for sentence in getattr(result, "sentences", None) or []:
        for token in getattr(sentence, "tokens", None) or []:
            start = getattr(token, "start", 0.0) or 0.0
            end = getattr(token, "end", 0.0) or 0.0
            words.append(
                {
                    "word": getattr(token, "text", ""),
                    "startMs": int(start * 1000),
                    "endMs": int(end * 1000),
                }
            )
    return words


def make_vad(aggressiveness):
    """Return (is_speech, kind). Prefer webrtcvad; fall back to an energy gate."""
    try:
        import webrtcvad

        vad = webrtcvad.Vad(aggressiveness)

        def is_speech(frame_i16):
            return vad.is_speech(frame_i16.tobytes(), SAMPLE_RATE)

        return is_speech, "webrtcvad"
    except Exception:  # noqa: BLE001 - any import/init failure → energy fallback
        floor = {"value": 200.0}

        def is_speech(frame_i16):
            rms = float(np.sqrt(np.mean(frame_i16.astype(np.float32) ** 2)) + 1e-6)
            # Track the ambient floor slowly; speech is well above it.
            if rms < floor["value"]:
                floor["value"] = 0.9 * floor["value"] + 0.1 * rms
            return rms > max(350.0, 3.0 * floor["value"])

        return is_speech, "energy"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3")
    parser.add_argument("--vad-aggressiveness", type=int, default=2)
    args = parser.parse_args()

    # Imported lazily so a missing dependency surfaces on stderr, not at import.
    import mlx.core as mx
    from parakeet_mlx import from_pretrained

    is_speech, vad_kind = make_vad(args.vad_aggressiveness)
    model = from_pretrained(args.model)

    def transcribe(pcm16):
        samples = pcm16.astype(np.float32) / 32768.0
        cm = model.transcribe_stream(context_size=(256, 256))
        stream = cm.__enter__()
        try:
            stream.add_audio(mx.array(samples))
            result = stream.result
            text = (getattr(result, "text", "") or "").strip()
            return text, words_from_result(result)
        finally:
            cm.__exit__(None, None, None)

    emit({"type": "partial", "text": "", "words": []})  # ready signal
    print(f"vad={vad_kind}", file=sys.stderr, flush=True)

    leftover = np.zeros(0, dtype=np.int16)  # samples not yet aligned to a VAD frame
    preroll = np.zeros(0, dtype=np.int16)  # recent audio kept while idle
    utterance = None  # accumulating int16 utterance, or None when idle
    speech_run = 0
    silence_run = 0
    partial_sent = False

    def reset_state():
        nonlocal utterance, preroll, speech_run, silence_run, partial_sent
        utterance = None
        preroll = np.zeros(0, dtype=np.int16)
        speech_run = 0
        silence_run = 0
        partial_sent = False

    # readline() (not `for line in sys.stdin`) avoids Python's block read-ahead,
    # so frames are processed as they stream in.
    while True:
        line = sys.stdin.readline()
        if line == "":  # EOF
            break
        line = line.strip()
        if not line:
            continue

        if line.startswith("{"):
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            if command.get("cmd") == "reset":
                reset_state()
            continue

        try:
            chunk = np.frombuffer(base64.b64decode(line), dtype=np.int16)
        except Exception:  # noqa: BLE001 - skip an unparseable frame
            continue
        if chunk.size == 0:
            continue

        leftover = np.concatenate([leftover, chunk])

        while len(leftover) >= VAD_FRAME_SAMPLES:
            frame = leftover[:VAD_FRAME_SAMPLES]
            leftover = leftover[VAD_FRAME_SAMPLES:]
            speech = is_speech(frame)

            if utterance is None:
                preroll = np.concatenate([preroll, frame])[-PREROLL_SAMPLES:]
                if speech:
                    speech_run += 1
                    if speech_run >= ONSET_FRAMES:
                        utterance = np.concatenate([preroll, frame])
                        speech_run = 0
                        silence_run = 0
                        partial_sent = False
                else:
                    speech_run = 0
                continue

            utterance = np.concatenate([utterance, frame])
            silence_run = 0 if speech else silence_run + 1

            if not partial_sent and len(utterance) >= PARTIAL_AT_SAMPLES:
                partial_sent = True
                text, words = transcribe(utterance[:PARTIAL_WINDOW_SAMPLES])
                if text:
                    emit({"type": "partial", "text": text, "words": words})

            if silence_run >= SILENCE_HANG_FRAMES or len(utterance) >= MAX_UTTERANCE_SAMPLES:
                text, words = transcribe(utterance[:MAX_UTTERANCE_SAMPLES])
                if text:
                    emit({"type": "final", "text": text, "words": words})
                reset_state()


if __name__ == "__main__":
    main()
