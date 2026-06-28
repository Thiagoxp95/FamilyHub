import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FamilySetupView, memberRowLabel } from "./FamilySetup";

describe("memberRowLabel", () => {
  it("marks complete members", () => {
    expect(memberRowLabel({ id: "a", name: "Mom", sampleCount: 15 }, 15)).toBe("Mom — 15/15 ✓");
  });
  it("shows progress for under-enrolled", () => {
    expect(memberRowLabel({ id: "b", name: "Dad", sampleCount: 4 }, 15)).toBe("Dad — 4/15");
  });
});

describe("FamilySetupView", () => {
  it("lists members, an input field, and an add button", () => {
    const html = renderToStaticMarkup(
      <FamilySetupView members={[{ id: "a", name: "Mom", sampleCount: 15 }]} target={15}
        onAdd={() => {}} onDelete={() => {}} onEnroll={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("Mom — 15/15 ✓");
    expect(html).toContain("Add member");
    expect(html).toContain("<input");
  });
});
