#!/usr/bin/env python3
"""Pure tests for speaker-lock math. Run: sidecar/.venv/bin/python sidecar/test_speakerlock.py"""
import sys
import numpy as np
from speaker_embed import average_normalize

def almost(a, b):
    return float(np.linalg.norm(np.asarray(a) - np.asarray(b))) < 1e-5

CASES_OK = []

def check(name, cond):
    CASES_OK.append((name, cond))
    print(f"  {'ok' if cond else 'FAIL'}  {name}")

# average of two identical unit vectors is the same unit vector
v = np.array([0.6, 0.8], dtype=np.float32)
check("identical -> same unit vector", almost(average_normalize([v, v]), v))
# result is always unit-norm
out = average_normalize([np.array([1.0, 0.0]), np.array([0.0, 1.0])])
check("output is unit norm", abs(float(np.linalg.norm(out)) - 1.0) < 1e-5)
check("output is the 45-degree unit vector", almost(out, [0.70710678, 0.70710678]))

from speaker_gate import decide  # noqa: E402

u = lambda *xs: np.array(xs, dtype=np.float32)  # noqa: E731
A = u(1.0, 0.0)
B = u(0.0, 1.0)
NEARA = u(0.96, 0.28)  # cosine ~0.96 with A

check("locked + match -> forward", decide([], A, NEARA, 0.6)[0] == "forward")
check("locked + mismatch -> drop", decide([], A, B, 0.6)[0] == "drop")
check("no refs -> open-mic lock", decide([], None, B, 0.6)[0] == "lock")
check("family match -> lock to id", decide([("mom", A)], None, NEARA, 0.6) == ("lock", "mom"))
check("no family match -> rejected", decide([("mom", A)], None, B, 0.6)[0] == "rejected")

if __name__ == "__main__":
    ok = all(c for _, c in CASES_OK)
    print("\nPASS" if ok else "\nFAIL")
    sys.exit(0 if ok else 1)
