import { describe, expect, it } from "vitest";
import { calculateMicrophoneLevel } from "./App";

describe("calculateMicrophoneLevel", () => {
  it("returns a rounded RMS percentage for float audio samples", () => {
    expect(calculateMicrophoneLevel(new Float32Array([0.5, -0.5]))).toBe(50);
  });

  it("clamps samples before calculating the meter level", () => {
    expect(calculateMicrophoneLevel(new Float32Array([2, -2]))).toBe(100);
  });

  it("returns zero when there are no samples", () => {
    expect(calculateMicrophoneLevel(new Float32Array())).toBe(0);
  });
});
