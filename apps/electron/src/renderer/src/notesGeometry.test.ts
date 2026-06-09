import { describe, expect, it } from "vitest";
import { clamp01, toNormalized, toPx } from "./notesGeometry";

describe("notesGeometry", () => {
  it("converts between normalized and pixel positions", () => {
    expect(toPx(0.25, 400)).toBe(100);
    expect(toNormalized(100, 400)).toBe(0.25);
  });

  it("clamps normalized values to the board", () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.2)).toBe(1);
  });

  it("returns zero when a board size is unavailable", () => {
    expect(toNormalized(100, 0)).toBe(0);
  });
});
