#!/usr/bin/env python3
"""Tests promote_model.sh: the rollback file-move contract AND the bench
non-regression gate (accept / recall-regression / fw-regression / parse-fail).

The gate is exercised WITHOUT a real model or a real bench by pointing the script
at a fake `FAMILYHUB_SIDECAR_PYTHON`: a tiny shell wrapper that returns canned
wake_bench.py JSON (baseline on the first call, candidate after) and forwards
every `-c` evaluation and any other invocation to the REAL venv python. The model
files are throwaway text, so we can assert the swap/backup/revert moves exactly.

Run: sidecar/.venv/bin/python sidecar/test_promote_model.py
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "promote_model.sh")
REAL_PY = os.path.abspath(os.path.join(HERE, ".venv", "bin", "python"))

# Fake interpreter: `-c …` and everything that is not the bench is forwarded to
# the real python; bench calls emit canned JSON (baseline first, candidate next).
WRAPPER = r"""#!/bin/bash
if [ "$1" = "-c" ]; then shift; exec "$REAL_PY" -c "$@"; fi
case "$1" in
  *wake_bench.py)
    n=$(cat "$STUB_COUNTER" 2>/dev/null || echo 0); echo $((n+1)) > "$STUB_COUNTER"
    if [ "$n" -eq 0 ]; then cat "$STUB_BASELINE"; else cat "$STUB_CANDIDATE"; fi ;;
  *) exec "$REAL_PY" "$@" ;;
esac
"""


def _read(path):
    with open(path) as f:
        return f.read()


def _write(path, text):
    with open(path, "w") as f:
        f.write(text)


def _gate_run(baseline_json, candidate_json):
    """Promote a throwaway candidate behind the fake bench. Returns
    (subprocess result, models_dir)."""
    d = tempfile.mkdtemp()
    models = os.path.join(d, "models")
    os.makedirs(models)
    _write(os.path.join(models, "hey_james.onnx"), "ORIGLIVE")
    new = os.path.join(d, "candidate.onnx")
    _write(new, "NEWMODEL")

    wrapper = os.path.join(d, "fakepy.sh")
    _write(wrapper, WRAPPER)
    os.chmod(wrapper, 0o755)

    base_f = os.path.join(d, "baseline.json")
    cand_f = os.path.join(d, "candidate.json")
    _write(base_f, baseline_json)
    _write(cand_f, candidate_json)

    env = dict(
        os.environ,
        FAMILYHUB_WAKE_MODELS_DIR=models,
        FAMILYHUB_SIDECAR_PYTHON=wrapper,
        REAL_PY=REAL_PY,
        STUB_BASELINE=base_f,
        STUB_CANDIDATE=cand_f,
        STUB_COUNTER=os.path.join(d, "counter"),
    )
    r = subprocess.run(["bash", SCRIPT, new], env=env, capture_output=True, text=True)
    return r, models


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
    _write(os.path.join(d, "hey_james.onnx"), "NEW")
    _write(os.path.join(d, "hey_james_v1.onnx"), "OLD")
    r = subprocess.run(["bash", SCRIPT, "--rollback"], env=env, capture_output=True, text=True)
    restored = _read(os.path.join(d, "hey_james.onnx"))
    c = r.returncode == 0 and restored == "OLD"
    print(f"[{'PASS' if c else 'FAIL'}] rollback restores backup (model now '{restored}')")
    ok &= c

    # (a) candidate keeps recall and fw within cap → PROMOTED, backup made, live == new.
    r, models = _gate_run(
        '{"recall":1.0,"false_wakes_per_hour":0.0}',
        '{"recall":1.0,"false_wakes_per_hour":0.0}',
    )
    live = _read(os.path.join(models, "hey_james.onnx"))
    backup = os.path.join(models, "hey_james_v1.onnx")
    c = (
        r.returncode == 0
        and live == "NEWMODEL"
        and os.path.exists(backup)
        and _read(backup) == "ORIGLIVE"
    )
    print(f"[{'PASS' if c else 'FAIL'}] gate accepts non-regression candidate → PROMOTED "
          f"(rc={r.returncode}, live='{live}', backup={'ORIGLIVE' if os.path.exists(backup) and _read(backup)=='ORIGLIVE' else 'MISSING'})")
    ok &= c

    # (b) candidate loses recall → REJECTED exit 2, live reverted to original.
    r, models = _gate_run(
        '{"recall":1.0,"false_wakes_per_hour":0.0}',
        '{"recall":0.5,"false_wakes_per_hour":0.0}',
    )
    live = _read(os.path.join(models, "hey_james.onnx"))
    c = r.returncode == 2 and live == "ORIGLIVE"
    print(f"[{'PASS' if c else 'FAIL'}] gate rejects recall regression → REJECTED + revert "
          f"(rc={r.returncode}, live='{live}')")
    ok &= c

    # (b2) candidate keeps recall but raises fw/h above the cap → REJECTED exit 2, reverted.
    r, models = _gate_run(
        '{"recall":1.0,"false_wakes_per_hour":0.0}',
        '{"recall":1.0,"false_wakes_per_hour":5.0}',
    )
    live = _read(os.path.join(models, "hey_james.onnx"))
    c = r.returncode == 2 and live == "ORIGLIVE"
    print(f"[{'PASS' if c else 'FAIL'}] gate rejects false-wake regression → REJECTED + revert "
          f"(rc={r.returncode}, live='{live}')")
    ok &= c

    # (c) baseline bench emits invalid JSON → exit 3 BEFORE any swap; live untouched.
    r, models = _gate_run('}', '{"recall":1.0,"false_wakes_per_hour":0.0}')
    live = _read(os.path.join(models, "hey_james.onnx"))
    backup = os.path.join(models, "hey_james_v1.onnx")
    c = r.returncode == 3 and live == "ORIGLIVE" and not os.path.exists(backup)
    print(f"[{'PASS' if c else 'FAIL'}] gate parse-fail on baseline → exit 3, no swap/backup "
          f"(rc={r.returncode}, live='{live}')")
    ok &= c

    return ok


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
