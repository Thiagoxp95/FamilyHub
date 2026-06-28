import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the "black sidebar" bug (renderer CSS invariant, checked
// here because this file is node-typed so it can read the stylesheet). `.family-setup`
// is applied to the full-screen `.hub-fullscreen-backdrop`; a `width` there collapses
// the whole overlay into a narrow strip and hides the absolutely-positioned close
// button, which strands the overlay open and leaves the wake word paused (no trigger).
// The renderToStaticMarkup view tests assert the close button is in the DOM but cannot
// catch that it is visually unreachable — hence this CSS-text check.

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "renderer", "src", "styles.css"),
  "utf8",
);

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("family setup overlay styles", () => {
  it(".family-setup (on the full-screen backdrop) sets no width", () => {
    expect(css.includes(".family-setup {")).toBe(true); // rule exists
    expect(ruleBody(".family-setup")).not.toMatch(/\bwidth\s*:/);
  });

  it("styles the overlay content + recorder (not left bare)", () => {
    for (const selector of [".family-list", ".family-add-row", ".enroll-recorder", ".enroll-counter"]) {
      expect(css.includes(`${selector} {`)).toBe(true);
    }
  });

  it("the enrollment recorder is its own full-screen overlay", () => {
    const body = ruleBody(".enroll-recorder");
    expect(body).toMatch(/position\s*:\s*fixed/);
    expect(body).toMatch(/inset\s*:\s*0/);
  });
});
