#!/usr/bin/env python3
"""FamilyHub wake-word sidecar.

A dedicated keyword spotter for the wake phrase (default "hey james"), with three
interchangeable engines (select via --engine or FAMILYHUB_WAKE_ENGINE):

  twostage (default): two stages. Stage 1 is a custom livekit-wakeword ONNX model
    (james.onnx) that cheaply flags "james"-ish candidates with high recall.
    Because james.onnx fires before the word finishes, Stage 2 first collects a
    short post-trigger window (so the FULL phrase is buffered) and then runs a
    FREE (unconstrained) Vosk decode, confirming only if it actually hears
    "hey james". Free decode never force-maps a near-miss ("hey jason") onto the
    wake word, so a false wake needs both stages wrong at once.

  livekit: Stage 1 alone — the james.onnx classifier over a trailing window.
    Trigger-happy on its own; useful for debugging Stage 1 in isolation.

  vosk: Vosk ASR constrained to a ["<phrase>","[unk]"] grammar + a confidence
    gate. Heavier model but no general-speech drift. Standalone fallback if the
    two-stage engine misbehaves in a given room.

Knobs: FAMILYHUB_WAKE_THRESHOLD (stage-1 recall),
FAMILYHUB_WAKE_CONFIRM_CONFIDENCE (stage-2 gate), FAMILYHUB_WAKE_PHRASE.

Protocol (newline-delimited over stdio):
  stdin  : base64(int16 LINEAR16 @ 16 kHz mono) per line; OR a JSON control line
           such as {"cmd": "reset"} (base64 never starts with "{").
  stdout : one JSON object per line:
             {"type": "partial"|"final", "text": str, "words": []}
The first emitted line is {"type":"partial","text":"","words":[]} as a ready
signal once the model has loaded. A transcript containing the wake phrase is
emitted only when one is confidently detected.
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


class TwoStageEngine:
    """Stage 1: livekit james.onnx candidate (high recall). On a candidate we do
    NOT confirm immediately — james.onnx fires before the wake word finishes, so
    the trailing buffer would only hold a truncated "hey ja…" that cannot be told
    apart from "hey jason". Instead we COLLECT a post-trigger window so the full
    word lands in the ring, then Stage 2 runs a FREE (unconstrained) Vosk decode
    and must find the phrase via phrase_confirmed. Free decode never force-maps a
    near-miss onto the wake word, and a false wake needs BOTH stages wrong."""

    FRAME = 1280  # 80 ms @ 16 kHz, matches LivekitEngine
    RING_FRAMES = 50  # ~4.0 s trailing window (pre-roll + word + post-trigger)
    POST_TRIGGER_FRAMES = 13  # ~1.04 s collected AFTER stage-1 fires, so the full
    # wake word is in the ring before Stage-2 decodes (fixes both the truncation
    # false-wakes and the "fired during 'hey'" misses).

    def __init__(self, model_path, threshold, vosk_model_path, phrase, min_confidence):
        from vosk import Model, SetLogLevel

        SetLogLevel(-1)
        self.stage1 = LivekitEngine(model_path, threshold)
        self.vosk_model = Model(vosk_model_path)
        self.phrase_tokens = [t.lower() for t in phrase.split() if t]
        self.min_conf = min_confidence
        self.rejected = 0
        self.reset()

    def reset(self):
        self.stage1.reset()
        self.ring = deque(
            [np.zeros(self.FRAME, dtype=np.int16)] * self.RING_FRAMES,
            maxlen=self.RING_FRAMES,
        )
        self._leftover = np.zeros(0, dtype=np.int16)
        self._collecting_samples = 0  # post-trigger samples to buffer before Stage 2

    def _push_ring(self, pcm_bytes):
        chunk = np.frombuffer(pcm_bytes, dtype=np.int16)
        self._leftover = np.concatenate([self._leftover, chunk])
        pushed = 0
        while len(self._leftover) >= self.FRAME:
            self.ring.append(self._leftover[: self.FRAME])
            self._leftover = self._leftover[self.FRAME :]
            pushed += 1
        return pushed

    def _confirm(self):
        # Free (unconstrained) decode: the model is free to emit "jason" instead
        # of being forced into "james" by a restricted grammar, and confidences
        # are real (not grammar-forced 1.0), so the phrase_confirmed gate is
        # meaningful. Fresh recognizer per candidate: stateless one-shot decode.
        from vosk import KaldiRecognizer

        rec = KaldiRecognizer(self.vosk_model, SAMPLE_RATE)
        rec.SetWords(True)
        audio = np.concatenate(list(self.ring)).astype(np.int16).tobytes()
        rec.AcceptWaveform(audio)
        result = json.loads(rec.FinalResult())
        return phrase_confirmed(result.get("result", []), self.phrase_tokens, self.min_conf)

    def feed(self, pcm_bytes):
        self._push_ring(pcm_bytes)
        if self._collecting_samples > 0:
            # Collecting post-trigger audio so Stage 2 sees the FULL wake word.
            # Count samples (not frames) so the ~1 s window is independent of the
            # caller's chunk size.
            self._collecting_samples -= len(np.frombuffer(pcm_bytes, dtype=np.int16))
            if self._collecting_samples <= 0:
                self._collecting_samples = 0
                if self._confirm():
                    return True
                self.rejected += 1
                print(
                    f"wake: stage-2 vetoed candidate (rejected={self.rejected})",
                    file=sys.stderr,
                    flush=True,
                )
            return False
        # Stage 1 is intentionally not fed during collection: its own cooldown
        # holds, so it won't re-fire on the same utterance (~3 s effective gap).
        if self.stage1.feed(pcm_bytes):  # Stage-1 candidate → collect rest of word
            self._collecting_samples = self.POST_TRIGGER_FRAMES * self.FRAME
        return False


def build_engine(args, wake_words):
    if args.engine == "vosk":
        model = args.vosk_model or os.path.join(
            HERE, "models", "vosk-model-small-en-us-0.15"
        )
        return VoskEngine(model, wake_words, args.min_confidence), f"vosk:{model}"
    if args.engine == "livekit":
        model = args.model or os.environ.get(
            "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "james.onnx")
        )
        return (
            LivekitEngine(model, args.threshold),
            f"livekit:{model}@{args.threshold}",
        )
    # twostage (default)
    model = args.model or os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "james.onnx")
    )
    vosk_model = args.vosk_model or os.environ.get(
        "FAMILYHUB_VOSK_MODEL",
        os.path.join(HERE, "models", "vosk-model-small-en-us-0.15"),
    )
    engine = TwoStageEngine(
        model, args.threshold, vosk_model, args.wake_phrase, args.confirm_confidence
    )
    description = (
        f"twostage:'{args.wake_phrase}' s1={args.threshold} "
        f"s2={args.confirm_confidence}"
    )
    return engine, description


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--engine",
        choices=["twostage", "livekit", "vosk"],
        default=os.environ.get("FAMILYHUB_WAKE_ENGINE", "twostage"),
    )
    parser.add_argument("--wake-words", default=DEFAULT_WAKE_WORDS)
    parser.add_argument("--model", default=None, help="livekit ONNX classifier path")
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", "0.5")),
        help="stage-1 candidate threshold; tuned low for two-stage recall. "
        "Pass higher (e.g. 0.8) for a standalone --engine livekit.",
    )
    parser.add_argument(
        "--wake-phrase",
        default=os.environ.get("FAMILYHUB_WAKE_PHRASE", "hey james"),
        help="two-stage Stage-2 confirmation phrase",
    )
    parser.add_argument(
        "--confirm-confidence",
        type=float,
        default=float(os.environ.get("FAMILYHUB_WAKE_CONFIRM_CONFIDENCE", "0.6")),
    )
    parser.add_argument("--vosk-model", default=None)
    parser.add_argument("--min-confidence", type=float, default=0.7)
    args = parser.parse_args()

    wake_words = [w.strip().lower() for w in args.wake_words.split(",") if w.strip()]
    engine, description = build_engine(args, wake_words)

    emit({"type": "partial", "text": "", "words": []})  # ready signal
    print(f"wake engine: {description}", file=sys.stderr, flush=True)

    wake_text = args.wake_phrase if args.engine == "twostage" else wake_words[0]

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
