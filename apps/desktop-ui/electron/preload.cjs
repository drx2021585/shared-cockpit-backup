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

contextBridge.exposeInMainWorld("weconnectDesktop", {
  openInstallFolder: () => ipcRenderer.invoke("app:open-install-folder"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  restartApp: () => ipcRenderer.invoke("app:restart"),
});

contextBridge.exposeInMainWorld("weconnectNetwork", {
  getLocalAddresses: () => ipcRenderer.invoke("network:get-local-addresses"),
});

contextBridge.exposeInMainWorld("weconnectDirectRelay", {
  ensureHost: (port) => ipcRenderer.invoke("direct-relay:ensure-host", port),
});

/**
 * Asistente de primer inicio (carpeta Community de MSFS) — ver main.cjs para
 * la implementación real de validación/copia/persistencia de config.
 */
/**
 * Controles de la barra de título custom (frame: false en main.cjs, ver
 * src/components/TitleBar.tsx). Reemplazan los botones nativos de Windows
 * por los 3 puntos estilo macOS.
 */
contextBridge.exposeInMainWorld("weconnectWindow", {
  isElectron: true,
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onStateChange: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
});

/**
 * Token efímero del bridge local (ver main.cjs launchBridgeIfNeeded): el
 * renderer lo anexa como ?token= al conectar a ws://localhost:7620, para que
 * solo esta app pueda hablar con el bridge. null si el bridge corre lanzado
 * a mano (flujo de desarrollo sin token).
 */
contextBridge.exposeInMainWorld("weconnectBridgeAuth", {
  getToken: () => ipcRenderer.invoke("bridge:get-token"),
  // Mata el bridge que esté corriendo (viejo, lanzado a mano, o el nuestro) y
  // arranca el empaquetado. Lo usa la UI cuando detecta un bridge con API vieja.
  replaceStale: () => ipcRenderer.invoke("bridge:replace-stale"),
});

contextBridge.exposeInMainWorld("weconnectSetup", {
  getConfig: () => ipcRenderer.invoke("setup:get-config"),
  chooseFolder: () => ipcRenderer.invoke("setup:choose-folder"),
  validateFolder: (folderPath) => ipcRenderer.invoke("setup:validate-folder", folderPath),
  installPackages: (folderPath) => ipcRenderer.invoke("setup:install-packages", folderPath),
  markCompleted: (communityPath) => ipcRenderer.invoke("setup:mark-completed", communityPath),
  reset: () => ipcRenderer.invoke("setup:reset"),
  // FSUIPC7 es el requisito real para que se sincronice algo del iFly/PMDG (ver
  // detectFsuipc7 en main.cjs).
  checkFsuipc: () => ipcRenderer.invoke("setup:check-fsuipc"),
});
