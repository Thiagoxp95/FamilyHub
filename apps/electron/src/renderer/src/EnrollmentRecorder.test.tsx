import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnrollmentRecorderView, recorderPrompt } from "./EnrollmentRecorder";
import { reduceEnrollment, type EnrollmentState } from "./enrollmentMachine";

const noop = (): void => {};
function render(state: EnrollmentState, extra?: { error?: string }): string {
  return renderToStaticMarkup(
    <EnrollmentRecorderView
      state={state}
      memberName="Mom"
      onRecord={noop}
      onKeep={noop}
      onRedo={noop}
      onClose={noop}
      {...(extra?.error ? { error: extra.error } : {})}
    />,
  );
}

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
    const html = render({ phase: "idle", target: 15, kept: 0, hasClip: false });
    expect(html).toContain("Hey James");
    expect(html).toContain("1 / 15");
    expect(html).toContain("Mom");
  });

  it("surfaces an inline error message when present", () => {
    const html = render(
      { phase: "idle", target: 15, kept: 0, hasClip: false },
      { error: "Couldn't record that — check the microphone and try again." },
    );
    // renderToStaticMarkup escapes the apostrophe, so match an apostrophe-free span.
    expect(html).toContain("record that — check the microphone and try again.");
    expect(html).toContain("enroll-error");
  });
});

describe("recorder loop recoverability (driver-level)", () => {
  const review: EnrollmentState = { phase: "review", target: 15, kept: 2, hasClip: true };

  it("is recoverable after redo: the Record control returns (not a dead Listening…)", () => {
    const afterRedo = reduceEnrollment(review, { type: "redo" });
    const html = render(afterRedo);
    expect(html).toContain(">Record</button>");
    expect(html).not.toContain("Listening…");
  });

  it("keep advances the kept count", () => {
    const afterKeep = reduceEnrollment(review, { type: "keep" });
    expect(afterKeep.kept).toBe(3);
    expect(afterKeep.phase).toBe("idle");
  });
});
