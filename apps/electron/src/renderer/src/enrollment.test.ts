import { describe, expect, it } from "vitest";
import { enrollmentStatus, ENROLLMENT_TARGET } from "./enrollment";

describe("enrollmentStatus", () => {
  it("is 'none' with no samples", () => {
    expect(enrollmentStatus(0)).toBe("none");
  });
  it("is 'under' below the target", () => {
    expect(enrollmentStatus(ENROLLMENT_TARGET - 1)).toBe("under");
  });
  it("is 'complete' at or above the target", () => {
    expect(enrollmentStatus(ENROLLMENT_TARGET)).toBe("complete");
    expect(enrollmentStatus(ENROLLMENT_TARGET + 5)).toBe("complete");
  });
});
