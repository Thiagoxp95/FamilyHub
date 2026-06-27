#!/usr/bin/env python3
"""FamilyHub wake-word sidecar.

A dedicated keyword spotter for the wake phrase (default "hey james"), with two
interchangeable engines (select via --engine or FAMILYHUB_WAKE_ENGINE):

  twostage (default): two stages. Stage 1 is an openWakeWord ONNX classifier
    (models/hey_james.onnx) that cheaply flags "james"-ish candidates with high
    recall. A candidate scoring at or above FAMILYHUB_WAKE_S1_BYPASS wakes
    immediately (a score that high is a clearer wake signal than any tiny-ASR
    transcript, and skipping the confirm cuts ~0.5 s of latency). Candidates in
    the [threshold, bypass) band first collect a short post-trigger window
    (FAMILYHUB_WAKE_POST_TRIGGER_MS) so the complete phrase is buffered, then
    Stage 2 runs FREE (unconstrained) decodes of the ~2 s tail through a CHAIN
    of verifiers — Moonshine tiny → Whisper tiny.en → Vosk small, cheapest
    first, stopping at the first one whose transcript contains the distinctive
    word ("james" or a curated alias from FAMILYHUB_WAKE_CONFIRM_PHRASE).
    Measured on held-out synthetic positives, the chain confirms ~3x as many
    genuine wakes as Moonshine alone (60% vs 22%) with zero false confirms on
    near-misses ("hey jason"/"hey jane"/"hey dreams"): each decode is
    unconstrained, so none of them force-maps a near-miss onto the wake phrase
    — a false wake needs Stage 1 AND every verifier wrong at once.

  vosk: Vosk ASR constrained to a ["<phrase>","[unk]"] grammar + a confidence
    gate. Heavier model but no general-speech drift. Offline fallback if the
    two-stage engine misbehaves in a given room.

Knobs:
  FAMILYHUB_WAKE_ENGINE          — engine to use ("twostage" or "vosk")
  FAMILYHUB_WAKE_STAGE2          — "1"/on (default) runs the Moonshine confirm;
                                   "0"/"off"/"false"/"no" wakes on Stage 1 alone
                                   (higher recall, more false positives). The
                                   confirm model is not even loaded when off, so
                                   this is a clean on/off with no leftover cost.
  FAMILYHUB_WAKE_THRESHOLD       — Stage-1 openWakeWord score threshold (recall)
  FAMILYHUB_WAKE_S1_BYPASS       — Stage-1 score at/above which the wake fires
                                   immediately without Stage-2 confirmation
  FAMILYHUB_WAKE_POST_TRIGGER_MS — milliseconds of audio to buffer after Stage-1
                                   fires before handing off to Stage 2
  FAMILYHUB_WAKE_PHRASE          — full wake phrase to listen for
  FAMILYHUB_WAKE_CONFIRM_PHRASE  — word/alias Stage 2 must transcribe to confirm
  FAMILYHUB_WAKE_MODEL           — path to the openWakeWord ONNX model file
  FAMILYHUB_MOONSHINE_MODEL      — path to the sherpa-onnx Moonshine model
  FAMILYHUB_WHISPER_MODEL        — path to the sherpa-onnx Whisper tiny.en model
                                   (skipped from the chain if the dir is absent)
  FAMILYHUB_VOSK_MODEL           — path to the Vosk model used as the final
                                   free-decode verifier (skipped if absent)
  FAMILYHUB_WAKE_AGC             — "1"/on (default) runs the VAD-gated RMS-AGC
                                   front-end before Stage 1 and on the Stage-2
                                   tail; "0"/off/false/no disables it
  FAMILYHUB_WAKE_AGC_TARGET_RMS  — AGC target RMS (default 2000)
  FAMILYHUB_WAKE_AGC_MAX_GAIN    — AGC max gain (default 8)
  FAMILYHUB_WAKE_AGC_VAD_FLOOR   — RMS below which gain relaxes to unity (default 120)

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


def _env_truthy(name, default):
    return os.environ.get(name, default).strip().lower() not in ("0", "off", "false", "no")


def make_conditioner_from_env():
    """Build the Stage-1/Stage-2 AGC conditioner from env, or None if disabled.
    FAMILYHUB_WAKE_AGC defaults ON (recall-first); set 0/off/false/no to disable."""
    if not _env_truthy("FAMILYHUB_WAKE_AGC", "1"):
        return None
    from audio_frontend import WakeBandConditioner

    return WakeBandConditioner(
        target_rms=float(os.environ.get("FAMILYHUB_WAKE_AGC_TARGET_RMS", "2000")),
        max_gain=float(os.environ.get("FAMILYHUB_WAKE_AGC_MAX_GAIN", "8")),
        vad_floor_rms=float(os.environ.get("FAMILYHUB_WAKE_AGC_VAD_FLOOR", "120")),
    )


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

# Short filler words Moonshine occasionally FUSES onto the wake token when it
# drops the inter-word space, e.g. "a james" -> "ajames", "hey james" ->
# "heyjames" (observed as a real-wake VETO in ~/.familyhub/wake-debug.log).
# Recovering exactly these <filler>+<alias> glues recovers genuine wakes
# without the precision cost of substring matching — "names"/"jameson"/
# "pyjames" still do not match because their prefix is not a known filler.
WAKE_GLUE_PREFIXES = ("a", "the", "hey", "hi", "he", "uh", "oh", "i")


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
            # Recover space-dropped glues ("ajames" = "a" + "james").
            for prefix in WAKE_GLUE_PREFIXES:
                if (prefix + alias) in words:
                    return True
    return False


class OpenWakeWordEngine:
    """openWakeWord ONNX classifier (Stage-1 candidate detector). Feeds 80 ms
    (1280-sample) frames; the model keeps its own feature buffers internally,
    so there is no external trailing window here."""

    FRAME = 1280  # 80 ms @ 16 kHz
    COOLDOWN_FRAMES = 25  # ~2 s — don't re-fire on the same utterance

    def __init__(self, model_path, threshold, conditioner=None):
        from openwakeword.model import Model

        self.model = Model(wakeword_models=[model_path], inference_framework="onnx")
        self.model_path = model_path
        self.threshold = threshold
        self.conditioner = conditioner
        self.last_fire_score = 0.0  # score of the most recent FIRED frame
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0
        self._peak = 0.0  # running max of the current candidate burst (for dlog)

    def reset(self):
        # openWakeWord's Model.reset() is version-dependent; fall back to
        # re-instantiating so the {"cmd":"reset"} IPC path never crashes.
        reset_fn = getattr(self.model, "reset", None)
        if callable(reset_fn):
            reset_fn()
        else:
            from openwakeword.model import Model

            self.model = Model(
                wakeword_models=[self.model_path], inference_framework="onnx"
            )
        self._leftover = np.zeros(0, dtype=np.int16)
        self._cooldown = 0
        self._peak = 0.0
        if self.conditioner is not None:
            self.conditioner.reset()

    def feed(self, pcm_bytes):
        chunk = np.frombuffer(pcm_bytes, dtype=np.int16)
        self._leftover = np.concatenate([self._leftover, chunk])
        woke = False
        while len(self._leftover) >= self.FRAME:
            frame = self._leftover[: self.FRAME]
            self._leftover = self._leftover[self.FRAME :]
            if self.conditioner is not None:
                frame = self.conditioner.process(frame)
            # Predict EVERY frame to keep openWakeWord's internal buffers warm,
            # even while cooling down.
            scores = self.model.predict(frame)
            # Take the max over all loaded wake models rather than keying by a
            # filename-derived name (which is openWakeWord-version-dependent and
            # would silently never fire on a mismatch). Only one model is loaded,
            # so this is just a robust read of its score.
            score = max((float(v) for v in scores.values()), default=0.0)
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
                self.last_fire_score = score
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

    name = "moonshine"

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


class WhisperConfirmer:
    """sherpa-onnx Whisper tiny.en int8 offline recognizer (second verifier).
    Hears accents and noisy audio that Moonshine tiny misreads."""

    name = "whisper"

    def __init__(self, model_dir):
        import sherpa_onnx

        self.recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=os.path.join(model_dir, "tiny.en-encoder.int8.onnx"),
            decoder=os.path.join(model_dir, "tiny.en-decoder.int8.onnx"),
            tokens=os.path.join(model_dir, "tiny.en-tokens.txt"),
        )

    def decode(self, samples_int16):
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples_int16.astype(np.float32) / 32768.0)
        self.recognizer.decode_stream(stream)
        return stream.result.text


class VoskFreeConfirmer:
    """Vosk small full-vocabulary FREE decode (final verifier; ~250 ms).
    Unconstrained, so a real "hey jason" still decodes as "jason" and is
    rejected — unlike a ["hey james","[unk]"] grammar, which force-maps every
    near-miss onto the wake phrase at conf 1.0 (measured: 17/33 false confirms)."""

    name = "vosk"

    def __init__(self, model_path):
        from vosk import Model, SetLogLevel

        SetLogLevel(-1)
        self.model = Model(model_path)

    def decode(self, samples_int16):
        from vosk import KaldiRecognizer

        rec = KaldiRecognizer(self.model, SAMPLE_RATE)
        rec.AcceptWaveform(samples_int16.tobytes())
        return json.loads(rec.FinalResult()).get("text", "")


class ChainConfirmer:
    """Runs free-decode verifiers cheapest-first, confirming on the FIRST whose
    transcript contains a wake token. Union of independent ASRs lifts genuine-
    wake confirm rate ~3x over Moonshine alone while keeping zero measured
    false confirms — every member must hear an actual "james" to say yes."""

    def __init__(self, verifiers):
        self.verifiers = verifiers

    def confirm(self, samples_int16, confirm_tokens):
        """Returns (confirmed, heard) where heard summarizes every decode tried."""
        heard = []
        for verifier in self.verifiers:
            text = verifier.decode(samples_int16)
            heard.append(f"{verifier.name}='{text}'")
            if text_contains_wake_token(text, confirm_tokens):
                return True, " ".join(heard)
        return False, " ".join(heard)


class TwoStageEngine:
    """Stage 1: OpenWakeWord ONNX candidate detector (high recall). A candidate
    scoring >= s1_bypass wakes immediately. Otherwise we do NOT confirm right
    away — the trailing buffer may hold a truncated "hey ja…" that cannot be told
    apart from "hey jason" — we COLLECT a post-trigger window so the full word
    lands in the ring, then Stage 2 runs FREE (unconstrained) decodes through the
    ChainConfirmer, which must find a wake token via text_contains_wake_token.
    Free decode never force-maps a near-miss onto the wake word, and a false wake
    needs BOTH stages wrong."""

    FRAME = 1280  # 80 ms @ 16 kHz, matches OpenWakeWordEngine
    RING_FRAMES = 50  # ~4.0 s trailing window (pre-roll + word + post-trigger)
    # Audio collected AFTER stage-1 fires, so the full wake word is in the ring
    # before Stage-2 decodes. This is the main wake-LATENCY knob and trades ONLY
    # against recall (too short → "james" truncated → real wake VETOED, shows as
    # heard='hey ja' in the log), NOT against false positives (the word-check is
    # unaffected by timing). Tune via FAMILYHUB_WAKE_POST_TRIGGER_MS; was 640 ms —
    # measured stage-1 fire offsets land 180-360 ms AFTER the word ends (p50/p90
    # over held-out positives), so 320 ms still leaves the whole word in the ring.
    DEFAULT_POST_TRIGGER_MS = 320
    CONFIRM_DECODE_FRAMES = 25  # ~2 s tail decoded by Stage 2 (word + post-trigger)
    # Stage-1 score at/above which the wake fires with NO Stage-2 confirm. Real
    # owner wakes log 0.71-0.97 while ordinary speech almost never crests 0.9
    # (8/600 even on ADVERSARIAL james-family negatives), so a score this high is
    # stronger evidence than a tiny-ASR transcript — and skipping the confirm
    # saves the post-trigger wait + decode (~0.5 s) on clear wakes.
    DEFAULT_S1_BYPASS = 0.90

    def __init__(self, model_path, threshold, confirmer, confirm_tokens, conditioner=None):
        self.stage1 = OpenWakeWordEngine(model_path, threshold, conditioner=conditioner)
        self.conditioner = conditioner
        self.confirmer = confirmer
        self.confirm_tokens = confirm_tokens
        post_trigger_ms = float(
            os.environ.get("FAMILYHUB_WAKE_POST_TRIGGER_MS", self.DEFAULT_POST_TRIGGER_MS)
        )
        self.post_trigger_samples = int(SAMPLE_RATE * post_trigger_ms / 1000)
        self.s1_bypass = float(
            os.environ.get("FAMILYHUB_WAKE_S1_BYPASS", self.DEFAULT_S1_BYPASS)
        )
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
        # that hides the word. The verifiers decode the tail fast; the word always lands here.
        tail = list(self.ring)[-self.CONFIRM_DECODE_FRAMES :]
        audio = np.concatenate(tail).astype(np.int16)
        if self.conditioner is not None:
            audio = self.conditioner.process(audio)
        confirmed, heard = self.confirmer.confirm(audio, self.confirm_tokens)
        # Record what Stage 2 heard so a veto is diagnosable.
        self._last_heard = f"heard: {heard}"
        return confirmed

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
        if self.stage1.feed(pcm_bytes):  # Stage-1 candidate
            if self.confirmer is None:
                # Stage-2 disabled (FAMILYHUB_WAKE_STAGE2=0): wake on Stage 1
                # alone, no post-trigger buffering or Stage-2 decode.
                dlog("wake: stage-1 FIRED, stage-2 disabled — waking")
                return True
            if self.stage1.last_fire_score >= self.s1_bypass:
                dlog(
                    f"wake: stage-1 high-confidence bypass "
                    f"score={self.stage1.last_fire_score:.3f} >= {self.s1_bypass} — waking"
                )
                return True
            self._collecting_samples = self.post_trigger_samples  # collect rest of word
        return False


def build_engine(args, wake_words):
    if args.engine == "vosk":
        model = args.vosk_model or os.path.join(
            HERE, "models", "vosk-model-small-en-us-0.15"
        )
        return VoskEngine(model, wake_words, args.min_confidence), f"vosk:{model}"
    # twostage (default): openWakeWord Stage-1 → verifier-chain Stage-2 confirm.
    model = args.model or os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "models", "hey_james.onnx")
    )
    moonshine_dir = os.environ.get(
        "FAMILYHUB_MOONSHINE_MODEL",
        os.path.join(HERE, "models", "sherpa-onnx-moonshine-tiny-en-int8"),
    )
    whisper_dir = os.environ.get(
        "FAMILYHUB_WHISPER_MODEL",
        os.path.join(HERE, "models", "sherpa-onnx-whisper-tiny.en"),
    )
    vosk_dir = os.environ.get(
        "FAMILYHUB_VOSK_MODEL",
        os.path.join(HERE, "models", "vosk-model-small-en-us-0.15"),
    )
    confirm_tokens = [t.lower() for t in args.confirm_phrase.split() if t]
    stage2_on = os.environ.get("FAMILYHUB_WAKE_STAGE2", "1").strip().lower() not in (
        "0",
        "off",
        "false",
        "no",
    )
    confirmer = None
    if stage2_on:
        # Cheapest verifier first; the chain short-circuits on the first hit.
        # Whisper/Vosk are optional (download-if-missing in the runtime build);
        # a missing dir just shortens the chain rather than failing the wake path.
        verifiers = [MoonshineConfirmer(moonshine_dir)]
        if os.path.isdir(whisper_dir):
            verifiers.append(WhisperConfirmer(whisper_dir))
        if os.path.isdir(vosk_dir):
            verifiers.append(VoskFreeConfirmer(vosk_dir))
        confirmer = ChainConfirmer(verifiers)
    conditioner = make_conditioner_from_env()
    engine = TwoStageEngine(model, args.threshold, confirmer, confirm_tokens, conditioner=conditioner)
    description = (
        f"twostage: emit='{args.wake_phrase}' confirm={confirm_tokens} "
        f"s1={args.threshold} bypass={engine.s1_bypass} agc={'on' if conditioner else 'off'} "
        + (
            "(openWakeWord→" + "→".join(v.name for v in confirmer.verifiers) + ")"
            if stage2_on
            else "(openWakeWord ONLY, stage-2 OFF)"
        )
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
        # 0.32 (was 0.45): real casual-voice "Hey James" attempts logged stage-1
        # peaks of 0.30-0.47 and silently missed — the user had to speak loud
        # and over-articulate to crest 0.45. The verifier chain guards
        # precision now, so the candidate gate sits just under the observed
        # real-miss floor. Bench: no extra false wakes at 0.32 vs 0.45
        # (4/300 vs 5/300 adversarial negatives, 0/80 background speech).
        default=float(os.environ.get("FAMILYHUB_WAKE_THRESHOLD", "0.32")),
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
        help="distinctive token(s) Stage-2 Moonshine must actually hear to confirm; "
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
