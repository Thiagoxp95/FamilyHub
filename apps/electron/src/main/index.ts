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
    // Seamless dark chrome: hide the solid title bar and paint the window the
    // same base color as the app so there's no grey strip at the top. Traffic
    // lights stay (inset) so the window is still movable/closable.
    backgroundColor: "#08080d",
    titleBarStyle: "hiddenInset",
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
  ipcMain.handle("app:getVersion", () => app.getVersion());
  const dashboard = registerDashboardIpc(app.getPath("userData"));
  const updater = registerUpdaterIpc({ appIsPackaged: app.isPackaged });
  registerAssistantIpc(dashboard, updater);
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
