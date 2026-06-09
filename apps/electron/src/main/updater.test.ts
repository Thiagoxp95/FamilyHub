import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpdaterController,
  registerUpdaterIpc,
  type UpdaterAdapter,
  type UpdaterBroadcaster,
} from "./updater";

class FakeUpdater extends EventEmitter implements UpdaterAdapter {
  autoDownload = false;
  checkForUpdates = vi.fn(async () => {
    this.emit("checking-for-update");
  });
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

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
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

  it("ignores updater events in development mode", () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: false,
      updater,
    });

    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "0.1.1" });
    updater.emit("download-progress", { percent: 42.4 });
    updater.emit("update-downloaded", { version: "0.1.1" });
    updater.emit("error", new Error("network failed"));

    expect(controller.getStatus()).toMatchObject({ state: "idle" });
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

  it("auto-installs and relaunches a downloaded update after the grace delay", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    createUpdaterController({
      autoInstallOnDownloaded: true,
      broadcaster,
      isPackaged: true,
      updater,
    });

    updater.emit("update-downloaded", { version: "0.1.1" });
    // No mouse on the kitchen display, but don't yank the app out immediately.
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);

    // Silent install + relaunch so the display self-heals to the new version.
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("schedules at most one auto-install across repeated downloaded events", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    createUpdaterController({
      autoInstallOnDownloaded: true,
      broadcaster,
      isPackaged: true,
      updater,
    });

    updater.emit("update-downloaded", { version: "0.1.1" });
    updater.emit("update-downloaded", { version: "0.1.1" });
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("does not auto-install a downloaded update unless explicitly enabled", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    createUpdaterController({ broadcaster, isPackaged: true, updater });

    updater.emit("update-downloaded", { version: "0.1.1" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("never auto-installs in development mode", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    createUpdaterController({
      autoInstallOnDownloaded: true,
      broadcaster,
      isPackaged: false,
      updater,
    });

    updater.emit("update-downloaded", { version: "0.1.1" });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not install before an update is downloaded", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    await controller.installNow();
    updater.emit("update-available", { version: "0.1.1" });
    await controller.installNow();

    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("keeps downloaded state through later manual checks", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    updater.emit("update-downloaded", { version: "0.1.1" });
    await controller.checkNow();
    updater.emit("update-not-available", { version: "0.0.0" });
    await controller.installNow();

    expect(controller.getStatus()).toMatchObject({
      state: "downloaded",
      version: "0.1.1",
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(broadcaster.sent).toMatchObject([
      { state: "downloaded", version: "0.1.1" },
    ]);
  });

  it("shares an in-flight manual check", async () => {
    const updater = new FakeUpdater();
    const deferred = createDeferred();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("checking-for-update");
      await deferred.promise;
      updater.emit("update-not-available", { version: "0.0.0" });
    });
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    const firstCheck = controller.checkNow();
    const secondCheck = controller.checkNow();

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(broadcaster.sent).toMatchObject([{ state: "checking" }]);

    deferred.resolve();

    await expect(Promise.all([firstCheck, secondCheck])).resolves.toMatchObject([
      { state: "not-available", version: "0.0.0" },
      { state: "not-available", version: "0.0.0" },
    ]);
    expect(broadcaster.sent).toMatchObject([
      { state: "checking" },
      { state: "not-available", version: "0.0.0" },
    ]);
  });

  it("keeps downloaded state through scheduled checks", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    await controller.start();
    updater.emit("update-downloaded", { version: "0.1.1" });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(controller.getStatus()).toMatchObject({
      state: "downloaded",
      version: "0.1.1",
    });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(broadcaster.sent).toMatchObject([
      { state: "checking" },
      { state: "downloaded", version: "0.1.1" },
    ]);
  });

  it("starts only one check loop when called repeatedly", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    await controller.start();
    await controller.start();

    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(broadcaster.sent).toMatchObject([
      { state: "checking" },
      { state: "checking" },
    ]);
  });

  it("swallows background-check errors and stays idle", () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    // A background poll / launch check has no user behind it — an unreachable
    // feed (or a sideloaded build with no app-update.yml) must not paint a red
    // banner on the kitchen display.
    updater.emit("error", new Error("network failed"));

    expect(controller.getStatus()).toMatchObject({ state: "idle" });
  });

  it("surfaces errors from a user-initiated check", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = vi.fn(async () => {
      updater.emit("error", new Error("network failed"));
    });
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    await controller.checkNow();

    expect(controller.getStatus()).toMatchObject({
      error: "network failed",
      state: "error",
    });
  });

  it("stays silent for a missing update feed even on a user-initiated check", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = vi.fn(async () => {
      const error = new Error(
        "ENOENT: no such file or directory, open '/app/Resources/app-update.yml'",
      );
      (error as NodeJS.ErrnoException).code = "ENOENT";
      updater.emit("error", error);
    });
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    await controller.checkNow();

    expect(controller.getStatus()).toMatchObject({ state: "idle" });
    expect(broadcaster.sent).not.toContainEqual(
      expect.objectContaining({ state: "error" }),
    );
  });

  it("resets to silent after a user-initiated check resolves", async () => {
    const updater = new FakeUpdater();
    const broadcaster = createBroadcaster();
    const controller = createUpdaterController({
      broadcaster,
      isPackaged: true,
      updater,
    });

    await controller.checkNow();
    // A later background error must not inherit the prior click's loud state.
    updater.emit("error", new Error("network failed"));

    expect(controller.getStatus()).toMatchObject({ state: "idle" });
  });
});

describe("registerUpdaterIpc", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("registers updater ipc handlers", async () => {
    const updater = new FakeUpdater();
    const handlers = new Map<string, () => unknown>();
    const ipc = {
      handle: vi.fn((channel: string, handler: () => unknown) => {
        handlers.set(channel, handler);
      }),
    };

    registerUpdaterIpc({
      appIsPackaged: true,
      getAllWindows: () => [],
      ipc,
      updater,
    });

    expect([...handlers.keys()]).toEqual([
      "updater:getStatus",
      "updater:check",
      "updater:install",
    ]);
    expect(ipc.handle).toHaveBeenCalledTimes(3);

    expect(handlers.get("updater:getStatus")?.()).toMatchObject({
      state: "idle",
    });
    await handlers.get("updater:check")?.();
    await handlers.get("updater:install")?.();

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("auto-installs downloaded updates for the kitchen display", async () => {
    const updater = new FakeUpdater();
    registerUpdaterIpc({
      appIsPackaged: true,
      getAllWindows: () => [],
      ipc: { handle: vi.fn() },
      updater,
    });

    updater.emit("update-downloaded", { version: "0.1.1" });
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("broadcasts updater status only to non-destroyed windows", () => {
    const updater = new FakeUpdater();
    const sendActive = vi.fn();
    const sendDestroyed = vi.fn();
    const ipc = {
      handle: vi.fn(),
    };

    registerUpdaterIpc({
      appIsPackaged: true,
      getAllWindows: () => [
        {
          webContents: {
            isDestroyed: () => false,
            send: sendActive,
          },
        },
        {
          webContents: {
            isDestroyed: () => true,
            send: sendDestroyed,
          },
        },
      ],
      ipc,
      updater,
    });

    updater.emit("update-downloaded", { version: "0.1.1" });

    expect(sendActive).toHaveBeenCalledWith("updater:status", {
      state: "downloaded",
      version: "0.1.1",
    });
    expect(sendDestroyed).not.toHaveBeenCalled();
  });
});
