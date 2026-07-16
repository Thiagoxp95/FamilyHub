import { describe, expect, it } from "vitest";
import {
  createNightWatchState,
  defaultNightWatchConfig,
  reduceNightWatch,
  type NightWatchState,
} from "./nightWatch";

const config = { presenceLevel: 10, sustainMs: 800, idleMs: 600_000 };

function run(
  state: NightWatchState,
  events: Parameters<typeof reduceNightWatch>[1][],
): NightWatchState {
  return events.reduce(
    (current, event) => reduceNightWatch(current, event, config),
    state,
  );
}

describe("reduceNightWatch", () => {
  it("blanks the screen after the idle window passes with no presence", () => {
    const state = run(createNightWatchState(0), [
      { type: "tick", now: 599_999 },
    ]);
    expect(state.screenOff).toBe(false);

    const later = run(state, [{ type: "tick", now: 600_000 }]);
    expect(later.screenOff).toBe(true);
  });

  it("stays awake while sustained sound keeps arriving", () => {
    let state = createNightWatchState(0);

    // Talking from 500 000 ms onward: loud samples spanning > sustainMs.
    state = run(state, [
      { type: "level", level: 40, now: 500_000 },
      { type: "level", level: 40, now: 500_900 },
      { type: "tick", now: 600_000 },
    ]);

    expect(state.screenOff).toBe(false);
    expect(state.lastPresenceAt).toBe(500_900);
  });

  it("ignores a brief spike shorter than the sustain window", () => {
    let state = createNightWatchState(0);

    // A door thump: two loud samples 100 ms apart, then silence again.
    state = run(state, [
      { type: "level", level: 60, now: 300_000 },
      { type: "level", level: 60, now: 300_100 },
      { type: "level", level: 2, now: 300_200 },
      { type: "tick", now: 600_000 },
    ]);

    expect(state.screenOff).toBe(true);
  });

  it("requires the sound run to restart after a dip below the threshold", () => {
    let state = createNightWatchState(0);

    state = run(state, [
      { type: "level", level: 60, now: 300_000 },
      { type: "level", level: 2, now: 300_400 },
      // New run starts here — the earlier 300 000 start must not count.
      { type: "level", level: 60, now: 300_500 },
      { type: "level", level: 60, now: 301_000 },
      { type: "tick", now: 600_000 },
    ]);

    expect(state.screenOff).toBe(true);
  });

  it("wakes a blanked screen on sustained sound", () => {
    let state = run(createNightWatchState(0), [{ type: "tick", now: 600_000 }]);
    expect(state.screenOff).toBe(true);

    state = run(state, [
      { type: "level", level: 30, now: 700_000 },
      { type: "level", level: 30, now: 700_850 },
    ]);

    expect(state.screenOff).toBe(false);
  });

  it("wakes immediately on direct activity (touch / session)", () => {
    let state = run(createNightWatchState(0), [{ type: "tick", now: 600_000 }]);
    expect(state.screenOff).toBe(true);

    state = run(state, [{ type: "activity", now: 700_000 }]);

    expect(state.screenOff).toBe(false);
    expect(state.lastPresenceAt).toBe(700_000);
  });

  it("keeps the same state object for below-threshold noise while awake", () => {
    const state = createNightWatchState(0);
    const next = reduceNightWatch(
      state,
      { type: "level", level: 3, now: 1_000 },
      config,
    );

    expect(next).toBe(state);
  });

  it("exposes a ten-minute default idle window", () => {
    expect(defaultNightWatchConfig.idleMs).toBe(600_000);
  });
});
