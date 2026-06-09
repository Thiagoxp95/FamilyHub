import { BrowserWindow, ipcMain, type IpcMain } from "electron";
// `electron-updater` is CommonJS; a named ESM import resolves to undefined in the
// packaged build and crashes on launch. Import the default and read `autoUpdater`
// lazily (in the IPC default param) so its getter only fires inside a real
// Electron main process, never at module load (which would break tests).
import electronUpdater from "electron-updater";

const updaterStatusChannel = "updater:status";
const updateCheckIntervalMs = 6 * 60 * 60 * 1000;
// On a mouseless, always-on kitchen display nobody clicks "Restart", so a
// downloaded update would never apply. Once it's downloaded, install it silently
// and relaunch after a short grace delay (long enough to avoid cutting off a
// just-finished interaction, short enough that the display self-heals to latest).
const autoInstallDelayMs = 60 * 1000;

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
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface UpdaterBroadcaster {
  broadcast: (channel: string, payload: unknown) => void;
}

export interface UpdaterController {
  checkNow: () => Promise<UpdaterStatus>;
  downloadNow: () => Promise<UpdaterStatus>;
  getStatus: () => UpdaterStatus;
  installNow: () => Promise<UpdaterStatus>;
  start: () => Promise<void>;
}

export interface UpdaterWindow {
  webContents: {
    isDestroyed: () => boolean;
    send: (channel: string, payload: unknown) => void;
  };
}

export function createUpdaterController({
  autoInstallOnDownloaded = false,
  broadcaster,
  isPackaged,
  updater,
}: {
  autoInstallOnDownloaded?: boolean;
  broadcaster: UpdaterBroadcaster;
  isPackaged: boolean;
  updater: UpdaterAdapter;
}): UpdaterController {
  let status: UpdaterStatus = { state: "idle" };
  let intervalId: NodeJS.Timeout | null = null;
  let checkPromise: Promise<UpdaterStatus> | null = null;
  let startPromise: Promise<void> | null = null;
  let autoInstallTimer: NodeJS.Timeout | null = null;
  // Background checks (launch + 6h poll) must fail seamlessly on an always-on
  // kitchen display — a sideloaded build has no update feed and GitHub can blip.
  // Only surface the loud red error state when the user explicitly asked.
  let userInitiatedCheck = false;

  function publishCheckError(error: unknown): void {
    // A missing app-update.yml means this build has no update feed at all
    // (sideloaded / `--dir` build, never published). That's not a failure worth
    // showing — stay silent even on a manual click. Real failures (network,
    // signature, etc.) still go loud when the user explicitly asked.
    if (userInitiatedCheck && !isMissingFeedConfig(error)) {
      publish({ state: "error", error: readError(error) });
    } else {
      publish({ state: "idle" });
    }
  }

  function publish(next: UpdaterStatus): UpdaterStatus {
    if (!isPackaged) {
      return status;
    }

    if (status.state === "downloaded" && next.state !== "downloaded") {
      return status;
    }

    status = next;
    broadcaster.broadcast(updaterStatusChannel, status);
    return status;
  }

  function readVersion(info: unknown): string | undefined {
    return isRecord(info) && typeof info.version === "string"
      ? info.version
      : undefined;
  }

  function withVersion(
    state: UpdateState,
    version: string | undefined,
  ): UpdaterStatus {
    return version === undefined ? { state } : { state, version };
  }

  function scheduleAutoInstall(): void {
    if (!isPackaged || !autoInstallOnDownloaded || autoInstallTimer) {
      return;
    }

    autoInstallTimer = setTimeout(() => {
      // Silent install (no Squirrel prompt) + relaunch, so the display comes
      // back up on the new version without anyone touching it.
      updater.quitAndInstall(true, true);
    }, autoInstallDelayMs);
    autoInstallTimer.unref?.();
  }

  if (isPackaged) {
    updater.autoDownload = true;
  }

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
    scheduleAutoInstall();
  });
  updater.on("error", (error) => {
    publishCheckError(error);
  });

  async function checkNow(userInitiated: boolean): Promise<UpdaterStatus> {
    if (!isPackaged || status.state === "downloaded") {
      return status;
    }

    // A manual click during an in-flight background check upgrades it to loud.
    if (userInitiated) {
      userInitiatedCheck = true;
    }

    if (checkPromise) {
      return checkPromise;
    }

    checkPromise = (async () => {
      try {
        await updater.checkForUpdates();
      } catch (error) {
        publishCheckError(error);
      }

      return status;
    })();

    try {
      return await checkPromise;
    } finally {
      checkPromise = null;
      userInitiatedCheck = false;
    }
  }

  return {
    async checkNow() {
      return checkNow(true);
    },
    async downloadNow() {
      // electron-updater auto-downloads in the background, so this is only a
      // manual nudge: download is meaningful exactly when an update is known to
      // be available. quietly no-op otherwise (idle/not-available/downloaded).
      if (!isPackaged || status.state !== "available") {
        return status;
      }

      try {
        await updater.downloadUpdate();
      } catch (error) {
        publishCheckError(error);
      }

      return status;
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

      if (startPromise) {
        return startPromise;
      }

      startPromise = (async () => {
        await checkNow(false);
        intervalId = setInterval(() => {
          void checkNow(false);
        }, updateCheckIntervalMs);
        intervalId.unref?.();
      })();

      return startPromise;
    },
  };
}

export function registerUpdaterIpc({
  appIsPackaged,
  getAllWindows = () => BrowserWindow.getAllWindows(),
  ipc = ipcMain,
  updater = electronUpdater.autoUpdater as unknown as UpdaterAdapter,
}: {
  appIsPackaged: boolean;
  getAllWindows?: () => UpdaterWindow[];
  ipc?: Pick<IpcMain, "handle">;
  updater?: UpdaterAdapter;
}): UpdaterController {
  const controller = createUpdaterController({
    autoInstallOnDownloaded: true,
    broadcaster: {
      broadcast(channel, payload) {
        for (const window of getAllWindows()) {
          if (!window.webContents.isDestroyed()) {
            window.webContents.send(channel, payload);
          }
        }
      },
    },
    isPackaged: appIsPackaged,
    updater,
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

function isMissingFeedConfig(error: unknown): boolean {
  if (isRecord(error) && error.code === "ENOENT") {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("app-update.yml");
}
