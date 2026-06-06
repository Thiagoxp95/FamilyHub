#!/usr/bin/env python3
"""FamilyHub wake-word sidecar — Vosk keyword spotting.

A full ASR (Parakeet) leans on language-model context, so it drops an isolated
"James" said on its own. This sidecar instead uses a DEDICATED keyword spotter:
the Vosk acoustic model is constrained to a tiny grammar of just the wake
word(s) + "[unk]", which fires reliably on a bare "James". Gemini Live does the
real transcription once we wake, so the local model only has to spot one word.

Protocol (newline-delimited over stdio):
  stdin  : base64(int16 LINEAR16 @ 16 kHz mono) per line; OR a JSON control line
           such as {"cmd": "reset"} (base64 never starts with "{").
  stdout : one JSON object per line:
             {"type": "partial"|"final", "text": str, "words": []}

The first emitted line is {"type":"partial","text":"","words":[]} as a ready
signal once the model has loaded (the controller treats the first transcript as
"listener ready").
"""

import argparse
import base64
import json
import os
import sys

SAMPLE_RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, "models", "vosk-model-small-en-us-0.15")
DEFAULT_WAKE_WORDS = "james"


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model", default=os.environ.get("FAMILYHUB_VOSK_MODEL", DEFAULT_MODEL)
    )
    parser.add_argument("--wake-words", default=DEFAULT_WAKE_WORDS)
    parser.add_argument("--min-confidence", type=float, default=0.7)
    args = parser.parse_args()

    # Imported lazily so a missing dependency surfaces on stderr, not at import.
    from vosk import KaldiRecognizer, Model, SetLogLevel

    SetLogLevel(-1)

    wake_words = [w.strip().lower() for w in args.wake_words.split(",") if w.strip()]
    # Constrain the decoder to just the wake word(s) + an out-of-vocabulary sink.
    grammar = json.dumps([*wake_words, "[unk]"])
    model = Model(args.model)

    def new_recognizer():
        rec = KaldiRecognizer(model, SAMPLE_RATE, grammar)
        rec.SetWords(True)  # per-word confidences on final results
        return rec

    recognizer = new_recognizer()
    emit({"type": "partial", "text": "", "words": []})  # ready signal
    print(f"vosk model loaded ({len(wake_words)} wake word(s))", file=sys.stderr, flush=True)

    wake_set = set(wake_words)
    min_conf = float(args.min_confidence)

    def partial_is_clean_wake(partial):
        # Fast path: a partial that is EXACTLY the wake word (the isolated /
        # leading-word case). The looser "[unk] james" partials that ordinary
        # speech can produce are intentionally NOT accepted here — they go
        # through the confidence-gated final check instead.
        return partial.strip().lower() in wake_set

    def final_has_confident_wake(result):
        return any(
            word.get("word") in wake_set and word.get("conf", 0.0) >= min_conf
            for word in result.get("result", [])
        )

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
                recognizer = new_recognizer()
            continue

        try:
            pcm = base64.b64decode(line)
        except Exception:  # noqa: BLE001 - skip an unparseable frame
            continue
        if not pcm:
            continue

        if recognizer.AcceptWaveform(pcm):
            result = json.loads(recognizer.Result())
            woke = final_has_confident_wake(result)
            text = result.get("text", "")
        else:
            partial = json.loads(recognizer.PartialResult()).get("partial", "")
            woke = partial_is_clean_wake(partial)
            text = partial

        if woke:
            emit({"type": "final", "text": text or wake_words[0], "words": []})
            # Reset so the same utterance doesn't re-fire on subsequent frames.
            recognizer = new_recognizer()


if __name__ == "__main__":
    main()
