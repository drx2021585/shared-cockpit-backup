const { app, BrowserWindow, ipcMain, shell, dialog, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { autoUpdater } = require("electron-updater");

// La app apunta al backend compartido en Railway por defecto (ver
// src/lib/apiClient.ts) — ya no levanta un server/api local embebido. Un
// server local por máquina no sirve para que dos pilotos en computadoras
// distintas se conecten entre sí, porque el relay de WebSocket solo conecta
// sockets dentro del mismo proceso (ver docs/decisiones/postgres-shared-backend.md).

let mainWindow = null;
let lastUpdaterEvent = null;
let startupUpdateCheckInFlight = false;

// autoDownload=false: el usuario confirma la descarga desde el modal
// (UpdateModal.tsx) — mismo flujo que ya existía, ahora con datos reales en
// vez de simulados. Ver docs/decisiones/postgres-shared-backend.md y el
// build.publish de package.json (GitHub Releases, mismo repo del .exe).
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = console;

function sendUpdaterEvent(payload) {
  lastUpdaterEvent = payload;
  mainWindow?.webContents.send("updater:event", payload);
}

function runStartupUpdateCheck() {
  if (!app.isPackaged || startupUpdateCheckInFlight) return;
  startupUpdateCheckInFlight = true;
  autoUpdater
    .checkForUpdates()
    .catch((err) => sendUpdaterEvent({ status: "error", message: String(err) }))
    .finally(() => {
      startupUpdateCheckInFlight = false;
    });
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
ipcMain.handle("app:open-install-folder", () => shell.openPath(path.dirname(app.getPath("exe"))));

// Reinicio real de la app (no solo cerrar el modal) -- usado por
// FirstLaunchSetup.tsx tras "Launch We Connect", para que la app arranque de
// nuevo limpia (relee config, reconecta bridge/sesión desde cero) en vez de
// seguir corriendo con el estado que tenía mientras corría el asistente.
ipcMain.handle("app:restart", () => {
  app.relaunch();
  app.exit(0);
});

// Controles de ventana propios (ver frame: false arriba) -- reemplazan los
// botones nativos de minimizar/maximizar/cerrar de Windows por los 3 puntos
// de la barra de título custom (TitleBar.tsx).
ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow?.close());
ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);

/**
 * Direcciones IP REALES de esta máquina. La UI antes consultaba ipify desde el
 * renderer, lo que devolvía la IP pública (o fallaba por red/CORS) en vez de la
 * IPv4/IPv6 reales de la interfaz local que el usuario espera ver en "Network".
 */
function getLocalNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  let ipv4 = null;
  let ipv6 = null;

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) continue;

      if (!ipv4 && entry.family === "IPv4") {
        ipv4 = entry.address;
        continue;
      }

      if (!ipv6 && entry.family === "IPv6") {
        // Link-local (fe80::/10) y direcciones con zone id no son útiles para
        // mostrar como "tu IPv6" en esta UI.
        if (!entry.address.toLowerCase().startsWith("fe80:")) {
          ipv6 = entry.address.split("%")[0];
        }
      }

      if (ipv4 && ipv6) {
        return { ipv4, ipv6 };
      }
    }
  }

  return { ipv4, ipv6 };
}

ipcMain.handle("network:get-local-addresses", () => getLocalNetworkAddresses());

// ---------------------------------------------------------------------------
// Asistente de primer inicio: pide la carpeta Community de MSFS e instala ahí
// los paquetes reales que necesita We Connect (hoy: simulator/wasm-bridge,
// ver ese README para qué hace y por qué existe). La config persiste en un
// JSON simple en userData -- no hace falta una dependencia como
// electron-store para dos campos.
// ---------------------------------------------------------------------------

const SETUP_CONFIG_FILENAME = "we-connect-setup.json";
const INSTALLED_PACKAGE_FOLDER_NAME = "WeConnect";

function getSetupConfigPath() {
  return path.join(app.getPath("userData"), SETUP_CONFIG_FILENAME);
}

