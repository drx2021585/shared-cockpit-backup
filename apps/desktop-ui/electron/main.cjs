const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");

// La app apunta al backend compartido en Railway por defecto (ver
// src/lib/apiClient.ts) — ya no levanta un server/api local embebido. Un
// server local por máquina no sirve para que dos pilotos en computadoras
// distintas se conecten entre sí, porque el relay de WebSocket solo conecta
// sockets dentro del mismo proceso (ver docs/decisiones/postgres-shared-backend.md).

let mainWindow = null;

// autoDownload=false: el usuario confirma la descarga desde el modal
// (UpdateModal.tsx) — mismo flujo que ya existía, ahora con datos reales en
// vez de simulados. Ver docs/decisiones/postgres-shared-backend.md y el
// build.publish de package.json (GitHub Releases, mismo repo del .exe).
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = console;

function sendUpdaterEvent(payload) {
  mainWindow?.webContents.send("updater:event", payload);
}

autoUpdater.on("checking-for-update", () => sendUpdaterEvent({ status: "checking" }));
autoUpdater.on("update-available", (info) =>
  sendUpdaterEvent({ status: "available", version: info.version, releaseNotes: info.releaseNotes ?? null })
);
autoUpdater.on("update-not-available", (info) =>
  sendUpdaterEvent({ status: "not-available", version: info.version })
);
autoUpdater.on("download-progress", (progress) =>
  sendUpdaterEvent({
    status: "downloading",
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
  })
);
autoUpdater.on("update-downloaded", (info) => sendUpdaterEvent({ status: "downloaded", version: info.version }));
autoUpdater.on("error", (err) => sendUpdaterEvent({ status: "error", message: err?.message ?? String(err) }));

ipcMain.handle("updater:get-version", () => app.getVersion());
ipcMain.handle("updater:check", () => {
  if (!app.isPackaged) {
    // En desarrollo no hay feed de actualizaciones real que consultar contra
    // un build sin empaquetar — se informa así en vez de fallar silenciosamente.
    sendUpdaterEvent({ status: "error", message: "Update checks only run in the packaged app." });
    return Promise.resolve();
  }
  return autoUpdater.checkForUpdates();
});
ipcMain.handle("updater:download", () => autoUpdater.downloadUpdate());
ipcMain.handle("updater:install", () => autoUpdater.quitAndInstall());

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const devServerUrl = process.env.ELECTRON_START_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  if (app.isPackaged) {
    // Chequeo silencioso al abrir la app — el resultado llega por el mismo
    // canal de eventos que consume UpdateModal.tsx; si hay una versión
    // nueva, la UI decide mostrar el aviso (ver App.tsx).
    autoUpdater.checkForUpdates().catch((err) => sendUpdaterEvent({ status: "error", message: String(err) }));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
