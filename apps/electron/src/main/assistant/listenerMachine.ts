// Pure, side-effect-free model of the wake → connect → live handoff.
//
// The renderer streams every mic frame to the main process continuously. While
// idle we keep a bounded rolling pre-roll so that the words spoken immediately
// after "James" — before the local ASR has finished recognising the wake word —
// are not lost. On wake we seed a flush queue from the pre-roll and keep
// appending frames while Gemini Live connects. When the socket opens we flush
// the whole queue once, in order, then stream subsequent frames straight
// through. Because no frame is ever sent before the socket opens, delivery is
// exactly-once with no fuzzy de-duplication required.

export type ListenerPhase = "idle" | "connecting" | "live" | "closing";

export interface ListenerState {
  phase: ListenerPhase;
  preRoll: string[];
  queue: string[];
  sessionOpen: boolean;
}

export type ListenerEvent =
  | { type: "frame"; frame: string }
  | { type: "wake" }
  | { type: "sessionOpen" }
  | { type: "sessionClosed" }
  | { type: "stop" };

export type ListenerEffect =
  | { type: "connect" }
  | { type: "sendFrames"; frames: string[] }
  | { type: "closeSession" };

export interface ListenerConfig {
  maxPrerollFrames: number;
  maxQueueFrames: number;
}

// At the renderer's ~120 ms frame cadence, 24 frames ≈ 3 s of pre-roll and
// 250 frames ≈ 30 s of buffered audio across a slow connect.
export const defaultListenerConfig: ListenerConfig = {
  maxPrerollFrames: 24,
  maxQueueFrames: 250,
};

export function createListenerState(): ListenerState {
  return { phase: "idle", preRoll: [], queue: [], sessionOpen: false };
}

interface Transition {
  state: ListenerState;
  effects: ListenerEffect[];
}

export function reduceListener(
  state: ListenerState,
  event: ListenerEvent,
  config: ListenerConfig = defaultListenerConfig,
): Transition {
  switch (state.phase) {
    case "idle":
      if (event.type === "frame") {
        return {
          state: {
            ...state,
            preRoll: boundedPush(state.preRoll, event.frame, config.maxPrerollFrames),
          },
          effects: [],
        };
      }

      if (event.type === "wake") {
        return {
          state: { ...state, phase: "connecting", queue: state.preRoll, preRoll: [] },
          effects: [{ type: "connect" }],
        };
      }

      return { state, effects: [] };

    case "connecting":
      if (event.type === "frame") {
        return {
          state: {
            ...state,
            queue: boundedPush(state.queue, event.frame, config.maxQueueFrames),
          },
          effects: [],
        };
      }

      if (event.type === "sessionOpen") {
        return {
          state: { ...state, phase: "live", sessionOpen: true, queue: [] },
          effects:
            state.queue.length > 0
              ? [{ type: "sendFrames", frames: state.queue }]
              : [],
        };
      }

      if (event.type === "sessionClosed") {
        return { state: createListenerState(), effects: [] };
      }

      if (event.type === "stop") {
        return {
          state: { ...createListenerState(), phase: "closing" },
          effects: [{ type: "closeSession" }],
        };
      }

      return { state, effects: [] };

    case "live":
      if (event.type === "frame") {
        return { state, effects: [{ type: "sendFrames", frames: [event.frame] }] };
      }

      if (event.type === "sessionClosed") {
        return { state: createListenerState(), effects: [] };
      }

      if (event.type === "stop") {
        return {
          state: { ...createListenerState(), phase: "closing" },
          effects: [{ type: "closeSession" }],
        };
      }

      return { state, effects: [] };

    case "closing":
      if (event.type === "sessionClosed") {
        return { state: createListenerState(), effects: [] };
      }

      return { state, effects: [] };
  }
}

function boundedPush(items: string[], item: string, max: number): string[] {
  const next = [...items, item];
  return next.length > max ? next.slice(next.length - max) : next;
}
