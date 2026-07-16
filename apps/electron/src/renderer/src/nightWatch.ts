// Decides when the kitchen display should go black for the night: after a
// sustained stretch with no sound picked up by the wake mic, the screen is
// blanked so it stops leaking light toward the bedroom. Any sustained sound
// (people back in the room), a touch, or an assistant session wakes it.
//
// Pure reducer so the thresholds are unit-testable; App.tsx feeds it mic
// levels (~every 32 ms), user activity, and a coarse timer tick.

export interface NightWatchConfig {
  // Mic level (0-100 RMS, AGC applied) at or above which sound counts as
  // someone being present. Kept above the silent-room noise floor so an empty
  // kitchen at night can actually go dark.
  presenceLevel: number;
  // Sound must stay above presenceLevel for this long before it counts —
  // a fridge-compressor kick or a door thump must not light the room at 3 am.
  sustainMs: number;
  // This long without presence → screen goes black.
  idleMs: number;
}

export const defaultNightWatchConfig: NightWatchConfig = {
  presenceLevel: 10,
  sustainMs: 800,
  idleMs: 10 * 60 * 1000,
};

export interface NightWatchState {
  screenOff: boolean;
  lastPresenceAt: number;
  // Start of the current above-threshold run; null while under the threshold.
  soundStartedAt: number | null;
}

export function createNightWatchState(now: number): NightWatchState {
  return { screenOff: false, lastPresenceAt: now, soundStartedAt: null };
}

export type NightWatchEvent =
  // A smoothed mic level sample.
  | { type: "level"; level: number; now: number }
  // Direct human/assistant activity (touch, key, wake fired, session open):
  // wakes the screen immediately and resets the idle clock.
  | { type: "activity"; now: number }
  // Coarse periodic check; the only event that can turn the screen off.
  | { type: "tick"; now: number };

export function reduceNightWatch(
  state: NightWatchState,
  event: NightWatchEvent,
  config: NightWatchConfig = defaultNightWatchConfig,
): NightWatchState {
  switch (event.type) {
    case "level": {
      if (event.level < config.presenceLevel) {
        return state.soundStartedAt === null
          ? state
          : { ...state, soundStartedAt: null };
      }

      const soundStartedAt = state.soundStartedAt ?? event.now;

      if (event.now - soundStartedAt < config.sustainMs) {
        // Above threshold but not yet long enough to count as presence.
        return state.soundStartedAt === soundStartedAt
          ? state
          : { ...state, soundStartedAt };
      }

      return {
        screenOff: false,
        lastPresenceAt: event.now,
        soundStartedAt,
      };
    }

    case "activity":
      return {
        screenOff: false,
        lastPresenceAt: event.now,
        soundStartedAt: state.soundStartedAt,
      };

    case "tick": {
      if (state.screenOff) {
        return state;
      }

      if (event.now - state.lastPresenceAt < config.idleMs) {
        return state;
      }

      return { ...state, screenOff: true };
    }
  }
}
