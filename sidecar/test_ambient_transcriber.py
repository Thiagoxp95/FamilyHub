#!/usr/bin/env python3
"""Unit tests for ambient_transcriber (fakes only — no models loaded).

Sidecar tests are standalone scripts (pytest is not installed). Run with the
sidecar venv:
    cd sidecar && /Users/tedyeng1/Pessoal/FamilyHub/sidecar/.venv/bin/python test_ambient_transcriber.py
Exits 0 if all cases pass, 1 otherwise.
"""
import sys

import numpy as np

from ambient_transcriber import AmbientTranscriber


class FakeSegment:
    def __init__(self, samples):
        self.samples = samples  # float32 numpy array


class FakeVad:
    """Mimics the sherpa-onnx VoiceActivityDetector surface we use."""

    def __init__(self):
        self.fed = []
        self.segments = []  # queue of FakeSegment
        self.cleared = 0

    def accept_waveform(self, samples):
        self.fed.append(samples)

    def empty(self):
        return len(self.segments) == 0

    @property
    def front(self):
        return self.segments[0]

    def pop(self):
        self.segments.pop(0)

    def reset(self):
        self.cleared += 1


class FakeRecognizer:
    def __init__(self, text="hello world"):
        self.text = text
        self.decoded = 0

    def decode(self, samples, sample_rate):
        self.decoded += 1
        return self.text


def pcm(n_samples, value=1000):
    return (np.ones(n_samples, dtype=np.int16) * value).tobytes()


def test_feed_without_segments_returns_empty():
    vad, rec = FakeVad(), FakeRecognizer()
    at = AmbientTranscriber(vad, rec)
    assert at.feed(pcm(1600)) == []
    assert len(vad.fed) == 1


def test_feed_drains_segments_into_utterances():
    vad, rec = FakeVad(), FakeRecognizer("don't forget the party")
    at = AmbientTranscriber(vad, rec, engine_name="fake")
    vad.segments.append(FakeSegment(np.zeros(16000, dtype=np.float32)))
    out = at.feed(pcm(1600))
    assert len(out) == 1
    utt = out[0]
    assert utt["type"] == "utterance"
    assert utt["text"] == "don't forget the party"
    assert utt["engine"] == "fake"
    assert utt["t1"] >= utt["t0"] > 0
    assert vad.empty()


def test_empty_transcripts_are_dropped():
    vad, rec = FakeVad(), FakeRecognizer("   ")
    at = AmbientTranscriber(vad, rec)
    vad.segments.append(FakeSegment(np.zeros(1600, dtype=np.float32)))
    assert at.feed(pcm(160)) == []


def test_disabled_drops_audio_and_resets():
    vad, rec = FakeVad(), FakeRecognizer()
    at = AmbientTranscriber(vad, rec)
    at.set_enabled(False)
    assert at.feed(pcm(1600)) == []
    assert vad.fed == []  # nothing fed while off
    assert vad.cleared >= 1  # segment state cleared on disable
    at.set_enabled(True)
    at.feed(pcm(1600))
    assert len(vad.fed) == 1


def test_odd_length_pcm_is_dropped_not_raised():
    # feed() must never raise: an odd-byte frame can't be int16-decoded and
    # must be logged + dropped, like a decode failure.
    vad, rec = FakeVad(), FakeRecognizer()
    at = AmbientTranscriber(vad, rec)
    assert at.feed(b"\x00\x00\x00") == []
    assert vad.fed == []  # malformed frame never reaches the VAD
    # A well-formed frame afterwards still works.
    assert at.feed(pcm(1600)) == []
    assert len(vad.fed) == 1


CASES = [
    test_feed_without_segments_returns_empty,
    test_feed_drains_segments_into_utterances,
    test_empty_transcripts_are_dropped,
    test_disabled_drops_audio_and_resets,
    test_odd_length_pcm_is_dropped_not_raised,
]


def run():
    ok = True
    for case in CASES:
        try:
            case()
            print(f"[PASS] {case.__name__}")
        except Exception as exc:  # noqa: BLE001 - report and keep going
            ok = False
            print(f"[FAIL] {case.__name__}: {exc}")
    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
