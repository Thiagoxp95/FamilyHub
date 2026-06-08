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
