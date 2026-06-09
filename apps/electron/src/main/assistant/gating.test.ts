import { describe, expect, it } from "vitest";
import { isSessionEndCommand } from "./gating";

describe("isSessionEndCommand", () => {
  it("recognizes short commands that close the active session", () => {
    expect(isSessionEndCommand("never mind")).toBe(true);
    expect(isSessionEndCommand("thank you familyhub")).toBe(true);
    expect(isSessionEndCommand("turn on the lights")).toBe(false);
  });
});
