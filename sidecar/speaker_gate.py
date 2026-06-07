#!/usr/bin/env python3
"""FamilyHub speaker hard-lock gate.

During a live session only the invoker's voice should reach Gemini — not the
TV/YouTube or other people in the room. This gate (sherpa-onnx silero VAD +
speaker-embedding model):
  - segments the live mic audio into utterances,
  - enrolls the FIRST utterance as the locked speaker,
  - for each later utterance, forwards it ONLY if it matches the locked speaker.

Protocol (newline-delimited over stdio):
  stdin  : base64(int16 LINEAR16 @ 16 kHz mono) per line; OR a JSON control line
           {"cmd": "reset"} to clear enrollment at the start of a new session.
  stdout : {"type":"ready"}
           | {"type":"enrolled"}
           | {"type":"forward","audio":<base64 int16 PCM of the utterance>}
           | {"type":"dropped","score":<float>}
"""

import argparse
import base64
import json
import os
import sys

import numpy as np

SAMPLE_RATE = 16000
WINDOW = 512  # silero VAD window at 16 kHz
HERE = os.path.dirname(os.path.abspath(__file__))


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def decide(refs, locked, emb, threshold):
    """Pure gate verdict.

    refs: list of (speaker_id, voiceprint np.ndarray) — the loaded family.
    locked: the locked reference embedding (np.ndarray) or None.
    emb: the current utterance embedding (np.ndarray).
    Returns one of:
      ("forward", None)   — matches the locked wake voice
      ("drop", None)      — a different voice during a locked session
      ("lock", speaker_id)— first utterance matches family (or open-mic when no
                            refs, speaker_id None) → caller locks to `emb`
      ("rejected", best)  — first utterance matched no enrolled family
    """
    if locked is not None:
        score = float(np.dot(locked, emb))
        return ("forward", None) if score >= threshold else ("drop", None)
    if not refs:
        return ("lock", None)  # open-mic fallback: nobody enrolled yet
    best_id, best = None, -1.0
    for speaker_id, vec in refs:
        score = float(np.dot(vec, emb))
        if score > best:
            best, best_id = score, speaker_id
    return ("lock", best_id) if best >= threshold else ("rejected", best)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vad", default=os.path.join(HERE, "models", "silero_vad.onnx"))
    parser.add_argument(
        "--embedder",
        default=os.path.join(HERE, "models", "nemo_en_titanet_small.onnx"),
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("FAMILYHUB_SPEAKER_THRESHOLD", "0.6")),
    )
    args = parser.parse_args()

    from speaker_embed import embed as embed_samples, load_extractor

    extractor = load_extractor(args.embedder)
    family = []  # list[(speaker_id, np.ndarray)] loaded via {"cmd":"load"}

    def new_vad():
        import sherpa_onnx as so
        cfg = so.VadModelConfig()
        cfg.silero_vad.model = args.vad
        cfg.silero_vad.threshold = 0.5
        cfg.silero_vad.min_silence_duration = 0.4
        cfg.silero_vad.min_speech_duration = 0.25
        cfg.silero_vad.max_speech_duration = 20.0
        cfg.sample_rate = SAMPLE_RATE
        return so.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)

    vad = new_vad()
    reference = None
    locked_id = None
    leftover = np.zeros(0, dtype=np.float32)

    def handle_segment(samples):
        nonlocal reference, locked_id
        vec = embed_samples(extractor, samples)
        pcm16 = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
        audio_b64 = base64.b64encode(pcm16.tobytes()).decode()

        verdict, info = decide(family, reference, vec, args.threshold)
        if verdict == "forward":
            emit({"type": "forward", "audio": audio_b64, "score": 1.0})
        elif verdict == "lock":
            reference = vec
            locked_id = info
            emit({"type": "forward", "audio": audio_b64, "score": 1.0, "speakerId": info})
        elif verdict == "rejected":
            emit({"type": "rejected", "score": round(info, 3)})
        else:  # drop
            emit({"type": "dropped", "score": round(float(np.dot(reference, vec)), 3)})

    emit({"type": "ready"})
    print("speaker gate ready", file=sys.stderr, flush=True)

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
            cmd = command.get("cmd")
            if cmd == "reset":
                vad = new_vad()
                reference = None
                locked_id = None
                leftover = np.zeros(0, dtype=np.float32)
            elif cmd == "load":
                family = [
                    (s["id"], np.asarray(s["vec"], dtype=np.float32))
                    for s in command.get("speakers", [])
                    if isinstance(s.get("vec"), list)
                ]
            continue

        try:
            samples = (
                np.frombuffer(base64.b64decode(line), dtype=np.int16).astype(np.float32)
                / 32768.0
            )
        except Exception:  # noqa: BLE001 - skip an unparseable frame
            continue
        if samples.size == 0:
            continue

        leftover = np.concatenate([leftover, samples])
        while len(leftover) >= WINDOW:
            vad.accept_waveform(np.ascontiguousarray(leftover[:WINDOW]))
            leftover = leftover[WINDOW:]

        while not vad.empty():
            handle_segment(np.array(vad.front.samples, dtype=np.float32))
            vad.pop()


if __name__ == "__main__":
    main()
