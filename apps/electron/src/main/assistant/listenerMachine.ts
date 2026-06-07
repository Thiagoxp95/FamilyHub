// Pure, side-effect-free model of the wake → connect → live handoff.
//
// The renderer streams every mic frame to the main process continuously. On wake
// we open the Gemini Live session and, once the socket is open, stream live
// frames straight through.
//
// `bufferAcrossConnect` (OFF by default) optionally captures a rolling pre-roll
// plus the frames spoken while connecting and flushes them into the session on
// open. That let the user "say James and keep talking" without losing audio
// during connect — but replaying that burst confused Gemini's turn-taking and
// interrupted its reply, so it is disabled. With it off, no frame is buffered or
// replayed; the session only ever receives audio that arrives after it opens.

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
  // When false (default), audio is NOT buffered across the connect: the session
  // streams only frames received after the socket opens. When true, pre-roll +
  // during-connect frames are flushed into the session on open.
  bufferAcrossConnect: boolean;
}

// At the renderer's ~120 ms frame cadence, 24 frames ≈ 3 s of pre-roll and
// 250 frames ≈ 30 s of buffered audio across a slow connect (only used when
// bufferAcrossConnect is enabled).
export const defaultListenerConfig: ListenerConfig = {
  maxPrerollFrames: 24,
  maxQueueFrames: 250,
  bufferAcrossConnect: false,
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
        if (!config.bufferAcrossConnect) {
          return { state, effects: [] };
        }

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
          state: {
            ...state,
            phase: "connecting",
            queue: config.bufferAcrossConnect ? state.preRoll : [],
            preRoll: [],
          },
          effects: [{ type: "connect" }],
        };
      }

      return { state, effects: [] };

    case "connecting":
      if (event.type === "frame") {
        if (!config.bufferAcrossConnect) {
          return { state, effects: [] };
        }

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
