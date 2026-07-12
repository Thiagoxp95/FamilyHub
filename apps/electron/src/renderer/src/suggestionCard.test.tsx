import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SuggestionCard, type ActiveCard } from "./SuggestionCard";

function render(card: ActiveCard): string {
  return renderToStaticMarkup(
    <SuggestionCard card={card} onAccept={() => {}} onDismiss={() => {}} />,
  );
}

describe("SuggestionCard", () => {
  it("renders the suggestion text", () => {
    const html = render({ id: 1, kind: "reminder", text: "Dentist tomorrow at 9am" });
    expect(html).toContain("Dentist tomorrow at 9am");
  });

  it("shows an Accept button for a reminder suggestion", () => {
    const html = render({ id: 1, kind: "reminder", text: "Pick up milk" });
    expect(html).toContain("Accept");
  });

  it("shows an Accept button for a calendar suggestion", () => {
    const html = render({ id: 1, kind: "calendar", text: "Add dentist appointment" });
    expect(html).toContain("Accept");
  });

  it("shows an Accept button for a shopping suggestion", () => {
    const html = render({ id: 1, kind: "shopping", text: "Add milk to the list" });
    expect(html).toContain("Accept");
  });

  it("hides the Accept button and shows the hint for a question suggestion", () => {
    const html = render({ id: 2, kind: "question", text: "Want me to check the weather?" });
    expect(html).not.toContain("Accept");
    expect(html).toContain("Say “Hey James” to ask");
  });

  it("hides the Accept button and shows the hint for an other suggestion", () => {
    const html = render({ id: 3, kind: "other", text: "Just some context" });
    expect(html).not.toContain("Accept");
    expect(html).toContain("Say “Hey James” to ask");
  });

  it("always shows a Dismiss button", () => {
    const actionable = render({ id: 1, kind: "reminder", text: "x" });
    const nonActionable = render({ id: 2, kind: "question", text: "y" });
    expect(actionable).toContain("Dismiss");
    expect(nonActionable).toContain("Dismiss");
  });

  it("gives the root element the ambient-suggestion class", () => {
    const html = render({ id: 1, kind: "reminder", text: "x" });
    expect(html).toMatch(/^<div class="ambient-suggestion"/);
  });
});
