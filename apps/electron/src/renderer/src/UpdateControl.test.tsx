import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  UpdateControlView,
  badgeAction,
  badgeContent,
} from "./UpdateControl";

describe("badgeAction", () => {
  it("checks when idle, not-available, or errored", () => {
    expect(badgeAction("idle")).toBe("check");
    expect(badgeAction("not-available")).toBe("check");
    expect(badgeAction("error")).toBe("check");
  });

  it("installs when downloaded", () => {
    expect(badgeAction("downloaded")).toBe("install");
  });

  it("is inert while checking, available, or downloading", () => {
    expect(badgeAction("checking")).toBeNull();
    expect(badgeAction("available")).toBeNull();
    expect(badgeAction("downloading")).toBeNull();
  });
});

describe("badgeContent", () => {
  it("shows the running version and a checkmark when up to date", () => {
    expect(badgeContent({ state: "idle" }, "1.2.3")).toMatchObject({
      version: "v1.2.3",
      glyph: "✓",
    });
    expect(badgeContent({ state: "not-available" }, "1.2.3")).toMatchObject({
      version: "v1.2.3",
      glyph: "✓",
    });
  });

  it("shows the running version with a spinner glyph while checking", () => {
    expect(badgeContent({ state: "checking" }, "1.2.3")).toMatchObject({
      version: "v1.2.3",
      glyph: "⟳",
    });
  });

  it("shows the target version with a download glyph when available", () => {
    expect(
      badgeContent({ state: "available", version: "1.4.0" }, "1.2.3"),
    ).toMatchObject({ version: "v1.4.0", glyph: "↓" });
  });

  it("shows the target version and percent while downloading", () => {
    expect(
      badgeContent({ state: "downloading", version: "1.4.0", percent: 42 }, "1.2.3"),
    ).toMatchObject({ version: "v1.4.0", glyph: "↓", percent: 42 });
  });

  it("shows the new version and a restart glyph when downloaded", () => {
    expect(
      badgeContent({ state: "downloaded", version: "1.4.0" }, "1.2.3"),
    ).toMatchObject({ version: "v1.4.0", glyph: "↻" });
  });

  it("shows an error glyph on failure", () => {
    expect(badgeContent({ state: "error", error: "boom" }, "1.2.3")).toMatchObject({
      glyph: "!",
    });
  });
});

describe("UpdateControlView", () => {
  it("renders version + checkmark when up to date", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "not-available" }}
        appVersion="1.2.3"
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("v1.2.3");
    expect(html).toContain("✓");
    expect(html).toContain('aria-label="Up to date — check for updates"');
  });

  it("renders the download percent while downloading", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "downloading", percent: 42 }}
        appVersion="1.2.3"
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("↓");
    expect(html).toContain("42%");
  });

  it("renders the restart glyph and ready accent when downloaded", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "downloaded", version: "1.4.0" }}
        appVersion="1.2.3"
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("v1.4.0");
    expect(html).toContain("↻");
    expect(html).toContain("version-badge--ready");
  });

  it("disables the badge while checking and shows a spinner", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "checking" }}
        appVersion="1.2.3"
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("version-badge__glyph--spin");
  });
});
