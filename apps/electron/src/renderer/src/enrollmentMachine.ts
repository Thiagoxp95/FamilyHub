// apps/electron/src/renderer/src/enrollmentMachine.ts
// Pure reducer for the per-member guided recorder. Side effects (record/save)
// are performed by the View on each transition; this stays pure + testable,
// mirroring listenerMachine.ts.
export interface EnrollmentState {
  phase: "idle" | "recording" | "review";
  target: number;
  kept: number;
  hasClip: boolean;
}

export type EnrollmentEvent =
  | { type: "startRecord" }
  | { type: "clipCaptured" }
  | { type: "keep" }
  | { type: "redo" }
  | { type: "reset"; kept: number };

export function createEnrollmentState(target: number, kept: number): EnrollmentState {
  return { phase: "idle", target, kept, hasClip: false };
}

export function reduceEnrollment(state: EnrollmentState, event: EnrollmentEvent): EnrollmentState {
  switch (event.type) {
    case "startRecord":
      return { ...state, phase: "recording", hasClip: false };
    case "clipCaptured":
      return { ...state, phase: "review", hasClip: true };
    case "keep":
      return { ...state, phase: "idle", kept: state.kept + 1, hasClip: false };
    case "redo":
      return { ...state, phase: "recording", hasClip: false };
    case "reset":
      return { ...state, phase: "idle", kept: event.kept, hasClip: false };
    default:
      return state;
  }
}

export function isComplete(state: EnrollmentState): boolean {
  return state.kept >= state.target;
}