function readSetupConfig() {
  try {
    const raw = fs.readFileSync(getSetupConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      firstLaunchCompleted: parsed.firstLaunchCompleted === true,
      communityPath: typeof parsed.communityPath === "string" ? parsed.communityPath : null,
      // Versión del paquete que se copió a Community la última vez. Ver
      // getBundledPackageVersion para por qué hace falta.
      installedPackageVersion:
        typeof parsed.installedPackageVersion === "string" ? parsed.installedPackageVersion : null,
      // Huella del contenido REAL del paquete (manifest/layout/wasm y cualquier
      // archivo futuro). Es la comparación más fiable para decidir si hay que
      // reinstalar Community: el .wasm puede cambiar sin que alguien recuerde
      // subir package_version.
      installedPackageFingerprint:
        typeof parsed.installedPackageFingerprint === "string" ? parsed.installedPackageFingerprint : null,
    };
  } catch {
    // No existe todavía (primer inicio real) o está corrupto -- se trata
    // igual que "nunca configurado", nunca se crashea por esto.
    return {
      firstLaunchCompleted: false,
      communityPath: null,
      installedPackageVersion: null,
      installedPackageFingerprint: null,
    };
  }
}

/**
 * package_version del paquete que trae ESTE build de la app. Null si no se puede
 * leer (no debería pasar, pero no vale crashear el arranque por esto).
 */
function getBundledPackageVersion() {
  try {
    const manifestPath = path.join(getBundledCommunityPackagesDir(), "manifest.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return typeof parsed.package_version === "string" ? parsed.package_version : null;
  } catch {
    return null;
  }
}

function hashDirectoryTree(rootDir) {
  const hash = crypto.createHash("sha256");

  function walk(currentDir, prefix = "") {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      hash.update(rel);
      if (entry.isDirectory()) {
        hash.update("dir");
        walk(abs, rel);
      } else {
        hash.update("file");
        hash.update(fs.readFileSync(abs));
      }
    }
  }

  walk(rootDir);
  return hash.digest("hex");
}

function getBundledPackageFingerprint() {
  try {
    return hashDirectoryTree(getBundledCommunityPackagesDir());
  } catch {
    return null;
  }
}

function getInstalledPackageFingerprint(communityPath) {
  try {
    const destination = path.join(communityPath, INSTALLED_PACKAGE_FOLDER_NAME);
    if (!fs.existsSync(destination)) {
      return null;
    }
    return hashDirectoryTree(destination);
  } catch {
    return null;
  }
}

function writeSetupConfig(partial) {
  const current = readSetupConfig();
  const next = { ...current, ...partial };
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(getSetupConfigPath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/**
 * Carpeta de origen de los paquetes que se copian a Community. En desarrollo
 * (no empaquetado) apunta directo al monorepo; empaquetado, a los
 * extraResources declarados en package.json "build.extraResources".
 */
function getBundledCommunityPackagesDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "community-packages", "WeConnectBridge");
  }
  return path.join(__dirname, "..", "..", "..", "simulator", "wasm-bridge", "PackageSources");
}

/**
 * Validación de la carpeta Community elegida por el usuario. No hay forma
 * 100% confiable de confirmar "esto es Community de verdad" sin que MSFS
 * exponga esa info -- el heurístico usado (nombre de carpeta "Community", o
 * que ya contenga al menos un addon real con manifest.json) es el mismo tipo
 * de señal que usan otros instaladores de addons de MSFS.
 */
function validateCommunityFolder(folderPath) {
  if (!folderPath || typeof folderPath !== "string") {
    return { ok: false, error: "No folder was provided." };
  }

  let stat;
  try {
    stat = fs.statSync(folderPath);
  } catch {
    return { ok: false, error: "That path does not exist." };
  }

  if (!stat.isDirectory()) {
    return { ok: false, error: "That path is not a folder." };
  }

  try {
    fs.accessSync(folderPath, fs.constants.W_OK);
  } catch {
    return { ok: false, error: "We Connect doesn't have write permission for that folder." };
  }

  const looksLikeCommunityByName = path.basename(folderPath).toLowerCase() === "community";
  let containsAtLeastOnePackage = false;
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    containsAtLeastOnePackage = entries.some(
      (entry) => entry.isDirectory() && fs.existsSync(path.join(folderPath, entry.name, "manifest.json")),
    );
  } catch {
    containsAtLeastOnePackage = false;
  }

  if (!looksLikeCommunityByName && !containsAtLeastOnePackage) {
    return {
      ok: false,
      error:
        "This doesn't look like an MSFS Community folder. Pick the \"Community\" folder inside your " +
        "Microsoft Flight Simulator Packages folder (it usually already contains other add-on folders).",
    };
  }

  return { ok: true };
}

ipcMain.handle("setup:get-config", () => readSetupConfig());

