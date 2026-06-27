#!/usr/bin/env python3
"""Unit tests for phrase_confirmed() — pure, no models loaded.

Run with the sidecar venv:
    sidecar/.venv/bin/python sidecar/test_confirm.py
Exits 0 if all cases pass, 1 otherwise.
"""

import sys

from wake_listener import phrase_confirmed, text_contains_wake_token

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


PHONETIC_CASES = [
    # (label, text, tokens, expected)
    # jaimz: substitution y→i from alias "jaymz" — NOT in WAKE_TOKEN_ALIASES
    ("jaimz accepted (edit1 of jaymz)", "hey jaimz", ["james"], True),
    # jamesz: insertion of z after alias "james" — NOT in WAKE_TOKEN_ALIASES
    ("jamesz accepted (edit1 of james)", "okay jamesz", ["james"], True),
    # existing exact alias — must still work
    ("james exact still ok", "hey james", ["james"], True),
    # denylist guards: these ARE within edit-dist 1 of an alias but must be rejected
    ("games rejected (cames confusable)", "hey games", ["james"], False),
    ("came rejected", "he came home", ["james"], False),
    ("cames rejected", "hey cames", ["james"], False),
    # whole-word boundary: jameson is 7 chars, >1 edit from any 5-6 char alias
    ("jameson rejected (whole-word, not substr)", "jameson whiskey", ["james"], False),
    ("dreams rejected", "tie dreams", ["james"], False),
]


def test_text_match():
    # exact
    assert text_contains_wake_token("hey james", ["james"]) is True
    # alias from gating.ts list
    assert text_contains_wake_token("hey jaymes", ["james"]) is True
    assert text_contains_wake_token("a hames", ["james"]) is True
    # space-dropped glue: Moonshine sometimes fuses a leading filler onto the
    # token ("a james" -> "ajames"). Observed real-wake veto in wake-debug.log.
    assert text_contains_wake_token("ajames", ["james"]) is True
    assert text_contains_wake_token("heyjames", ["james"]) is True
    # whole-word only — substrings of other words must not match
    assert text_contains_wake_token("hey jameson", ["james"]) is False
    assert text_contains_wake_token("what are their names", ["james"]) is False
    # glue recovery must not over-match: a non-filler prefix is still rejected
    assert text_contains_wake_token("pyjames", ["james"]) is False
    # near-misses the model would decode differently
    assert text_contains_wake_token("hey jason", ["james"]) is False
    assert text_contains_wake_token("hey games", ["james"]) is False
    assert text_contains_wake_token("hey cames", ["james"]) is False
    # punctuation / case
    assert text_contains_wake_token("Hey, JAMES!", ["james"]) is True
    # empty
    assert text_contains_wake_token("", ["james"]) is False
    print("text_contains_wake_token: ok")


def main():
    ok = True
    for label, words, phrase, expected in CASES:
        got = phrase_confirmed(words, phrase, MIN_CONF)
        status = "ok" if got == expected else "FAIL"
        if got != expected:
            ok = False
        print(f"  {status:4} {label:34} expected={expected} got={got}")
    print("\nPASS" if ok else "\nFAIL")
    try:
        test_text_match()
    except AssertionError as exc:
        print(f"FAIL test_text_match: {exc}")
        ok = False
    for label, text, tokens, expected in PHONETIC_CASES:
        got = text_contains_wake_token(text, tokens)
        ok_case = got == expected
        print(f"[{'PASS' if ok_case else 'FAIL'}] {label} (got {got})")
        ok &= ok_case
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
