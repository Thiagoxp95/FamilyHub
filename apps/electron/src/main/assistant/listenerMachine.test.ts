import { describe, expect, it } from "vitest";
import {
  createListenerState,
  defaultListenerConfig,
  reduceListener,
  type ListenerEffect,
  type ListenerEvent,
  type ListenerState,
} from "./listenerMachine";

// Drives a sequence of events through the reducer, returning the final state
// and the flat list of every frame handed to "sendFrames", in emission order.
function run(
  events: ListenerEvent[],
  config = defaultListenerConfig,
): { state: ListenerState; sent: string[]; effects: ListenerEffect[] } {
  let state = createListenerState();
  const sent: string[] = [];
  const effects: ListenerEffect[] = [];

  for (const event of events) {
    const result = reduceListener(state, event, config);
    state = result.state;

    for (const effect of result.effects) {
      effects.push(effect);

      if (effect.type === "sendFrames") {
        sent.push(...effect.frames);
      }
    }
  }

  return { state, sent, effects };
}

describe("reduceListener", () => {
  it("buffers idle frames into the pre-roll without sending", () => {
    const { state, sent } = run([
      { type: "frame", frame: "p1" },
      { type: "frame", frame: "p2" },
    ]);

    expect(state.phase).toBe("idle");
    expect(state.preRoll).toEqual(["p1", "p2"]);
    expect(sent).toEqual([]);
  });

  it("caps the pre-roll at maxPrerollFrames, dropping the oldest", () => {
    const { state } = run(
      [
        { type: "frame", frame: "p1" },
        { type: "frame", frame: "p2" },
        { type: "frame", frame: "p3" },
      ],
      { maxPrerollFrames: 2, maxQueueFrames: 100 },
    );

    expect(state.preRoll).toEqual(["p2", "p3"]);
  });

  it("seeds the queue from the pre-roll and requests connect on wake", () => {
    const { state, effects, sent } = run([
      { type: "frame", frame: "p1" },
      { type: "frame", frame: "p2" },
      { type: "wake" },
    ]);

    expect(state.phase).toBe("connecting");
    expect(state.preRoll).toEqual([]);
    expect(state.queue).toEqual(["p1", "p2"]);
    expect(effects).toContainEqual({ type: "connect" });
    expect(sent).toEqual([]); // nothing sent until the socket opens
  });

  it("delivers pre-roll + connecting frames + live frames exactly once, in order", () => {
    const { state, sent } = run([
      { type: "frame", frame: "p1" }, // pre-roll
      { type: "frame", frame: "p2" }, // pre-roll
      { type: "wake" },
      { type: "frame", frame: "c1" }, // buffered during connect
      { type: "frame", frame: "c2" },
      { type: "sessionOpen" }, // flush p1,p2,c1,c2
      { type: "frame", frame: "l1" }, // streamed live
      { type: "frame", frame: "l2" },
    ]);

    expect(state.phase).toBe("live");
    expect(state.queue).toEqual([]);
    expect(sent).toEqual(["p1", "p2", "c1", "c2", "l1", "l2"]);
  });

  it("caps the connecting queue at maxQueueFrames, dropping the oldest", () => {
    const { sent } = run(
      [
        { type: "wake" },
        { type: "frame", frame: "c1" },
        { type: "frame", frame: "c2" },
        { type: "frame", frame: "c3" },
        { type: "sessionOpen" },
      ],
      { maxPrerollFrames: 10, maxQueueFrames: 2 },
    );

    expect(sent).toEqual(["c2", "c3"]);
  });

  it("returns to idle and sends nothing when the connect fails", () => {
    const { state, sent } = run([
      { type: "wake" },
      { type: "frame", frame: "c1" },
      { type: "sessionClosed" }, // connect failed before open
    ]);

    expect(state.phase).toBe("idle");
    expect(state.queue).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("ignores wake while connecting or live", () => {
    const { effects } = run([
      { type: "wake" },
      { type: "wake" },
      { type: "sessionOpen" },
      { type: "wake" },
    ]);

    expect(effects.filter((effect) => effect.type === "connect")).toHaveLength(1);
  });

  it("on stop, requests close, ignores frames while closing, then idles", () => {
    const { state, effects, sent } = run([
      { type: "wake" },
      { type: "sessionOpen" },
      { type: "stop" },
      { type: "frame", frame: "late" }, // arrives during teardown
      { type: "sessionClosed" },
    ]);

    expect(effects).toContainEqual({ type: "closeSession" });
    expect(sent).toEqual([]); // "late" must not be streamed
    expect(state.phase).toBe("idle");
  });
});
