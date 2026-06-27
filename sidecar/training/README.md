# Training the openWakeWord "hey james" model

One-time. Produces `../models/hey_james.onnx`, the Stage-1 candidate detector
loaded by `OpenWakeWordEngine` in `../wake_listener.py`. The runtime is
torch-free; training is not. The committed model was trained **locally on Apple
Silicon (MPS for generation, CPU for the DNN)** — Colab/CUDA also works and is
faster. `hey_james.yml` and `run_full.sh` here are the exact config + runner used.

## Result of the committed model

20k synthetic positives + 20k adversarial negatives, the full 16 GB ACAV100M
general-negative set, ESC-50 background, MIT room-impulse-responses, 50k steps.
Held-out metrics: **0.18 false-accepts/hour** (target was 0.2). `../selftest.py`
**PASSES at the default threshold 0.5** — clean "Hey James" scores ~0.96, and
"hey jason" / bare "james" are rejected (Stage-2 Moonshine backstops precision).

## Environment (the part that bites)

The openWakeWord training stack predates current PyTorch, so a fresh
`pip install openwakeword[train]` against torch 2.10+/numpy 2 breaks on removed
APIs. Use a **separate** venv (never the runtime `../.venv`) pinned to:

```bash
python3.11 -m venv .venv
./.venv/bin/pip install torch==2.2.2 torchaudio==2.2.2 numpy==1.26.4 \
    scipy==1.13.1 audiomentations==0.33.0 \
    openwakeword torchmetrics torch_audiomentations onnx \
    pronouncing webrtcvad tqdm pyyaml
./.venv/bin/python -c "import openwakeword.utils as u; u.download_models()"
```

Gotchas already accounted for above (each was a hard failure on the bleeding-edge stack):
- `torch==2.2.2` keeps `torchaudio.info`/`.load` (removed in torchaudio 2.11; no
  torchcodec needed) — `torch_audiomentations` needs them.
- `numpy<2` + `audiomentations==0.33.0` avoids the `numpy-rms`/`numpy-minmax`
  (numpy≥2) transitive pins.
- `scipy<1.17` keeps `scipy.special.sph_harm` (the `acoustics` dep imports it).

## Data layout (gitignored under `data/`)

- `data/features/openwakeword_features_ACAV100M_2000_hrs_16bit.npy` — 16 GB
  negatives; `data/features/validation_set_features.npy` — FP-validation.
  (HF dataset `davidscripka/openwakeword_features`.)
- `data/rir/16khz/` — MIT impulse responses (`davidscripka/MIT_environmental_impulse_responses`).
- `data/background/esc50_16k/` — ESC-50 wavs resampled to 16 kHz mono
  (`ffmpeg -i in.wav -ar 16000 -ac 1 out.wav`); 44.1 kHz originals are NOT
  resampled by the augmenter.

## Generator (piper-sample-generator, gitignored)

```bash
git clone https://github.com/rhasspy/piper-sample-generator
cd piper-sample-generator && git checkout v2.0.0   # the API openWakeWord's train.py imports
curl -L -o models/en_US-libritts_r-medium.pt \
  https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt
# torch 2.6+ defaults torch.load(weights_only=True); the v2.0.0 loader needs:
sed -i '' 's/torch\.load(model_path)/torch.load(model_path, weights_only=False)/' generate_samples.py
```

Also patch the installed trainer for macOS (spawned dataloader workers can't
pickle its lambda transforms):
```bash
sed -i '' 's/num_workers=n_cpus, prefetch_factor=16/num_workers=0/' \
  .venv/lib/python3.11/site-packages/openwakeword/train.py
```

## Run

```bash
./run_full.sh        # generate_clips → augment_clips → train_model, logs to full_train.log
```
The final `onnx_tf` tflite-conversion step fails (TensorFlow not installed) —
that is fine, the `.onnx` is already saved. Then:

```bash
cp my_custom_model/hey_james.onnx ../models/hey_james.onnx
../.venv/bin/python ../selftest.py     # must PASS
```

To improve real-room recall later, record clips on the appliance mic with
`../record_wake.py` and fold them into the positive set, then retrain.

## Acceptance

`../selftest.py` must PASS at the default threshold. If a real "Hey James" ever
misses, lower `FAMILYHUB_WAKE_THRESHOLD` and/or raise
`FAMILYHUB_WAKE_POST_TRIGGER_MS` (recall-first: prefer a Stage-1 fire + Stage-2
veto over a Stage-1 miss). `OpenWakeWordEngine` reads the score via
`max(scores.values())`, so the ONNX internal model name does not matter.

## Personalizing on the owner's voice (recall-first)

The committed model is synthetic-only and misses some real voices/volumes. To
personalize for the appliance's owner + room:

1. **Record the corpus** (owner, near the USB mic):
   `sidecar/.venv/bin/python sidecar/record_corpus.py`
   → writes `~/.familyhub/wake-corpus/{positive,negative}/`.
2. **Baseline the current model:** `sidecar/.venv/bin/python sidecar/wake_bench.py`
   (note the recall + false-wakes/hour).
3. **Fold the corpus into the training set, then retrain** (training venv):
   `sidecar/training/.venv/bin/python sidecar/training/fold_owner_corpus.py`
   then `cd sidecar/training && ./run_full.sh`.
   Idempotency is keyed on the destination filename, so re-recording a clip under
   the *same* filename will be skipped — clear `my_custom_model/positive_clips/`
   (and `adversarial_negative_clips/`) before re-folding refreshed recordings.
4. **Promote behind the gate:**
   `sidecar/promote_model.sh sidecar/training/my_custom_model/hey_james.onnx`
   (promotes only if recall ≥ baseline and false-wakes/hour ≤ budget; else reverts).
5. **Re-bench + tune the operating point:**
   `sidecar/.venv/bin/python sidecar/wake_bench.py --tune`
   and set the recommended `FAMILYHUB_WAKE_THRESHOLD` (and, once the margin is
   wide, `FAMILYHUB_WAKE_S2_OR_SCORE`).
6. **Rollback any time:** `sidecar/promote_model.sh --rollback`.
