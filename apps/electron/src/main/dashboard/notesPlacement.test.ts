import { describe, expect, it } from "vitest";
import { initialPlacement } from "./notesPlacement";

describe("initialPlacement", () => {
  it("keeps new note anchors inside the board", () => {
    const placement = initialPlacement(20, () => 0.99);

    expect(placement.x).toBeGreaterThanOrEqual(0);
    expect(placement.x).toBeLessThanOrEqual(0.85);
    expect(placement.y).toBeGreaterThanOrEqual(0);
    expect(placement.y).toBeLessThanOrEqual(0.85);
  });

  it("staggers notes with small rotation jitter", () => {
    const first = initialPlacement(0, () => 0.5);
    const second = initialPlacement(1, () => 0.5);

    expect(second.x).toBeGreaterThan(first.x);
    expect(first.rotation).toBe(0);
  });
});
