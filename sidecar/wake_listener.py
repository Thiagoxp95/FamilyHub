#!/usr/bin/env python3
"""FamilyHub wake-word sidecar.

Single-stage keyword spotter for the wake phrase (default "hey james") built on
livekit-wakeword (https://github.com/livekit/livekit-wakeword): a conv-attention
classifier over the frozen Google speech-embedding front-end, trained with the
pipeline in ~/.familyhub/lkww-train (see sidecar/training/README.md). The
conv-attention head models the temporal ordering of phonemes, which is what
separates "james" from the cames/games/jason confusable family — so there is no
second-stage ASR verifier chain anymore. Precision lives in the model + its
training negatives; recall lives in the threshold (bench-tuned, recall-first).

The engine streams INCREMENTALLY: livekit-wakeword's own WakeWordModel.predict
is stateless and recomputes the mel spectrogram plus all 16 embedding windows
for every call (~37 ms per 80 ms hop on an M5 Pro — about a full core on the
M1 Pro appliance). StreamingWakeEngine instead keeps a rolling mel/embedding
state and computes exactly ONE new embedding + ONE classifier pass per 80 ms
hop (~1/10th the cost). Equivalence with the batch path is locked by
test_streaming_engine.py.

Knobs (env, read at startup unless noted):
  FAMILYHUB_WAKE_MODEL       — path to the wake classifier ONNX
                               (default models/hey_james.onnx)
  FAMILYHUB_WAKE_THRESHOLD   — detection threshold; default DEFAULT_THRESHOLD,
                               the trained model's recall-first operating point
                               (see wake_bench.py --tune to re-derive)
  FAMILYHUB_WAKE_MIN_HITS    — consecutive above-threshold hops required to
                               fire (default 1; 2 trades 80 ms latency for
                               single-hop noise-spike immunity)
  FAMILYHUB_WAKE_COOLDOWN_MS — refractory period after a fire (default 2000)
  FAMILYHUB_WAKE_PHRASE      — full wake phrase EMITTED to Electron on a wake
                               (default "hey james"; gating.ts expects it)

Protocol (newline-delimited over stdio, unchanged since the openWakeWord era —
localTranscriber.ts depends on it):
  stdin  : base64(int16 LINEAR16 @ 16 kHz mono) per line, arbitrary chunk
           sizes; OR a JSON control line such as {"cmd": "reset"} or
           {"cmd": "ambient", "on": bool} (base64 never starts with "{").
           {"cmd":"reset"} clears wake-engine state and drops any
           half-collected ambient VAD segment. {"cmd":"ambient"} enables/
           disables the ambient transcriber without touching wake ("on"
           defaults to true if omitted) — Electron sends on:false while a
           Gemini Live session is open and on:true when it closes, so session
           speech is never double-transcribed.
  stdout : one JSON object per line, one of:
             {"type": "partial"|"final", "text": str, "words": []}   (wake path)
             {"type": "utterance", "text": str, "t0": float, "t1": float,
              "engine": str}   (ambient transcription; see ambient_transcriber.py)
The first emitted line is {"type":"partial","text":"","words":[]} as a ready
signal once the wake engine loads — this fires **before** the (optional,
~600 MB) ambient transcriber initializes, so a fresh launch's listener-ready
state never waits on the larger ambient model. A wake emits
{"type":"final","text":"<wake phrase>","words":[]}.
"""

import base64
import datetime
import json
import os
import sys
from collections import deque

import numpy as np

SAMPLE_RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))

# Feature geometry of the frozen openWakeWord/livekit front-end. One classifier
# input = 16 embeddings; one embedding = 76 mel frames; mel frames advance
# 160 samples (10 ms) with a 400-sample (25 ms) window; embeddings stride
# 8 mel frames — exactly one embedding per 1280-sample (80 ms) hop.
FRAME = 1280
MEL_HOP = 160
MEL_WINDOW = 400
EMB_MEL_FRAMES = 76
EMB_STRIDE_FRAMES = 8
N_EMBEDDINGS = 16
# Audio context per hop: enough samples for 81 mel frames; the newest 76 are
# used, discarding the leading frames where the mel model's edge padding
# differs from a mid-stream computation.
MEL_CTX = MEL_WINDOW + MEL_HOP * 80  # 13200 samples (825 ms)