ipcMain.handle("setup:choose-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select your MSFS Community folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("setup:validate-folder", (_event, folderPath) => validateCommunityFolder(folderPath));

ipcMain.handle("setup:install-packages", (_event, folderPath) => {
  const validation = validateCommunityFolder(folderPath);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const source = getBundledCommunityPackagesDir();
  const destination = path.join(folderPath, INSTALLED_PACKAGE_FOLDER_NAME);

  if (!fs.existsSync(source)) {
    return { ok: false, error: `Bundled package not found at ${source}. Reinstall We Connect.` };
  }

  try {
    // Se BORRA el destino antes de copiar. cpSync con force:true sobreescribe lo
    // que coincide, pero deja intacto lo que ya no existe en el paquete nuevo: si
    // una versión futura quita un archivo, el viejo se queda en Community y
    // layout.json deja de coincidir con lo que hay en disco -- que es justo la
    // señal por la que MSFS descarta un paquete.
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Could not copy files: ${err?.message ?? String(err)}` };
  }

  // Verificar que la copia llegó de verdad, en vez de confiar en que cpSync no
  // lanzó. Un antivirus o una carpeta sincronizada pueden dejar el destino a
  // medias sin producir excepción.
  const installedManifest = path.join(destination, "manifest.json");
  if (!fs.existsSync(installedManifest)) {
    return {
      ok: false,
      error: `The package was copied but ${installedManifest} is missing. Check your antivirus or folder permissions.`,
    };
  }

  return {
    ok: true,
    version: getBundledPackageVersion(),
    fingerprint: getBundledPackageFingerprint(),
  };
});

ipcMain.handle("setup:mark-completed", (_event, communityPath) =>
  writeSetupConfig({
    firstLaunchCompleted: true,
    communityPath,
    installedPackageVersion: getBundledPackageVersion(),
    installedPackageFingerprint: getBundledPackageFingerprint(),
  }),
);

/**
 * Reinstala el paquete en silencio si el bundle trae una versión distinta de la
 * que se copió la última vez.
 *
 * Sin esto, `firstLaunchCompleted: true` congelaba el paquete PARA SIEMPRE: se
 * copiaba en el primer arranque y ninguna corrección posterior al módulo WASM
 * llegaba nunca a alguien que ya hubiera instalado la app. El asistente solo
 * vuelve a aparecer si nunca se completó, así que no había ninguna otra vía.
 *
 * Es silencioso a propósito: el usuario ya eligió su carpeta Community y ya
 * aceptó que instalemos ahí; volver a preguntárselo en cada actualización sería
 * ruido. Si falla, se loggea y la app arranca igual -- el paquete viejo sigue
 * siendo el que estaba, no se queda sin nada.
 *
 * NUNCA en el arranque síncrono. Las operaciones de fs son bloqueantes y esto
 * corre en el proceso principal, que es el mismo que atiende el IPC del
 * renderer (setup:get-config, setup:check-fsuipc...). Borrar y copiar una carpeta
 * dentro de Community puede tardar bastante más de lo que sugiere su tamaño
 * -- carpeta vigilada por el antivirus, disco lento, MSFS con archivos abiertos
 * --, y mientras dure, la UI se queda esperando sus respuestas de IPC y los
 * botones parecen no responder. Se agenda fuera del camino crítico.
 */
function reinstallCommunityPackageIfOutdated() {
  const config = readSetupConfig();
  if (!config.firstLaunchCompleted || !config.communityPath) {
    return; // el asistente se encargará
  }

  const bundled = getBundledPackageVersion();
  const bundledFingerprint = getBundledPackageFingerprint();
  const installedFingerprint = getInstalledPackageFingerprint(config.communityPath);
  if (
    bundledFingerprint &&
    installedFingerprint &&
    bundledFingerprint === installedFingerprint
  ) {
    return;
  }

  const source = getBundledCommunityPackagesDir();
  const destination = path.join(config.communityPath, INSTALLED_PACKAGE_FOLDER_NAME);

  try {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true });
    if (!fs.existsSync(path.join(destination, "manifest.json"))) {
      throw new Error("manifest.json missing after copy");
    }
    writeSetupConfig({
      installedPackageVersion: bundled,
      installedPackageFingerprint: bundledFingerprint,
    });
    console.log(
      `[setup] Community package updated ${config.installedPackageVersion ?? "(unknown)"} -> ${bundled ?? "(unknown)"} at ${destination}`,
    );
  } catch (err) {
    console.error(`[setup] Could not update the Community package: ${err?.message ?? String(err)}`);
  }
}

/**
 * FSUIPC7 es el requisito REAL para que se sincronice cualquier cosa del iFly 737
 * MAX 8 y del PMDG: todas sus lecturas y escrituras pasan por su WAPI (ver
 * apps/simulator-bridge/src/SimulatorBridge/SimConnectInterop/FsuipcLVarClient.cs).
 * El asistente pedía la carpeta Community -- para un paquete que hoy no hace nada
 * -- y no comprobaba esto, que es la causa más probable de "no se sincroniza
 * nada" en la máquina del otro jugador.
 *
 * Se comprueba la INSTALACIÓN, no que esté corriendo: en el primer inicio MSFS
 * normalmente está cerrado, y exigir que esté arriba haría el chequeo inútil.
 */
const FSUIPC_CANDIDATE_DIRS = ["C:\\FSUIPC7", "C:\\Program Files\\FSUIPC7"];

function detectFsuipc7() {
  for (const dir of FSUIPC_CANDIDATE_DIRS) {
    const exe = path.join(dir, "FSUIPC7.exe");
    if (fs.existsSync(exe)) {
      // FSUIPC_WAPID.dll es el que expone las L-Vars; sin él, FSUIPC7 corre pero
      // el bridge no puede leer ni escribir nada de la cabina.
      const wapi = path.join(dir, "Utils", "FSUIPC_WAPID.dll");
      return { installed: true, path: dir, wapiPresent: fs.existsSync(wapi) };
    }
  }
  return { installed: false, path: null, wapiPresent: false };
}

ipcMain.handle("setup:check-fsuipc", () => detectFsuipc7());

ipcMain.handle("setup:reset", () => writeSetupConfig({ firstLaunchCompleted: false }));

// ---------------------------------------------------------------------------
// apps/simulator-bridge embebido: hasta ahora había que correrlo a mano en
// una consola aparte (dotnet run / el .exe suelto) para que los switches se
// sincronizaran entre pilotos -- si uno de los dos no lo tenía corriendo, su
// lado nunca detectaba el avión ni podía escribir nada, aunque la app We
// Connect pareciera "conectada" (esa parte solo cubre sesión/red). Se
// publica como .exe self-contained (ver apps/simulator-bridge/README.md +
// package.json "build.extraResources") y se lanza solo al abrir la app.
// ---------------------------------------------------------------------------

const BRIDGE_PORT = 7620; // debe coincidir con Program.cs
let bridgeProcess = null;
let bridgeLogStream = null;

// Secreto efímero compartido entre esta app y el bridge local: se genera al
// lanzar el bridge, viaja como variable de entorno al proceso hijo y como
// ?token= en el WebSocket del renderer (ver preload "bridge:get-token" +
// bridgeClient.ts). Así, otro proceso local (o una página web apuntando a
// ws://localhost:7620) no puede inyectar comandos al simulador. Si el bridge
// ya estaba corriendo lanzado a mano (sin token), queda null y el bridge
// acepta sin token — compatibilidad con el flujo manual de desarrollo.
let bridgeToken = null;

ipcMain.handle("bridge:get-token", () => bridgeToken);

function getBridgeExecutablePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bridge", "SharedCockpit.Bridge.exe");
  }
  return path.join(
    __dirname, "..", "..", "simulator-bridge", "src", "SimulatorBridge", "publish", "SharedCockpit.Bridge.exe",
  );
}

function getBridgeProfilesDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "aircraft-profiles");
  }
  // En desarrollo el propio bridge ya sabe subir desde el monorepo
  // (ProfileRepository.DiscoverRoot) -- no hace falta forzar la ruta.
  return null;
}

/** true si ya hay algo escuchando en BRIDGE_PORT (bridge ya corriendo, a mano o de un lanzamiento previo). */
function isBridgePortOpen() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: BRIDGE_PORT, host: "127.0.0.1" });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

async function launchBridgeIfNeeded() {
  if (await isBridgePortOpen()) {
    // Ya hay un bridge respondiendo en ese puerto (corrido a mano, o de un
    // segundo intento de arranque) -- no lanzar un segundo proceso, fallaría
    // al intentar bindear el mismo puerto.
    return;
  }

  const exePath = getBridgeExecutablePath();
  if (!fs.existsSync(exePath)) {
    console.warn(`[bridge] no se encontró el ejecutable en ${exePath} -- no se lanza automáticamente.`);
    return;
  }

  const profilesDir = getBridgeProfilesDir();
  const env = { ...process.env };
  if (profilesDir) env.SHAREDCOCKPIT_PROFILES_DIR = profilesDir;
  bridgeToken = crypto.randomBytes(32).toString("hex");
  env.SHAREDCOCKPIT_BRIDGE_TOKEN = bridgeToken;

  try {
    bridgeLogStream = fs.createWriteStream(path.join(app.getPath("userData"), "bridge.log"), { flags: "a" });
  } catch {
    bridgeLogStream = null; // no crítico -- el bridge sigue funcionando sin log a archivo
  }

  bridgeProcess = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    env,
    windowsHide: true,
  });

  bridgeProcess.stdout?.on("data", (chunk) => bridgeLogStream?.write(chunk));
  bridgeProcess.stderr?.on("data", (chunk) => bridgeLogStream?.write(chunk));
  bridgeProcess.on("exit", (code, signal) => {
    console.warn(`[bridge] proceso terminado (code=${code}, signal=${signal}).`);
    bridgeProcess = null;
  });
  bridgeProcess.on("error", (err) => {
    console.warn(`[bridge] no se pudo lanzar: ${err?.message ?? err}`);
    bridgeProcess = null;
  });
}

function stopBridge() {
  if (bridgeProcess && !bridgeProcess.killed) {
    bridgeProcess.kill();
  }
  bridgeProcess = null;
  bridgeLogStream?.end();
  bridgeLogStream = null;
}

app.on("before-quit", stopBridge);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    // Ícono de la ventana en ejecución (barra de tareas / Alt+Tab). Sin esto
    // Windows muestra el ícono genérico de Electron ahí. Usa el mismo
    // app-icon.ico que el .exe y el instalador (ver build.win.icon y
    // build.nsis en package.json) en vez del PNG del lockup completo: ese
    // logo es blanco sobre transparente y trae el texto "WeConnect / Two
    // pilots - One cockpit", que a 32px queda invisible sobre una barra de
    // tareas clara e ilegible en cualquier caso. app-icon.ico es el
    // monograma VC sobre cuadrado oscuro, y trae 7 resoluciones (16..256)
    // para que Windows no tenga que reescalar. Se regenera con
    // tools/make_app_icon.ps1.
    icon: path.join(__dirname, "..", "logos", "app-icon.ico"),
    // Sin marco nativo de Windows (sin la X/cuadrado/guion de Windows) -- la
    // barra de título la dibuja la propia UI (ver src/components/TitleBar.tsx),
    // estilo macOS (3 puntos de color a la izquierda). Los botones de esa
    // barra llaman a los handlers de abajo vía IPC para minimizar/maximizar/
    // cerrar la ventana real.
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:state", { maximized: true }));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:state", { maximized: false }));
  mainWindow.webContents.on("did-finish-load", () => {
    if (lastUpdaterEvent) {
      mainWindow?.webContents.send("updater:event", lastUpdaterEvent);
    }
    runStartupUpdateCheck();
  });

  const devServerUrl = process.env.ELECTRON_START_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// ---------------------------------------------------------------------------
// Endurecimiento del renderer: la UI es una SPA local que nunca navega a
// otros documentos ni abre ventanas — cualquier intento de hacerlo (p.ej. un
// enlace inyectado en un nombre de sesión) se bloquea; los https legítimos se
// abren en el navegador del sistema, nunca dentro de la app.
// ---------------------------------------------------------------------------

function isAllowedNavigation(url) {
  if (url.startsWith("file://")) return true;
  const devServerUrl = process.env.ELECTRON_START_URL;
  return Boolean(devServerUrl && url.startsWith(devServerUrl));
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
});

app.whenReady().then(() => {
  // La app no usa cámara, micrófono, geolocalización, notificaciones ni
  // ningún otro permiso del navegador — se niega todo por defecto.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  createWindow();
  launchBridgeIfNeeded();

  // Reemplazo del paquete de Community, FUERA del camino crítico de arranque: son
  // operaciones de fs bloqueantes y este es el hilo que atiende el IPC del
  // renderer (ver la nota en reinstallCommunityPackageIfOutdated). MSFS no puede
  // haber cargado un avión en los primeros segundos de vida de la app, así que no
  // hay ninguna prisa por hacerlo antes.
  setTimeout(reinstallCommunityPackageIfOutdated, 3000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
