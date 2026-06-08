import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdateControlView } from "./UpdateControl";

describe("UpdateControlView", () => {
  it("shows a check button when idle", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "idle" }}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("Check for updates");
    expect(html).not.toContain("Up to date");
  });

  it("shows up-to-date with a check button when not available", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "not-available" }}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("Up to date");
    expect(html).toContain("Check for updates");
  });

  it("shows progress while downloading", () => {
    expect(
      renderToStaticMarkup(
        <UpdateControlView
          status={{ state: "downloading", percent: 42 }}
          onCheck={() => undefined}
          onInstall={() => undefined}
        />,
      ),
    ).toContain("Downloading 42%");
  });

  it("shows a restart button after download", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "downloaded", version: "0.1.1" }}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("0.1.1 ready");
    expect(html).toContain("Restart");
  });

  it("shows a retry button for errors", () => {
    const html = renderToStaticMarkup(
      <UpdateControlView
        status={{ state: "error", error: "network failed" }}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("network failed");
    expect(html).toContain("Retry");
  });
});