# Recall-first operating point of the shipped hey_james_v2 conv-attention
# model (2026-07-11 acceptance bench): native + pt-BR-accented "hey james"
# recall 100% with >0.4 margin, ordinary speech <= 0.11, eval-optimal was 0.59
# at 0.18 FPPH on adversarial validation. Set BELOW eval-optimal on purpose —
# recall is the product priority and the adversarial validation overstates
# real-room false wakes. Overridden by FAMILYHUB_WAKE_THRESHOLD; re-derive
# with wake_bench.py --tune once an owner corpus exists.
DEFAULT_THRESHOLD = 0.50

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


def handle_control(command, engine, ambient):
    """Dispatch one stdin JSON control command. Never raises."""
    cmd = command.get("cmd")
    if cmd == "reset":
        if engine is not None:
            engine.reset()
        if ambient is not None:
            # A session just ended (Electron resets on finalize): drop any
            # half-collected VAD segment so pre-session audio can't bridge
            # into a post-session utterance.
            ambient.reset()
    elif cmd == "ambient" and ambient is not None:
        ambient.set_enabled(bool(command.get("on", True)))


def pump_ambient(ambient, pcm):
    """Feed one frame to the ambient transcriber and emit its utterances."""
    if ambient is None:
        return
    for utterance in ambient.feed(pcm):
        emit(utterance)


def _env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


class StreamingWakeEngine:
    """Incremental livekit-wakeword detector.

    feed(pcm_bytes) consumes arbitrary-size int16 chunks and returns True when
    the wake phrase is detected. Internally the audio is consumed in 1280-sample
    hops; each hop appends one embedding to a 16-deep window and runs the
    classifier once. Scores, peaks and fires are dlog'd in the same format the
    old engine used, so wake-debug.log diagnostics stay comparable.
    """

    COOLDOWN_MS_DEFAULT = 2000

    def __init__(self, model_path, threshold, min_hits=None, cooldown_ms=None):
        from livekit.wakeword.models.feature_extractor import (
            MelSpectrogramFrontend,
            SpeechEmbedding,
        )
        from livekit.wakeword.resources import (
            get_embedding_model_path,
            get_mel_model_path,
        )

        import onnxruntime as ort

        self._mel = MelSpectrogramFrontend(onnx_path=get_mel_model_path())
        self._emb = SpeechEmbedding(onnx_path=get_embedding_model_path())
        self._clf = ort.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        self._clf_input = self._clf.get_inputs()[0].name
        self.model_path = model_path
        self.threshold = threshold
        self.min_hits = int(
            min_hits
            if min_hits is not None
            else _env_float("FAMILYHUB_WAKE_MIN_HITS", 1)
        )
        cooldown_ms = (
            cooldown_ms
            if cooldown_ms is not None
            else _env_float("FAMILYHUB_WAKE_COOLDOWN_MS", self.COOLDOWN_MS_DEFAULT)
        )
        self.cooldown_hops = max(1, int(cooldown_ms * SAMPLE_RATE / 1000 / FRAME))
        self.last_fire_score = 0.0
        # Bench/diagnostic surface (wake_bench.py duck-type): running peak of
        # the current candidate burst, and a rejected counter that no longer
        # has a stage-2 to increment it (kept so report shapes stay stable).
        self.observed_peak = 0.0
        self.rejected = 0
        self.reset()

    def reset(self):
        self._raw = np.zeros(MEL_CTX, dtype=np.int16)  # rolling audio context
        self._leftover = np.zeros(0, dtype=np.int16)
        self._embeddings = deque(maxlen=N_EMBEDDINGS)
        self._cooldown = 0
        self._hits = 0
        self._peak = 0.0
        self.observed_peak = 0.0

    def _hop_score(self):
        """One 80 ms hop: newest embedding in, one classifier pass out."""
        audio = self._raw.astype(np.float32) / 32768.0
        mel = self._mel(audio)  # (1, ~81, 32)
        frames = mel[0]
        if frames.shape[0] < EMB_MEL_FRAMES:
            return None
        window = frames[-EMB_MEL_FRAMES:]
        emb = self._emb(window[np.newaxis, :, :])[0]  # (96,)
        self._embeddings.append(emb)
        if len(self._embeddings) < N_EMBEDDINGS:
            return None
        seq = np.stack(self._embeddings, axis=0)[np.newaxis, :, :].astype(np.float32)
        out = self._clf.run(None, {self._clf_input: seq})
        return float(out[0][0, 0])

    def feed(self, pcm_bytes):
        chunk = np.frombuffer(pcm_bytes, dtype=np.int16)
        self._leftover = np.concatenate([self._leftover, chunk])
        woke = False
        while len(self._leftover) >= FRAME:
            hop = self._leftover[:FRAME]
            self._leftover = self._leftover[FRAME:]
            self._raw = np.concatenate([self._raw[FRAME:], hop])
            score = self._hop_score()
            if score is None:
                continue
            if self._cooldown > 0:
                self._cooldown -= 1
                continue
            # Track candidate-burst peaks (fired or not) so real-voice recall
            # stays observable in wake-debug.log, same as the old engine.
            if score >= self._peak:
                self._peak = score
                self.observed_peak = max(self.observed_peak, score)
            elif self._peak >= 0.20 and score < self._peak * 0.6:
                dlog(
                    f"wake: candidate peak score={self._peak:.3f} "
                    f"threshold={self.threshold} (no fire)"
                )
                self._peak = 0.0
            if score >= self.threshold:
                self._hits += 1
                if self._hits >= self.min_hits:
                    woke = True
                    self.last_fire_score = score
                    self._cooldown = self.cooldown_hops
                    self._hits = 0
                    self._peak = 0.0
                    dlog(f"wake: FIRED score={score:.3f} threshold={self.threshold}")
            else:
                self._hits = 0
        return woke


