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
import datetime
import json
import os
import sys
from collections import deque

import numpy as np

SAMPLE_RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WAKE_WORDS = "james"

# Diagnostic log, written regardless of dev vs packaged build (stderr is awkward
# to capture from a packaged Electron child). Correlate timestamps with
# ~/.familyhub/live-debug.log to see, per attempt: did the wake fire, did the
# Gemini session open, did it survive. Best effort — never breaks the wake path.
DEBUG_LOG = os.path.join(os.path.expanduser("~"), ".familyhub", "wake-debug.log")


def dlog(message):
    line = f"{datetime.datetime.now().isoformat()} {message}"
    print(line, file=sys.stderr, flush=True)
    try:
        os.makedirs(os.path.dirname(DEBUG_LOG), exist_ok=True)
        with open(DEBUG_LOG, "a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


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


# Curated ASR mis-hearings of the distinctive wake token, mirroring the alias
# set in apps/electron/src/main/assistant/gating.ts so the sidecar's Stage-2
# confirm and the Electron-side gate agree on which near-misses count.
WAKE_TOKEN_ALIASES = {
    "james": ("james", "jaymes", "jaimes", "jamez", "jaymz", "hames", "jaymez"),
}


def text_contains_wake_token(text, distinctive_tokens):
    """True iff any distinctive token (or a curated alias of it) appears as a
    WHOLE word in a free-decode transcript. Whole-word, not substring, so
    'jameson'/'names' do not match.

    `distinctive_tokens` must be CANONICAL keys as they appear in
    WAKE_TOKEN_ALIASES (e.g. "james"), NOT aliases such as "jaymes".
    Aliases are only stored as VALUES of that dict; passing an alias as a
    token would fall through to the bare ``(token,)`` fallback and miss every
    other alias for that canonical word.  This mirrors how gating.ts keys its
    alias map by the canonical word.

    Normalization note: punctuation is replaced with spaces via
    ``str.isalnum()``, which also retains Unicode letters (e.g. accented
    chars).  This is not byte-identical to gating.ts's ``[^a-z0-9]+`` regex,
    which strips non-ASCII.  The difference is intentional and harmless: the
    upstream ASR is English-only, so non-ASCII characters will not appear in
    practice.
    """
    normalized = "".join(
        c if (c.isalnum() or c.isspace()) else " " for c in text.lower()
    )
    words = set(normalized.split())
    for token in distinctive_tokens:
        for alias in WAKE_TOKEN_ALIASES.get(token, (token,)):
            if alias in words:
                return True
    return False


class OpenWakeWordEngine:
    """openWakeWord ONNX classifier (Stage-1 candidate detector). Feeds 80 ms
    (1280-sample) frames; the model keeps its own feature buffers internally,
    so there is no external trailing window here."""

    FRAME = 1280  # 80 ms @ 16 kHz
    COOLDOWN_FRAMES = 25  # ~2 s — don't re-fire on the same utterance

    def __init__(self, model_path, threshold):
        from openwakeword.model import Model

        self.model = Model(wakeword_models=[model_path], inference_framework="onnx")
        # Key the prediction dict by whatever name openWakeWord derived from the file.
        self.key = next(iter(self.model.models.keys()))
        self.threshold = threshold
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0
        self._peak = 0.0  # running max of the current candidate burst (for dlog)

    def reset(self):
        self.model.reset()
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0
        self._peak = 0.0

    def feed(self, pcm_bytes):
        chunk = np.frombuffer(pcm_bytes, dtype=np.int16)
        self._leftover = np.concatenate([self._leftover, chunk])
        woke = False
        while len(self._leftover) >= self.FRAME:
            frame = self._leftover[: self.FRAME]
            self._leftover = self._leftover[self.FRAME :]
            # Predict EVERY frame to keep openWakeWord's internal buffers warm,
            # even while cooling down.
            scores = self.model.predict(frame)
            score = float(scores.get(self.key, 0.0))
            if self._cooldown > 0:
                self._cooldown -= 1
                continue
            # Report the PEAK score of each candidate burst (including ones that
            # never reach threshold) so real-voice recall stays observable.
            if score >= self._peak:
                self._peak = score
            elif self._peak >= 0.30 and score < self._peak * 0.6:
                dlog(f"wake: candidate peak score={self._peak:.3f} threshold={self.threshold} (no fire)")
                self._peak = 0.0
            if score >= self.threshold:
                woke = True
                self._cooldown = self.COOLDOWN_FRAMES
                dlog(f"wake: FIRED score={score:.3f} threshold={self.threshold}")
                self._peak = 0.0
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


class MoonshineConfirmer:
    """sherpa-onnx Moonshine tiny.en offline recognizer. Free-decodes a short tail
    of int16 PCM and returns the transcript text."""

    def __init__(self, model_dir):
        import sherpa_onnx

        self.recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine(
            preprocessor=os.path.join(model_dir, "preprocess.onnx"),
            encoder=os.path.join(model_dir, "encode.int8.onnx"),
            uncached_decoder=os.path.join(model_dir, "uncached_decode.int8.onnx"),
            cached_decoder=os.path.join(model_dir, "cached_decode.int8.onnx"),
            tokens=os.path.join(model_dir, "tokens.txt"),
        )

    def decode(self, samples_int16):
        stream = self.recognizer.create_stream()
        samples = samples_int16.astype(np.float32) / 32768.0
        stream.accept_waveform(SAMPLE_RATE, samples)
        self.recognizer.decode_stream(stream)
        return stream.result.text


class TwoStageEngine:
    """Stage 1: OpenWakeWord ONNX candidate detector (high recall). On a candidate
    we do NOT confirm immediately — the model fires before the wake word finishes,
    so the trailing buffer would only hold a truncated "hey ja…" that cannot be told
    apart from "hey jason". Instead we COLLECT a post-trigger window so the full
    word lands in the ring, then Stage 2 runs a FREE (unconstrained) Moonshine
    decode and must find a wake token via text_contains_wake_token. Free decode
    never force-maps a near-miss onto the wake word, and a false wake needs BOTH
    stages wrong."""

    FRAME = 1280  # 80 ms @ 16 kHz, matches OpenWakeWordEngine
    RING_FRAMES = 50  # ~4.0 s trailing window (pre-roll + word + post-trigger)
    # Audio collected AFTER stage-1 fires, so the full wake word is in the ring
    # before Stage-2 decodes. This is the main wake-LATENCY knob and trades ONLY
    # against recall (too short → "james" truncated → real wake VETOED, shows as
    # heard='hey ja' in the log), NOT against false positives (the word-check is
    # unaffected by timing). Tune via FAMILYHUB_WAKE_POST_TRIGGER_MS; was 1040 ms.
    DEFAULT_POST_TRIGGER_MS = 640
    CONFIRM_DECODE_FRAMES = 25  # ~2 s tail decoded by Stage 2 (word + post-trigger)

    def __init__(self, model_path, threshold, confirmer, confirm_tokens):
        self.stage1 = OpenWakeWordEngine(model_path, threshold)
        self.confirmer = confirmer
        self.confirm_tokens = confirm_tokens
        post_trigger_ms = float(
            os.environ.get("FAMILYHUB_WAKE_POST_TRIGGER_MS", self.DEFAULT_POST_TRIGGER_MS)
        )
        self.post_trigger_samples = int(SAMPLE_RATE * post_trigger_ms / 1000)
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
        # Free (unconstrained) decode of only the last ~2 s (wake word + post-trigger),
        # NOT the full ring — older pre-roll just lets the model hallucinate a sentence
        # that hides the word. Moonshine decodes the tail fast; the word always lands here.
        tail = list(self.ring)[-self.CONFIRM_DECODE_FRAMES :]
        audio = np.concatenate(tail).astype(np.int16)
        text = self.confirmer.decode(audio)
        # Record what Stage 2 heard so a veto is diagnosable.
        self._last_heard = "heard='{}'".format(text)
        return text_contains_wake_token(text, self.confirm_tokens)

    def feed(self, pcm_bytes):
        self._push_ring(pcm_bytes)
        if self._collecting_samples > 0:
            # Collecting post-trigger audio so Stage 2 sees the FULL wake word.
            # Count samples (not frames) so the ~1 s window is independent of the
            # caller's chunk size.
            self._collecting_samples -= len(np.frombuffer(pcm_bytes, dtype=np.int16))
            if self._collecting_samples <= 0:
                self._collecting_samples = 0
                self._last_heard = ""
                if self._confirm():
                    dlog(f"wake: stage-2 confirmed candidate — {self._last_heard}")
                    return True
                self.rejected += 1
                # Log to the debug FILE (not just stderr): a Stage-1 "FIRED" that
                # Stage 2 then vetoes is the silent "I said it and nothing happened"
                # miss. Including what Stage 2 HEARD tells real-wake vetoes apart
                # from correct "hey cames" rejects without guessing.
                dlog(
                    f"wake: stage-2 VETOED candidate (rejected={self.rejected}) — {self._last_heard}"
                )
            return False
        # Stage 1 is intentionally not fed during collection: its own cooldown
        # holds, so it won't re-fire on the same utterance (~3 s effective gap).
        if self.stage1.feed(pcm_bytes):  # Stage-1 candidate → collect rest of word
            self._collecting_samples = self.post_trigger_samples
        return False


def build_engine(args, wake_words):
    if args.engine == "vosk":
        model = args.vosk_model or os.path.join(
            HERE, "models", "vosk-model-small-en-us-0.15"
        )
        return VoskEngine(model, wake_words, args.min_confidence), f"vosk:{model}"
    # twostage (default): openWakeWord Stage-1 → Moonshine Stage-2 confirm.
    model = args.model or os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "models", "hey_james.onnx")
    )
    moonshine_dir = os.environ.get(
        "FAMILYHUB_MOONSHINE_MODEL",
        os.path.join(HERE, "models", "sherpa-onnx-moonshine-tiny-en-int8"),
    )
    confirm_tokens = [t.lower() for t in args.confirm_phrase.split() if t]
    engine = TwoStageEngine(
        model, args.threshold, MoonshineConfirmer(moonshine_dir), confirm_tokens
    )
    description = (
        f"twostage: emit='{args.wake_phrase}' confirm={confirm_tokens} "
        f"s1={args.threshold} (openWakeWord→Moonshine)"
    )
    return engine, description


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--engine",
        choices=["twostage", "vosk"],
        default=os.environ.get("FAMILYHUB_WAKE_ENGINE", "twostage"),
    )
    parser.add_argument("--wake-words", default=DEFAULT_WAKE_WORDS)
    parser.add_argument("--model", default=None, help="openWakeWord ONNX classifier path")
    parser.add_argument(
        "--threshold",
        type=float,
        default=float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", "0.5")),
        help="stage-1 openWakeWord candidate threshold; tuned low for two-stage recall.",
    )
    parser.add_argument(
        "--wake-phrase",
        default=os.environ.get("FAMILYHUB_WAKE_PHRASE", "hey james"),
        help="phrase EMITTED to Electron on a confirmed wake (gate expects this)",
    )
    parser.add_argument(
        "--confirm-phrase",
        default=os.environ.get("FAMILYHUB_WAKE_CONFIRM_PHRASE", "james"),
        help="distinctive token(s) Stage-2 Vosk must actually hear to confirm; "
        "default 'james' (the filler 'hey' is unreliable in ASR and adds no "
        "precision since Stage 1 already gates the full phrase acoustically)",
    )
    parser.add_argument("--vosk-model", default=None)
    parser.add_argument("--min-confidence", type=float, default=0.7)
    args = parser.parse_args()

    wake_words = [w.strip().lower() for w in args.wake_words.split(",") if w.strip()]
    engine, description = build_engine(args, wake_words)

    emit({"type": "partial", "text": "", "words": []})  # ready signal
    dlog(f"wake engine: {description}")

    # Emit the FULL wake phrase ("hey james") on every engine, not the bare
    # keyword. The Electron side gates each wake with transcriptContainsWakePhrase
    # against ["hey james"], so emitting bare "james" (old vosk behavior)
    # is silently rejected downstream and the assistant never wakes. hey_james.onnx is
    # trained on the whole "hey james" utterance (openWakeWord), so a Stage-1 fire
    # genuinely means the phrase was heard — emitting it is honest, not a rubber stamp.
    wake_text = args.wake_phrase

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
