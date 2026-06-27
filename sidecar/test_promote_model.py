#!/usr/bin/env python3
"""Tests promote_model.sh backup + rollback file moves using throwaway files
(no real model, no bench). Verifies the rollback contract.

Run: sidecar/.venv/bin/python sidecar/test_promote_model.py
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "promote_model.sh")


def run():
    ok = True
    # --rollback with no backup present must fail loudly (exit != 0), not silently succeed.
    env = dict(os.environ, FAMILYHUB_WAKE_MODELS_DIR=tempfile.mkdtemp())
    r = subprocess.run(["bash", SCRIPT, "--rollback"], env=env, capture_output=True, text=True)
    c = r.returncode != 0
    print(f"[{'PASS' if c else 'FAIL'}] rollback with no backup fails loudly (rc={r.returncode})")
    ok &= c

    # rollback restores a present backup over the live model.
    d = tempfile.mkdtemp()
    env = dict(os.environ, FAMILYHUB_WAKE_MODELS_DIR=d)
    with open(os.path.join(d, "hey_james.onnx"), "w") as f:
        f.write("NEW")
    with open(os.path.join(d, "hey_james_v1.onnx"), "w") as f:
        f.write("OLD")
    r = subprocess.run(["bash", SCRIPT, "--rollback"], env=env, capture_output=True, text=True)
    restored = open(os.path.join(d, "hey_james.onnx")).read()
    c = r.returncode == 0 and restored == "OLD"
    print(f"[{'PASS' if c else 'FAIL'}] rollback restores backup (model now '{restored}')")
    ok &= c

    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
