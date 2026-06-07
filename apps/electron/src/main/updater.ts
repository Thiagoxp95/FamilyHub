import { BrowserWindow, ipcMain, type IpcMain } from "electron";
import { autoUpdater } from "electron-updater";

const updaterStatusChannel = "updater:status";
const updateCheckIntervalMs = 6 * 60 * 60 * 1000;

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error";

export interface UpdaterStatus {
  error?: string;
  percent?: number;
  state: UpdateState;
  version?: string;
}

export interface UpdaterAdapter {
  autoDownload: boolean;
  checkForUpdates: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface UpdaterBroadcaster {
  broadcast: (channel: string, payload: unknown) => void;
}

export interface UpdaterController {
  checkNow: () => Promise<UpdaterStatus>;
  getStatus: () => UpdaterStatus;
  installNow: () => Promise<UpdaterStatus>;
  start: () => Promise<void>;
}

export function createUpdaterController({
  broadcaster,
  isPackaged,
  updater,
}: {
  broadcaster: UpdaterBroadcaster;
  isPackaged: boolean;
  updater: UpdaterAdapter;
}): UpdaterController {
  let status: UpdaterStatus = { state: "idle" };
  let intervalId: NodeJS.Timeout | null = null;

  function publish(next: UpdaterStatus): UpdaterStatus {
    status = next;
    broadcaster.broadcast(updaterStatusChannel, status);
    return status;
  }

  function readVersion(info: unknown): string | undefined {
    return isRecord(info) && typeof info.version === "string"
      ? info.version
      : undefined;
  }

  function withVersion(state: UpdateState, version: string | undefined): UpdaterStatus {
    return version === undefined ? { state } : { state, version };
  }

  updater.autoDownload = true;
  updater.on("checking-for-update", () => {
    publish({ state: "checking" });
  });
  updater.on("update-available", (info) => {
    publish(withVersion("available", readVersion(info)));
  });
  updater.on("update-not-available", (info) => {
    publish(withVersion("not-available", readVersion(info)));
  });
  updater.on("download-progress", (progress) => {
    const percent =
      isRecord(progress) && typeof progress.percent === "number"
        ? Math.round(progress.percent)
        : undefined;
    publish(
      percent === undefined
        ? { state: "downloading" }
        : { state: "downloading", percent },
    );
  });
  updater.on("update-downloaded", (info) => {
    publish(withVersion("downloaded", readVersion(info)));
  });
  updater.on("error", (error) => {
    publish({ state: "error", error: readError(error) });
  });

  async function checkNow(): Promise<UpdaterStatus> {
    if (!isPackaged) {
      return status;
    }

    publish({ state: "checking" });

    try {
      await updater.checkForUpdates();
    } catch (error) {
      publish({ state: "error", error: readError(error) });
    }

    return status;
  }

  return {
    async checkNow() {
      return checkNow();
    },
    getStatus() {
      return status;
    },
    async installNow() {
      if (status.state === "downloaded") {
        updater.quitAndInstall(false, true);
      }

      return status;
    },
    async start() {
      if (!isPackaged) {
        return;
      }

      await checkNow();
      intervalId = setInterval(() => {
        void checkNow();
      }, updateCheckIntervalMs);
      intervalId.unref?.();
    },
  };
}

export function registerUpdaterIpc({
  appIsPackaged,
  ipc = ipcMain,
}: {
  appIsPackaged: boolean;
  ipc?: Pick<IpcMain, "handle">;
}): UpdaterController {
  const controller = createUpdaterController({
    broadcaster: {
      broadcast(channel, payload) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(channel, payload);
          }
        }
      },
    },
    isPackaged: appIsPackaged,
    updater: autoUpdater as unknown as UpdaterAdapter,
  });

  ipc.handle("updater:getStatus", () => controller.getStatus());
  ipc.handle("updater:check", () => controller.checkNow());
  ipc.handle("updater:install", () => controller.installNow());

  return controller;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : "Update failed.";
}
