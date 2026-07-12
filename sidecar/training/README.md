# Training the "Hey James" wake model (livekit-wakeword)

The sidecar's wake detector is a single-stage
[livekit-wakeword](https://github.com/livekit/livekit-wakeword) conv-attention
classifier. This directory holds the reproducible recipe; the actual training
workspace (venv, 16 GB ACAV100M negatives, MUSAN backgrounds, RIRs, generated
clips) lives in `~/.familyhub/lkww-train/` and is never committed.

Trained on the M5 Pro/64 GB dev box (MPS); deploys a ~170 KB ONNX to the M1 Pro
appliance. A full 50k-step train takes ~12 minutes — data generation is the
slow part (~1–5 h depending on TTS backends).

## Layout

- `hey_james_v2.yaml` — main config: 25k piper positives, conv-attention
  medium, curated confusable negatives, ACAV100M + background negatives.
- `hey_james_v2_voxcpm.yaml` — VoxCPM2 "voice design" pass generating
  Brazilian-Portuguese-accented English positives/negatives (the owner's
  accent class; piper's LibriTTS voices are US-English only).
- `gen_say_clips.py` — third TTS family: every real macOS `say` voice
  (including the pt_BR set — Luciana et al. — reading English) → staged clips.
- `merge_staged_clips.py` — renumbers staged clips into the training layout
  (augment only accepts `clip_NNNNNN.wav`).
- `fold_owner_corpus.py` — folds real owner recordings
  (`record_corpus.py` → `~/.familyhub/wake-corpus`) into the training set with
  oversampling. Real recordings are the strongest accent-recall lever — fold
  them in as soon as they exist and retrain.

## Recipe

```bash
cd ~/.familyhub/lkww-train        # venv: python3.11 + livekit-wakeword[train,voxcpm]
REPO=~/Pessoal/FamilyHub

# 0. One-time assets (piper checkpoint, MUSAN, RIRs, ACAV100M, VoxCPM2 weights)
./venv/bin/livekit-wakeword setup --config hey_james_v2.yaml
./venv/bin/livekit-wakeword setup --config hey_james_v2_voxcpm.yaml

# 1. Bulk synthetic data (piper VITS, ~45 min)
./venv/bin/livekit-wakeword generate hey_james_v2.yaml

# 2. Accent + timbre diversity
./venv/bin/livekit-wakeword generate hey_james_v2_voxcpm.yaml   # hours (diffusion TTS)
python3 $REPO/sidecar/training/gen_say_clips.py                  # ~10 min
python3 $REPO/sidecar/training/merge_staged_clips.py \
    --dest work/output/hey_james_v2 \
    --src work/say_staging \
    --src work/output/hey_james_v2_voxcpm

# 2b. Owner recordings, when they exist (STRONGLY recommended)
python3 $REPO/sidecar/training/fold_owner_corpus.py --dup 25

# 3. Augment (reverb/noise/EQ ×3) + features, train, export, eval
./venv/bin/livekit-wakeword augment hey_james_v2.yaml
./venv/bin/livekit-wakeword train   hey_james_v2.yaml
./venv/bin/livekit-wakeword export  hey_james_v2.yaml
./venv/bin/livekit-wakeword eval    hey_james_v2.yaml
# eval writes work/output/hey_james_v2/hey_james_v2_eval.json — note
# `optimal_threshold` (recall-max at target_fp_per_hour).

# 4. Bench-gated promote into the sidecar (backs up the live model; reverts on
#    regression) + the recall-first threshold for FAMILYHUB_WAKE_THRESHOLD
FAMILYHUB_SIDECAR_PYTHON=$REPO/sidecar/.venv/bin/python \
    $REPO/sidecar/promote_model.sh work/output/hey_james_v2/hey_james_v2.onnx
$REPO/sidecar/.venv/bin/python $REPO/sidecar/wake_bench.py --tune --fp-budget 0.5

# 5. Verify end-to-end
$REPO/sidecar/.venv/bin/python $REPO/sidecar/selftest.py
```

## Notes

- livekit-wakeword's training extra runs on CURRENT torch (≥2.5; MPS
  supported) — none of the pinned-torch-2.2 gymnastics the old openWakeWord
  recipe needed.
- The eval "negatives" are ADVERSARIAL james-confusables; false-fire rates on
  them overstate real-room false wakes by a wide margin.
- Never put ASR-mishearing strings of GENUINE wakes ("page ends", "cames"
  heard from a real "hey james") in `custom_negative_phrases` — those
  acoustics are inside the owner's positive cluster and training against them
  carves out the owner's own pronunciation. Only genuinely different phrases
  ("hey jason", "hey games") belong there.
- `diagnose_wake.py scores|pipeline` (sidecar venv) shows score percentiles,
  recall and fire latency over the held-out test splits.
