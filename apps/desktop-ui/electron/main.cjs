const { app, BrowserWindow } = require("electron");
const path = require("node:path");

// La app apunta al backend compartido en Railway por defecto (ver
// src/lib/apiClient.ts) — ya no levanta un server/api local embebido. Un
// server local por máquina no sirve para que dos pilotos en computadoras
// distintas se conecten entre sí, porque el relay de WebSocket solo conecta
// sockets dentro del mismo proceso (ver docs/decisiones/postgres-shared-backend.md).

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.ELECTRON_START_URL;
  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
