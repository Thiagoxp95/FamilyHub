"""Ambient always-on transcription for the FamilyHub sidecar.

Silero VAD (sherpa-onnx VoiceActivityDetector) segments speech out of the
shared 16 kHz mic stream; each finished segment is decoded offline by a
sherpa-onnx recognizer — Parakeet-TDT v3 int8 (models/<parakeet dir>) when
present, else the Moonshine tiny model the wake verifier already ships.

This module NEVER raises out of feed(): any decode error drops that segment
and logs. Ambient failure must not disturb the wake path.
"""

import os
import sys
import time

import numpy as np

SAMPLE_RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))

PARAKEET_DIR = os.environ.get(
    "FAMILYHUB_AMBIENT_ASR",
    os.path.join(HERE, "models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"),
)
MOONSHINE_DIR = os.environ.get(
    "FAMILYHUB_MOONSHINE_MODEL",
    os.path.join(HERE, "models", "sherpa-onnx-moonshine-tiny-en-int8"),
)
SILERO_VAD = os.path.join(HERE, "models", "silero_vad.onnx")


def _dlog(message):
    print(f"[ambient] {message}", file=sys.stderr, flush=True)


class _SherpaRecognizer:
    """Adapts a sherpa_onnx.OfflineRecognizer to `decode(samples, rate) -> str`."""

    def __init__(self, recognizer):
        self._recognizer = recognizer

    def decode(self, samples, sample_rate):
        stream = self._recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)
        self._recognizer.decode_stream(stream)
        return stream.result.text


class AmbientTranscriber:
    def __init__(self, vad, recognizer, sample_rate=SAMPLE_RATE, engine_name="unknown"):
        self._vad = vad
        self._recognizer = recognizer
        self._sample_rate = sample_rate
        self._engine_name = engine_name
        self._enabled = True

    def set_enabled(self, on):
        on = bool(on)
        if self._enabled and not on:
            # Drop any half-collected segment so stale audio can't surface later.
            try:
                self._vad.reset()
            except Exception:  # noqa: BLE001
                pass
        self._enabled = on

    def reset(self):
        try:
            self._vad.reset()
        except Exception:  # noqa: BLE001
            pass

    def feed(self, pcm_bytes):
        if not self._enabled or not pcm_bytes:
            return []

        utterances = []
        try:
            # Inside the try: an odd-byte frame raises ValueError from
            # np.frombuffer and must be logged + dropped like a decode failure
            # — feed() never raises.
            samples = (
                np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            )
            self._vad.accept_waveform(samples)
            while not self._vad.empty():
                segment = self._vad.front
                # Read .samples BEFORE pop(): sherpa-onnx's VAD ring buffer
                # invalidates the segment's backing storage once popped, so
                # reading after pop() silently yields an empty array. Also
                # normalize to a numpy float32 array — sherpa-onnx returns a
                # plain Python list, not an ndarray.
                seg_samples = np.asarray(segment.samples, dtype=np.float32)
                self._vad.pop()
                duration = len(seg_samples) / float(self._sample_rate)
                now = time.time()
                text = self._recognizer.decode(seg_samples, self._sample_rate)
                text = (text or "").strip()
                if text:
                    utterances.append(
                        {
                            "type": "utterance",
                            "text": text,
                            "t0": now - duration,
                            "t1": now,
                            "engine": self._engine_name,
                        }
                    )
        except Exception as exc:  # noqa: BLE001 - ambient must never break the wake path
            _dlog(f"feed error (segment dropped): {exc}")

        return utterances

    @staticmethod
    def create():
        """Load real models. Returns None (with a log line) if anything is missing."""
        try:
            import sherpa_onnx
        except ImportError as exc:
            _dlog(f"sherpa_onnx unavailable: {exc}")
            return None

        if not os.path.isfile(SILERO_VAD):
            _dlog(f"silero vad model missing: {SILERO_VAD}")
            return None

        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = SILERO_VAD
        vad_config.silero_vad.threshold = 0.5
        vad_config.silero_vad.min_silence_duration = 0.3
        vad_config.silero_vad.min_speech_duration = 0.4
        # Cap a single segment; long monologues split at 15 s.
        vad_config.silero_vad.max_speech_duration = 15.0
        vad_config.sample_rate = SAMPLE_RATE
        vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=30)

        def parakeet_paths():
            enc = os.path.join(PARAKEET_DIR, "encoder.int8.onnx")
            dec = os.path.join(PARAKEET_DIR, "decoder.int8.onnx")
            joi = os.path.join(PARAKEET_DIR, "joiner.int8.onnx")
            tok = os.path.join(PARAKEET_DIR, "tokens.txt")
            if all(os.path.isfile(p) for p in (enc, dec, joi, tok)):
                return enc, dec, joi, tok
            return None

        engine_name = None
        recognizer = None
        paths = parakeet_paths()
        if paths:
            enc, dec, joi, tok = paths
            recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=enc,
                decoder=dec,
                joiner=joi,
                tokens=tok,
                model_type="nemo_transducer",
                num_threads=2,
            )
            engine_name = "parakeet-tdt-0.6b-v3-int8"
        elif os.path.isdir(MOONSHINE_DIR):
            recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine(
                preprocessor=os.path.join(MOONSHINE_DIR, "preprocess.onnx"),
                encoder=os.path.join(MOONSHINE_DIR, "encode.int8.onnx"),
                uncached_decoder=os.path.join(MOONSHINE_DIR, "uncached_decode.int8.onnx"),
                cached_decoder=os.path.join(MOONSHINE_DIR, "cached_decode.int8.onnx"),
                tokens=os.path.join(MOONSHINE_DIR, "tokens.txt"),
                num_threads=2,
            )
            engine_name = "moonshine-tiny"
        else:
            _dlog("no ambient ASR model found (parakeet or moonshine)")
            return None

        _dlog(f"ambient transcriber ready: {engine_name}")
        return AmbientTranscriber(vad, _SherpaRecognizer(recognizer), SAMPLE_RATE, engine_name)
