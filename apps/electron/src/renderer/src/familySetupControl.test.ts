import { describe, expect, it } from "vitest";
import { familySetupTransition } from "./familySetupControl";

describe("familySetupTransition", () => {
  it("opening stops listening and rebuilds capture", () => {
    expect(familySetupTransition(true)).toEqual({ listening: "stop", bumpCapture: true });
  });
  it("closing resumes listening and rebuilds capture", () => {
    expect(familySetupTransition(false)).toEqual({ listening: "start", bumpCapture: true });
  });
});
