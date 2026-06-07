#!/usr/bin/env python3
"""FamilyHub wake-word sidecar.

A full ASR (Parakeet) drops a bare isolated "James" because it leans on
language-model context, so the wake word only fired inside a phrase. This is a
DEDICATED keyword spotter instead, with two interchangeable engines
(select via --engine or FAMILYHUB_WAKE_ENGINE):

  livekit (default): a custom livekit-wakeword ONNX model (james.onnx) trained
    just for "James". Catches isolated "James" and "James <continuation>".
    Runs on onnxruntime (no PyTorch). Threshold via FAMILYHUB_WAKE_THRESHOLD.

  vosk: Vosk ASR constrained to a ["james","[unk]"] grammar + confidence gate.
    Heavier model (~40 MB) but no general-speech false-positive drift. Fallback
    if the livekit model is too trigger-happy in a given room.

Protocol (newline-delimited over stdio):
  stdin  : base64(int16 LINEAR16 @ 16 kHz mono) per line; OR a JSON control line
           such as {"cmd": "reset"} (base64 never starts with "{").
  stdout : one JSON object per line:
             {"type": "partial"|"final", "text": str, "words": []}
The first emitted line is {"type":"partial","text":"","words":[]} as a ready
signal once the model has loaded (the controller treats the first transcript as
"listener ready"). A transcript containing the wake word is emitted only when
one is confidently detected.
"""

import argparse
import base64
import json
import os
import sys
from collections import deque

import numpy as np

SAMPLE_RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WAKE_WORDS = "james"


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def phrase_confirmed(words, phrase_tokens, min_confidence):
    """True iff `phrase_tokens` appear as a contiguous, in-order run within
    Vosk's result `words`, each with conf >= min_confidence.

    `words` is Vosk's result list: [{"word": str, "conf": float, ...}, ...].
    `phrase_tokens` is a lowercased token list, e.g. ["hey", "james"].
    """
    n = len(phrase_tokens)
    if n == 0:
        return False
    spoken = [
        (str(entry.get("word", "")).lower(), float(entry.get("conf", 0.0)))
        for entry in words
    ]
    for i in range(len(spoken) - n + 1):
        window = spoken[i : i + n]
        if all(
            word == token and conf >= min_confidence
            for (word, conf), token in zip(window, phrase_tokens)
        ):
            return True
    return False


class LivekitEngine:
    """livekit-wakeword ONNX classifier over a trailing 2 s window."""

    FRAME = 1280  # 80 ms
    WINDOW_FRAMES = 25  # 2 s trailing window

    def __init__(self, model_path, threshold):
        from livekit.wakeword import WakeWordModel

        self.model = WakeWordModel(models=[model_path])
        self.threshold = threshold
        self.reset()

    def reset(self):
        self._buf = deque(
            [np.zeros(self.FRAME, dtype=np.int16)] * self.WINDOW_FRAMES,
            maxlen=self.WINDOW_FRAMES,
        )
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0

    def feed(self, pcm_bytes):
        chunk = np.frombuffer(pcm_bytes, dtype=np.int16)
        self._leftover = np.concatenate([self._leftover, chunk])
        woke = False
        while len(self._leftover) >= self.FRAME:
            frame = self._leftover[: self.FRAME]
            self._leftover = self._leftover[self.FRAME :]
            self._buf.append(frame)
            if self._cooldown > 0:
                self._cooldown -= 1
                continue
            scores = self.model.predict(np.concatenate(list(self._buf)))
            if scores and max(scores.values()) >= self.threshold:
                woke = True
                self._cooldown = self.WINDOW_FRAMES  # don't re-fire on the same utterance
        return woke


class VoskEngine:
    """Vosk ASR constrained to a wake-word grammar with a confidence gate."""

    def __init__(self, model_path, wake_words, min_confidence):
        from vosk import Model, SetLogLevel

        SetLogLevel(-1)
        self.wake = set(wake_words)
        self.grammar = json.dumps([*wake_words, "[unk]"])
        self.min_conf = min_confidence
        self.model = Model(model_path)
        self.reset()

    def _new(self):
        from vosk import KaldiRecognizer

        rec = KaldiRecognizer(self.model, SAMPLE_RATE, self.grammar)
        rec.SetWords(True)
        return rec

    def reset(self):
        self.rec = self._new()

    def feed(self, pcm_bytes):
        woke = False
        if self.rec.AcceptWaveform(pcm_bytes):
            result = json.loads(self.rec.Result())
            woke = any(
                w.get("word") in self.wake and w.get("conf", 0.0) >= self.min_conf
                for w in result.get("result", [])
            )
        else:
            partial = json.loads(self.rec.PartialResult()).get("partial", "")
            woke = partial.strip().lower() in self.wake
        if woke:
            self.reset()  # so the same utterance doesn't re-fire
        return woke


def build_engine(args, wake_words):
    if args.engine == "vosk":
        model = args.vosk_model or os.path.join(
            HERE, "models", "vosk-model-small-en-us-0.15"
        )
        return VoskEngine(model, wake_words, args.min_confidence), f"vosk:{model}"
    model = args.model or os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "james.onnx")
    )
    return LivekitEngine(model, args.threshold), f"livekit:{model}@{args.threshold}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--engine",
        choices=["livekit", "vosk"],
        default=os.environ.get("FAMILYHUB_WAKE_ENGINE", "livekit"),
    )
    parser.add_argument("--wake-words", default=DEFAULT_WAKE_WORDS)
    parser.add_argument("--model", default=None, help="livekit ONNX classifier path")
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", "0.8")),
    )
    parser.add_argument("--vosk-model", default=None)
    parser.add_argument("--min-confidence", type=float, default=0.7)
    args = parser.parse_args()

    wake_words = [w.strip().lower() for w in args.wake_words.split(",") if w.strip()]
    engine, description = build_engine(args, wake_words)

    emit({"type": "partial", "text": "", "words": []})  # ready signal
    print(f"wake engine: {description}", file=sys.stderr, flush=True)

    wake_text = wake_words[0]

    # readline() (not `for line in sys.stdin`) avoids block read-ahead.
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
                engine.reset()
            continue

        try:
            pcm = base64.b64decode(line)
        except Exception:  # noqa: BLE001 - skip an unparseable frame
            continue
        if not pcm:
            continue

        if engine.feed(pcm):
            emit({"type": "final", "text": wake_text, "words": []})


if __name__ == "__main__":
    main()
