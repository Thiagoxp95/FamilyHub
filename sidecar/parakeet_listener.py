#!/usr/bin/env python3
"""FamilyHub always-on local ASR sidecar (Apple Silicon / MLX).

Protocol (newline-delimited over stdio):
  stdin  : base64(int16 LINEAR16 @ 16 kHz mono) per line, OR a JSON control
           line such as {"cmd": "reset"} (base64 never starts with "{").
  stdout : one JSON object per line:
             {"type": "partial"|"final", "text": str,
              "words": [{"word": str, "startMs": int, "endMs": int}]}

The first emitted line is {"type":"partial","text":"","words":[]} as a ready
signal once the model has loaded.
"""

import argparse
import base64
import json
import sys

import numpy as np


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def words_from_result(result):
    words = []
    for sentence in getattr(result, "sentences", None) or []:
        for token in getattr(sentence, "tokens", None) or []:
            text = getattr(token, "text", "")
            start = getattr(token, "start", 0.0) or 0.0
            end = getattr(token, "end", 0.0) or 0.0
            words.append(
                {
                    "word": text,
                    "startMs": int(start * 1000),
                    "endMs": int(end * 1000),
                }
            )
    return words


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3")
    args = parser.parse_args()

    # Imported lazily so a missing dependency surfaces on stderr, not at import.
    import mlx.core as mx
    from parakeet_mlx import from_pretrained

    model = from_pretrained(args.model)

    # NOTE: integration point — confirm `transcribe_stream` exists with this
    # signature in the installed parakeet-mlx version. The context manager
    # yields a streaming transcriber exposing `.add_audio(mx.array)` and a
    # `.result` with `.text` and `.sentences[].tokens[]`.
    def open_stream():
        cm = model.transcribe_stream(context_size=(256, 256))
        return cm, cm.__enter__()

    stream_cm, stream = open_stream()
    emit({"type": "partial", "text": "", "words": []})  # ready signal

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        if line.startswith("{"):
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            if command.get("cmd") == "reset":
                stream_cm.__exit__(None, None, None)
                stream_cm, stream = open_stream()
            continue

        try:
            raw = base64.b64decode(line)
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        except Exception:  # noqa: BLE001 - skip an unparseable frame
            continue

        if samples.size == 0:
            continue

        stream.add_audio(mx.array(samples))
        result = stream.result
        emit(
            {
                "type": "partial",
                "text": getattr(result, "text", "") or "",
                "words": words_from_result(result),
            }
        )

    try:
        stream_cm.__exit__(None, None, None)
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    main()
