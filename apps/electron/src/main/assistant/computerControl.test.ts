import { describe, expect, it, vi } from "vitest";
import { planComputerTask, runComputerTask } from "./computerControl";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

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

  it("strips 'application' and an 'on the computer' tail from app launches", () => {
    // The exact phrasing that fell through to cxdo (and died with ENOENT on a
    // Mac without the helper) instead of a plain `open -a Linear`.
    expect(planComputerTask("open the Linear application")).toEqual({
      kind: "open-app",
      app: "Linear",
    });
    expect(planComputerTask("open Linear application")).toEqual({
      kind: "open-app",
      app: "Linear",
    });
    expect(planComputerTask("open the Linear application on the computer")).toEqual({
      kind: "open-app",
      app: "Linear",
    });
    expect(planComputerTask("launch Spotify on my Mac")).toEqual({
      kind: "open-app",
      app: "Spotify",
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

  it("resolves a site named in words to a direct open (no computer-use)", () => {
    const lucky = (name: string) =>
      `https://duckduckgo.com/?q=${encodeURIComponent(`\\${name}`)}`;

    // The exact phrasing that hit OpenAI's computer-use blocklist.
    expect(
      planComputerTask(
        "Go to Safari application and go to the New York Times website",
      ),
    ).toEqual({
      kind: "open-url",
      url: lucky("New York Times"),
      app: "Safari",
    });

    expect(planComputerTask("open the globo website")).toEqual({
      kind: "open-url",
      url: lucky("globo"),
    });

    expect(planComputerTask("pull up the New York Times")).toEqual({
      kind: "open-url",
      url: lucky("New York Times"),
    });
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

describe("runComputerTask without cxdo installed", () => {
  it("reports a speakable error instead of the raw spawn ENOENT", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (e: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const error = new Error("spawn cxdo ENOENT");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        cb(error, "", "");
      },
    );

    // An interaction task routes straight to cxdo.
    const result = await runComputerTask("search for cheap flights");

    expect(result.ok).toBe(false);
    expect(result.error).not.toMatch(/spawn|ENOENT/);
    expect(result.error).toMatch(/isn't set up on this Mac/);
  });
});
