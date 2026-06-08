import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  systemPreferences,
} from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAssistantIpc } from "./assistant/ipc";
import { registerDashboardIpc } from "./dashboard/ipc";
import { loadMainEnvironment } from "./env";
import {
  configureMediaPermissions,
  requestMicrophoneAccess,
} from "./permissions";
import { registerUpdaterIpc } from "./updater";

const currentDir = dirname(fileURLToPath(import.meta.url));

loadMainEnvironment();

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    height: 1500,
    minHeight: 720,
    minWidth: 480,
    show: false,
    title: "FamilyHub",
    width: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDir, "../preload/index.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(currentDir, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  configureMediaPermissions(session.defaultSession);
  await requestMicrophoneAccess({ systemPreferences });
  ipcMain.handle("app:ping", () => "pong");
  const dashboard = registerDashboardIpc();
  registerAssistantIpc(app.getPath("userData"), dashboard);
  const updater = registerUpdaterIpc({ appIsPackaged: app.isPackaged });
  void updater.start();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
