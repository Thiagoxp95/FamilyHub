import { describe, expect, it, vi } from "vitest";
import {
  isAllowedMediaPermission,
  requestMicrophoneAccess,
} from "./permissions";

describe("isAllowedMediaPermission", () => {
  it("allows audio media requests from the app window", () => {
    expect(
      isAllowedMediaPermission({
        mediaType: "audio",
        permission: "media",
        url: "http://localhost:5173/",
      }),
    ).toBe(true);
  });

  it("rejects non-audio media requests", () => {
    expect(
      isAllowedMediaPermission({
        mediaType: "video",
        permission: "media",
        url: "http://localhost:5173/",
      }),
    ).toBe(false);
  });

  it("rejects media requests outside the app window", () => {
    expect(
      isAllowedMediaPermission({
        mediaType: "audio",
        permission: "media",
        url: "https://example.com/",
      }),
    ).toBe(false);
  });
});

describe("requestMicrophoneAccess", () => {
  it("asks macOS for microphone access", async () => {
    const askForMediaAccess = vi.fn().mockResolvedValue(true);

    await expect(
      requestMicrophoneAccess({
        platform: "darwin",
        systemPreferences: { askForMediaAccess },
      }),
    ).resolves.toBe(true);

    expect(askForMediaAccess).toHaveBeenCalledWith("microphone");
  });

  it("does not ask non-macOS platforms for media access", async () => {
    const askForMediaAccess = vi.fn();

    await expect(
      requestMicrophoneAccess({
        platform: "win32",
        systemPreferences: { askForMediaAccess },
      }),
    ).resolves.toBe(true);

    expect(askForMediaAccess).not.toHaveBeenCalled();
  });
});
