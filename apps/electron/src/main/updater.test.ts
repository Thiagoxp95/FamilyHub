import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpdaterController,
  type UpdaterAdapter,
  type UpdaterBroadcaster,
} from "./updater";

class FakeUpdater extends EventEmitter implements UpdaterAdapter {
  autoDownload = false;
  checkForUpdates = vi.fn(async () => undefined);
  quitAndInstall = vi.fn();
}

function createBroadcaster(): UpdaterBroadcaster & {
  sent: unknown[];
} {
  return {
    sent: [],
    broadcast(_channel, payload) {
      this.sent.push(payload);
    },
  };
}

describe("createUpdaterController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("stays idle and never checks in development mode", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: false,
      updater,
    });

    await controller.start();
    await controller.checkNow();

    expect(controller.getStatus()).toMatchObject({ state: "idle" });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(broadcaster.sent).toEqual([]);
  });

  it("broadcasts checking and not-available states", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    await controller.checkNow();
    updater.emit("update-not-available", { version: "0.0.0" });

    expect(updater.autoDownload).toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(broadcaster.sent).toMatchObject([
      { state: "checking" },
      { state: "not-available" },
    ]);
  });

  it("maps available, progress, downloaded, and install events", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    updater.emit("update-available", { version: "0.1.1" });
    updater.emit("download-progress", { percent: 42.4 });
    updater.emit("update-downloaded", { version: "0.1.1" });
    await controller.installNow();

    expect(controller.getStatus()).toMatchObject({
      state: "downloaded",
      version: "0.1.1",
    });
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(broadcaster.sent).toMatchObject([
      { state: "available", version: "0.1.1" },
      { state: "downloading", percent: 42 },
      { state: "downloaded", version: "0.1.1" },
    ]);
  });

  it("stores updater errors without throwing", () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    updater.emit("error", new Error("network failed"));

    expect(controller.getStatus()).toMatchObject({
      error: "network failed",
      state: "error",
    });
  });
});
