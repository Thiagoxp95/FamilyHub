#!/usr/bin/env bash
# Promote a freshly trained hey_james.onnx behind a bench non-regression gate,
# with one-command rollback. Never overwrites the live model without a backup.
#
#   sidecar/promote_model.sh path/to/new/hey_james.onnx   # gated promote
#   sidecar/promote_model.sh --rollback                    # restore previous
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MODELS="${FAMILYHUB_WAKE_MODELS_DIR:-$HERE/models}"
LIVE="$MODELS/hey_james.onnx"
BACKUP="$MODELS/hey_james_v1.onnx"
PY="${FAMILYHUB_SIDECAR_PYTHON:-$HERE/.venv/bin/python}"

if [ "${1:-}" = "--rollback" ]; then
  if [ ! -f "$BACKUP" ]; then
    echo "no backup at $BACKUP — cannot roll back" >&2
    exit 1
  fi
  cp "$BACKUP" "$LIVE"
  echo "rolled back: restored $BACKUP -> $LIVE"
  exit 0
fi

NEW="${1:?usage: promote_model.sh NEW_ONNX | --rollback}"
if [ ! -f "$NEW" ]; then echo "no such file: $NEW" >&2; exit 1; fi

# Baseline bench on the CURRENT model first.
echo "== baseline bench (current model) =="
BASE_JSON="$("$PY" "$HERE/wake_bench.py" 2>/dev/null | tail -1)"
BASE_RECALL="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['recall'])" "$BASE_JSON")"
BASE_FWPH="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['false_wakes_per_hour'])" "$BASE_JSON")"
if [ -z "$BASE_RECALL" ] || [ -z "$BASE_FWPH" ]; then echo "bench parse failed (baseline) — refusing to promote" >&2; exit 3; fi

# Swap in the new model behind a backup. Fail loudly if the install copy fails
# (never report PROMOTED on a model that was never actually written live).
[ -f "$LIVE" ] && cp "$LIVE" "$BACKUP"
if [ "$NEW" -ef "$LIVE" ]; then
  # Candidate IS the live file (e.g. a no-op re-bench): nothing to install, and
  # cp would error "are identical". The gate still runs on the same model.
  :
elif ! cp "$NEW" "$LIVE"; then
  echo "install failed: could not copy $NEW -> $LIVE" >&2
  exit 4
fi

echo "== candidate bench (new model) =="
NEW_JSON="$("$PY" "$HERE/wake_bench.py" 2>/dev/null | tail -1)"
NEW_RECALL="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['recall'])" "$NEW_JSON")"
NEW_FWPH="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['false_wakes_per_hour'])" "$NEW_JSON")"
BUDGET="${FAMILYHUB_WAKE_FP_BUDGET:-0.5}"
if [ -z "$NEW_RECALL" ] || [ -z "$NEW_FWPH" ]; then
  echo "bench parse failed (candidate) — reverting" >&2
  if [ -f "$BACKUP" ]; then cp "$BACKUP" "$LIVE"; else echo "WARN: no backup to revert to; candidate left live" >&2; fi
  exit 3
fi

# Non-regression gate: accept iff the candidate does not LOSE recall and does not
# RAISE false-wakes/hour above the looser of the fixed budget and the baseline's
# own fw/h (so a model that matches an already-clean baseline is not blocked by a
# budget the baseline itself happens to satisfy with margin).
CAP="$("$PY" -c "print(max($BUDGET, $BASE_FWPH))")"
KEEP="$("$PY" -c "print(1 if ($NEW_RECALL >= $BASE_RECALL and $NEW_FWPH <= max($BUDGET, $BASE_FWPH)) else 0)")"
D_RECALL="$("$PY" -c "print(f'{($NEW_RECALL)-($BASE_RECALL):+.3f}')")"
D_FWPH="$("$PY" -c "print(f'{($NEW_FWPH)-($BASE_FWPH):+.3f}')")"
if [ "$KEEP" = "1" ]; then
  echo "PROMOTED: recall $BASE_RECALL -> $NEW_RECALL ($D_RECALL), fw/h $BASE_FWPH -> $NEW_FWPH ($D_FWPH, cap $CAP). backup at $BACKUP"
  exit 0
fi
# Revert.
if [ -f "$BACKUP" ]; then cp "$BACKUP" "$LIVE"; else echo "WARN: no backup to revert to; rejected model left live" >&2; fi
echo "REJECTED: recall $BASE_RECALL -> $NEW_RECALL ($D_RECALL), fw/h $BASE_FWPH -> $NEW_FWPH ($D_FWPH, cap $CAP). reverted." >&2
exit 2
