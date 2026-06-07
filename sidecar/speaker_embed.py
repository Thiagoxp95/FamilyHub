#!/usr/bin/env python3
"""Shared titanet speaker-embedding helpers + a one-shot voiceprint computer.

CLI: python speaker_embed.py <clips_dir>
  reads clip_*.wav, prints the mean L2-normalized voiceprint as a JSON float
  array on stdout. Exit non-zero on error.
"""
import glob
import json
import os
import sys
import wave

import numpy as np

SAMPLE_RATE = 16000
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_EMBEDDER = os.path.join(HERE, "models", "nemo_en_titanet_small.onnx")


def average_normalize(vectors):
    """Mean of the given vectors, re-normalized to unit length (pure)."""
    stacked = np.stack([np.asarray(v, dtype=np.float32) for v in vectors])
    mean = stacked.mean(axis=0)
    norm = float(np.linalg.norm(mean))
    return (mean / norm) if norm > 0 else mean


def load_extractor(model_path=DEFAULT_EMBEDDER):
    import sherpa_onnx as so

    return so.SpeakerEmbeddingExtractor(
        so.SpeakerEmbeddingExtractorConfig(
            model=model_path, num_threads=1, provider="cpu"
        )
    )


def embed(extractor, samples):
    """L2-normalized titanet embedding of float32 mono @16k samples."""
    stream = extractor.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    stream.input_finished()
    vec = np.array(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 0 else vec


def _read_wav(path):
    with wave.open(path, "rb") as w:
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def mean_voiceprint(extractor, clip_paths):
    vectors = [embed(extractor, _read_wav(p)) for p in clip_paths]
    return average_normalize(vectors)


def main():
    clips_dir = sys.argv[1]
    paths = sorted(glob.glob(os.path.join(clips_dir, "clip_*.wav")))
    if not paths:
        print(f"no clips in {clips_dir}", file=sys.stderr)
        return 1
    extractor = load_extractor()
    vec = mean_voiceprint(extractor, paths)
    sys.stdout.write(json.dumps([float(x) for x in vec]))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
