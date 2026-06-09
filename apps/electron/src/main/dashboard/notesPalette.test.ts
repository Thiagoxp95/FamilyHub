import { describe, expect, it } from "vitest";
import { nextColor } from "./notesPalette";

describe("nextColor", () => {
  it("starts with yellow", () => {
    expect(nextColor([])).toBe("yellow");
  });

  it("chooses the least-used color and resolves ties by palette order", () => {
    expect(
      nextColor([
        { color: "yellow" },
        { color: "yellow" },
        { color: "pink" },
        { color: "mint" },
        { color: "blue" },
      ]),
    ).toBe("orange");

    expect(
      nextColor([
        { color: "yellow" },
        { color: "pink" },
      ]),
    ).toBe("mint");
  });
});
