#!/usr/bin/env python3
"""Unit tests for the ambient seam in wake_listener.py: handle_control() and
pump_ambient(). No pytest (not installed in the sidecar venv) — standalone
script following the sidecar test pattern (see test_wake_bench.py).

Run with the sidecar venv:
    sidecar/.venv/bin/python test_wake_listener_ambient.py
Exits 0 if all cases pass, 1 otherwise.
"""
import contextlib
import io
import sys

import wake_listener


class FakeAmbient:
    def __init__(self, out=None):
        self.out = out or []
        self.enabled = True
        self.fed = 0
        self.resets = 0

    def feed(self, pcm):
        self.fed += 1
        return list(self.out)

    def set_enabled(self, on):
        self.enabled = on

    def reset(self):
        self.resets += 1


class FakeEngine:
    def __init__(self):
        self.resets = 0

    def reset(self):
        self.resets += 1


def test_handle_ambient_command_toggles():
    ambient = FakeAmbient()
    wake_listener.handle_control({"cmd": "ambient", "on": False}, None, ambient)
    assert ambient.enabled is False
    wake_listener.handle_control({"cmd": "ambient", "on": True}, None, ambient)
    assert ambient.enabled is True


def test_handle_reset_still_resets_engine():
    engine = FakeEngine()
    wake_listener.handle_control({"cmd": "reset"}, engine, None)
    assert engine.resets == 1


def test_handle_reset_also_resets_ambient():
    engine = FakeEngine()
    ambient = FakeAmbient()
    wake_listener.handle_control({"cmd": "reset"}, engine, ambient)
    assert engine.resets == 1
    assert ambient.resets == 1


def test_handle_control_never_raises_with_none_engine_and_ambient():
    # Wake path must survive a reset command even before ambient is wired up.
    wake_listener.handle_control({"cmd": "reset"}, None, None)
    wake_listener.handle_control({"cmd": "ambient", "on": True}, None, None)
    wake_listener.handle_control({"cmd": "unknown"}, None, None)


def test_ambient_utterances_emitted():
    ambient = FakeAmbient(
        out=[{"type": "utterance", "text": "hi", "t0": 1.0, "t1": 2.0, "engine": "fake"}]
    )
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        wake_listener.pump_ambient(ambient, b"\x00\x00")
    out = buf.getvalue()
    assert '"type": "utterance"' in out or '"utterance"' in out
    assert ambient.fed == 1


def test_pump_ambient_noop_when_ambient_none():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        wake_listener.pump_ambient(None, b"\x00\x00")
    assert buf.getvalue() == ""


def run():
    tests = [
        test_handle_ambient_command_toggles,
        test_handle_reset_still_resets_engine,
        test_handle_reset_also_resets_ambient,
        test_handle_control_never_raises_with_none_engine_and_ambient,
        test_ambient_utterances_emitted,
        test_pump_ambient_noop_when_ambient_none,
    ]
    cases_ok = True
    for test in tests:
        try:
            test()
            print(f"[PASS] {test.__name__}")
        except Exception as exc:  # noqa: BLE001 - report, don't crash the run
            print(f"[FAIL] {test.__name__}: {exc}")
            cases_ok = False
    return cases_ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
