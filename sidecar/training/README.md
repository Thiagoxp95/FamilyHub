# Training the openWakeWord "hey james" model

One-time, off-device (GPU/Colab). Produces `../models/hey_james.onnx`, the
Stage-1 candidate detector loaded by `OpenWakeWordEngine` in `../wake_listener.py`.
Runtime is torch-free; training is not.

## Recipe (openWakeWord automatic synthetic pipeline)

1. Environment (Colab GPU or a CUDA box):
   ```bash
   pip install openwakeword[train] piper-tts
   python -c "import openwakeword.utils as u; u.download_models()"
   ```
2. Generate positives with Piper TTS across many voices for the phrase
   "hey james", plus adversarial negatives ("hey jason", "james", "hey games"),
   and mix in room/background noise (FMA + audioset/ACAV negatives per the
   openWakeWord training notebook).
3. Train with the openWakeWord `train.py` / notebook flow; target FRR < 5% at
   < 0.5 false-accepts/hour on a held-out set including the negatives above.
4. (Optional, better real-room recall) Fold in real clips recorded on the
   appliance mic via `../record_wake.py`.
5. Export to ONNX and copy the classifier to `../models/hey_james.onnx`.

## Acceptance

`../selftest.py` must PASS with the exported model at the default threshold
(retune `FAMILYHUB_WAKE_THRESHOLD` if needed — prefer a Stage-1 fire + Stage-2
veto over a Stage-1 miss; recall-first). The runtime expects:

- `OpenWakeWordEngine` reads the score via `max(scores.values())`, so the
  ONNX model name does not matter — only that it loads under
  `Model(wakeword_models=["hey_james.onnx"], inference_framework="onnx")`.
- Stage 2 (Moonshine) independently confirms the word "james", so Stage 1 is
  tuned for recall, not precision.

## After training

Replace the retired livekit model and commit:

```bash
git rm ../james.onnx                 # retired livekit Stage-1 model
git add ../models/hey_james.onnx training/README.md
git commit -m "feat(wake): add trained openWakeWord hey_james.onnx; drop retired james.onnx"
```
