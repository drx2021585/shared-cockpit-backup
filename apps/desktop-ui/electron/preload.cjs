const { contextBridge, ipcRenderer } = require("electron");

/**
 * Puente seguro (contextIsolation: true, nodeIntegration: false) hacia el
 * auto-updater real del proceso principal (electron-updater, ver main.cjs).
 * La UI (UpdateModal.tsx) consume esto — nunca inventa progreso ni estado.
 */
contextBridge.exposeInMainWorld("weconnectUpdater", {
  isElectron: true,
  getCurrentVersion: () => ipcRenderer.invoke("updater:get-version"),
  check: () => ipcRenderer.invoke("updater:check"),
  download: () => ipcRenderer.invoke("updater:download"),
  quitAndInstall: () => ipcRenderer.invoke("updater:install"),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("updater:event", listener);
    return () => ipcRenderer.removeListener("updater:event", listener);
  },
});
