#!/usr/bin/env python3
"""Wake-band front-end conditioner: VAD-gated fast-attack RMS-AGC.

Normalizes casual/quiet utterances toward the level the Stage-1 model was
trained on, so a soft "hey james" presents like a normal one — without
amplifying inter-utterance noise (an energy floor gates the gain). Pure numpy;
returns int16 of the SAME length so it slots in front of the engine's framing
without disturbing it.
"""
import numpy as np

INT16_MAX = 32767
INT16_MIN = -32768


def rms_int16(frame):
    if len(frame) == 0:
        return 0.0
    x = frame.astype(np.float64)
    return float(np.sqrt(np.mean(x * x)))


class WakeBandConditioner:
    def __init__(self, target_rms=2000.0, max_gain=8.0, attack=0.5, vad_floor_rms=120.0):
        self.target_rms = float(target_rms)
        self.max_gain = float(max_gain)
        self.attack = float(attack)          # 0..1 smoothing toward the desired gain
        self.vad_floor_rms = float(vad_floor_rms)
        self.reset()

    def reset(self):
        self._gain = 1.0

    def process(self, frame_int16):
        frame = np.asarray(frame_int16, dtype=np.int16)
        level = rms_int16(frame)
        if level < self.vad_floor_rms:
            # Below the speech floor: relax gain toward unity, do not amplify noise.
            self._gain += (1.0 - self._gain) * self.attack
            target_gain = 1.0
        else:
            desired = self.target_rms / level if level > 0 else 1.0
            target_gain = float(np.clip(desired, 1.0, self.max_gain))  # never attenuate, never over-boost
        # Fast attack toward the per-frame target so onset is lifted immediately.
        self._gain += (target_gain - self._gain) * self.attack
        out = np.clip(np.rint(frame.astype(np.float64) * self._gain), INT16_MIN, INT16_MAX)
        return out.astype(np.int16)
