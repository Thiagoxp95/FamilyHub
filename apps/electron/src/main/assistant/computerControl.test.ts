import { describe, expect, it } from "vitest";
import { planComputerTask } from "./computerControl";

describe("planComputerTask", () => {
  it("routes a bare app open to a direct `open -a`", () => {
    expect(planComputerTask("open Calculator")).toEqual({
      kind: "open-app",
      app: "Calculator",
    });
    expect(planComputerTask("launch Spotify")).toEqual({
      kind: "open-app",
      app: "Spotify",
    });
    expect(planComputerTask("open the Calculator app")).toEqual({
      kind: "open-app",
      app: "Calculator",
    });
  });

  it("routes a URL navigation to a direct `open`, honoring the named browser", () => {
    expect(planComputerTask("open Safari and go to g1.globo.com.br")).toEqual({
      kind: "open-url",
      url: "https://g1.globo.com.br",
      app: "Safari",
    });
    expect(planComputerTask("open Chrome and go to github.com")).toEqual({
      kind: "open-url",
      url: "https://github.com",
      app: "Google Chrome",
    });
  });

  it("opens a bare URL in the default browser when none is named", () => {
    expect(planComputerTask("go to youtube.com")).toEqual({
      kind: "open-url",
      url: "https://youtube.com",
    });
    expect(planComputerTask("navigate to https://example.com/path?x=1")).toEqual(
      { kind: "open-url", url: "https://example.com/path?x=1" },
    );
  });

  it("falls back to full computer-use when the task needs UI interaction", () => {
    for (const task of [
      "open Spotify and play my workout playlist",
      "open Notes and write down buy milk",
      "open Safari and search Google for cheap flights",
      "open Arc and search for flights",
      "go to youtube.com and play despacito",
    ]) {
      expect(planComputerTask(task)).toEqual({ kind: "computer-use" });
    }
  });

  it("falls back to computer-use for ambiguous or multi-app opens", () => {
    expect(planComputerTask("open Calculator and Notes")).toEqual({
      kind: "computer-use",
    });
    expect(planComputerTask("")).toEqual({ kind: "computer-use" });
  });
});