def build_engine():
    model = os.environ.get(
        "FAMILYHUB_WAKE_MODEL", os.path.join(HERE, "models", "hey_james.onnx")
    )
    threshold = _env_float("FAMILYHUB_WAKE_THRESHOLD", DEFAULT_THRESHOLD)
    engine = StreamingWakeEngine(model, threshold)
    description = (
        f"livekit-wakeword single-stage: model={os.path.basename(model)} "
        f"threshold={threshold} min_hits={engine.min_hits} "
        f"cooldown_hops={engine.cooldown_hops}"
    )
    return engine, description


def main():
    engine, description = build_engine()
    wake_text = os.environ.get("FAMILYHUB_WAKE_PHRASE", "hey james")

    # Emit the ready signal BEFORE loading the (~600 MB) ambient Parakeet model,
    # so the UI's listener-ready state lands as soon as the wake engine (small,
    # fast) is up, not gated on the much larger ambient load. Wake detection
    # works from this point on even while ambient initializes just below.
    emit({"type": "partial", "text": "", "words": []})  # ready signal
    dlog(f"wake engine: {description}")

    ambient = None
    if os.environ.get("FAMILYHUB_AMBIENT", "1").strip().lower() not in ("0", "off", "false", "no"):
        try:
            from ambient_transcriber import AmbientTranscriber
            ambient = AmbientTranscriber.create()
        except Exception as exc:  # noqa: BLE001 - ambient is optional, wake is not
            dlog(f"ambient disabled: {exc}")
    dlog(f"ambient: {'on' if ambient else 'off'}")

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
            handle_control(command, engine, ambient)
            continue

        try:
            pcm = base64.b64decode(line)
        except Exception:  # noqa: BLE001 - skip an unparseable frame
            continue
        if not pcm:
            continue

        if engine.feed(pcm):
            emit({"type": "final", "text": wake_text, "words": []})
        pump_ambient(ambient, pcm)


if __name__ == "__main__":
    main()
