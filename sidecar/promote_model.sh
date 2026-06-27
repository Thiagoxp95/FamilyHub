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

# Swap in the new model behind a backup.
[ -f "$LIVE" ] && cp "$LIVE" "$BACKUP"
cp "$NEW" "$LIVE"

echo "== candidate bench (new model) =="
NEW_JSON="$("$PY" "$HERE/wake_bench.py" 2>/dev/null | tail -1)"
NEW_RECALL="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['recall'])" "$NEW_JSON")"
NEW_FWPH="$("$PY" -c "import json,sys; print(json.loads(sys.argv[1])['false_wakes_per_hour'])" "$NEW_JSON")"
BUDGET="${FAMILYHUB_WAKE_FP_BUDGET:-0.5}"

KEEP="$("$PY" -c "print(1 if ($NEW_RECALL >= $BASE_RECALL and $NEW_FWPH <= $BUDGET) else 0)")"
if [ "$KEEP" = "1" ]; then
  echo "PROMOTED: recall $BASE_RECALL -> $NEW_RECALL, fw/h $NEW_FWPH (<= $BUDGET). backup at $BACKUP"
  exit 0
fi
# Revert.
[ -f "$BACKUP" ] && cp "$BACKUP" "$LIVE"
echo "REJECTED: recall $BASE_RECALL -> $NEW_RECALL, fw/h $NEW_FWPH (budget $BUDGET). reverted." >&2
exit 2
