import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnrollmentRecorderView, recorderPrompt } from "./EnrollmentRecorder";

describe("recorderPrompt", () => {
  it("shows sample n/N and the phrase while idle", () => {
    expect(recorderPrompt({ phase: "idle", target: 15, kept: 3, hasClip: false }))
      .toMatchObject({ counter: "4 / 15", action: "Record" });
  });
  it("prompts to keep/redo in review", () => {
    expect(recorderPrompt({ phase: "review", target: 15, kept: 3, hasClip: true }).action)
      .toBe("Keep or redo");
  });
});

describe("EnrollmentRecorderView", () => {
  it("renders the phrase 'Hey James' and the counter", () => {
    const html = renderToStaticMarkup(
      <EnrollmentRecorderView state={{ phase: "idle", target: 15, kept: 0, hasClip: false }}
        memberName="Mom" onRecord={() => {}} onKeep={() => {}} onRedo={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("Hey James");
    expect(html).toContain("1 / 15");
    expect(html).toContain("Mom");
  });
});
