#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
export PYTHONWARNINGS=ignore
echo "=== FULL TRAIN START $(date) ==="
.venv/bin/python -m openwakeword.train --training_config hey_james.yml \
  --generate_clips --augment_clips --train_model
code=$?
echo "=== TRAIN EXIT $code $(date) ==="
ls -la my_custom_model/*.onnx 2>/dev/null
