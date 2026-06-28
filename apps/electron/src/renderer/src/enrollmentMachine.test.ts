// apps/electron/src/renderer/src/enrollmentMachine.test.ts
import { describe, expect, it } from "vitest";
import {
  createEnrollmentState, reduceEnrollment, isComplete,
} from "./enrollmentMachine";

describe("enrollmentMachine", () => {
  it("starts idle with the given kept count", () => {
    const s = createEnrollmentState(15, 3);
    expect(s).toMatchObject({ phase: "idle", target: 15, kept: 3, hasClip: false });
  });
  it("startRecord → recording", () => {
    const s = reduceEnrollment(createEnrollmentState(15, 0), { type: "startRecord" });
    expect(s.phase).toBe("recording");
  });
  it("clipCaptured → review with a clip", () => {
    let s = reduceEnrollment(createEnrollmentState(15, 0), { type: "startRecord" });
    s = reduceEnrollment(s, { type: "clipCaptured" });
    expect(s).toMatchObject({ phase: "review", hasClip: true });
  });
  it("keep → kept+1, back to idle, clip cleared", () => {
    let s = createEnrollmentState(15, 0);
    s = reduceEnrollment(s, { type: "startRecord" });
    s = reduceEnrollment(s, { type: "clipCaptured" });
    s = reduceEnrollment(s, { type: "keep" });
    expect(s).toMatchObject({ phase: "idle", kept: 1, hasClip: false });
  });
  it("redo → back to idle (recoverable), clip discarded, kept unchanged", () => {
    let s = createEnrollmentState(15, 2);
    s = reduceEnrollment(s, { type: "startRecord" });
    s = reduceEnrollment(s, { type: "clipCaptured" });
    s = reduceEnrollment(s, { type: "redo" });
    expect(s).toMatchObject({ phase: "idle", kept: 2, hasClip: false });
  });
  it("reset syncs kept from the store and returns to idle", () => {
    let s = reduceEnrollment(createEnrollmentState(15, 0), { type: "startRecord" });
    s = reduceEnrollment(s, { type: "reset", kept: 7 });
    expect(s).toMatchObject({ phase: "idle", kept: 7, hasClip: false });
  });
  it("isComplete at/over target", () => {
    expect(isComplete(createEnrollmentState(15, 15))).toBe(true);
    expect(isComplete(createEnrollmentState(15, 14))).toBe(false);
  });
});
