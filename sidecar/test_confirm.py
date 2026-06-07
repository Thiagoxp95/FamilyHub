#!/usr/bin/env python3
"""Unit tests for phrase_confirmed() — pure, no models loaded.

Run with the sidecar venv:
    sidecar/.venv/bin/python sidecar/test_confirm.py
Exits 0 if all cases pass, 1 otherwise.
"""

import sys

from wake_listener import phrase_confirmed

HEY_JAMES = ["hey", "james"]
MIN_CONF = 0.6


def w(word, conf):
    return {"word": word, "conf": conf}


CASES = [
    ("both tokens high conf", [w("hey", 0.98), w("james", 0.95)], HEY_JAMES, True),
    ("james below gate", [w("hey", 0.98), w("james", 0.30)], HEY_JAMES, False),
    ("hey below gate", [w("hey", 0.20), w("james", 0.95)], HEY_JAMES, False),
    ("bare james, no hey", [w("james", 0.99)], HEY_JAMES, False),
    ("wrong order", [w("james", 0.90), w("hey", 0.90)], HEY_JAMES, False),
    (
        "embedded contiguous run",
        [w("um", 0.9), w("hey", 0.9), w("james", 0.9), w("please", 0.9)],
        HEY_JAMES,
        True,
    ),
    ("hey jason not james", [w("hey", 0.95), w("jason", 0.95)], HEY_JAMES, False),
    ("empty result", [], HEY_JAMES, False),
    ("missing conf defaults low", [w("hey", 0.9), {"word": "james"}], HEY_JAMES, False),
    ("single-token phrase 'james'", [w("james", 0.9)], ["james"], True),
    ("empty phrase tokens", [w("hey", 0.9), w("james", 0.9)], [], False),
]


def main():
    ok = True
    for label, words, phrase, expected in CASES:
        got = phrase_confirmed(words, phrase, MIN_CONF)
        status = "ok" if got == expected else "FAIL"
        if got != expected:
            ok = False
        print(f"  {status:4} {label:34} expected={expected} got={got}")
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
