const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const SERVER_PORT = 8787;
let serverProcess = null;
let mainWindow = null;

// Log mínimo de arranque, en una ruta fija (no depende de app.getPath, que
// puede no estar disponible antes de 'ready') — solo para poder diagnosticar
// un server embebido que no levantó, sin volverse un logger verboso general.
const startupLogPath = path.join(process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp", "weconnect-startup.log");
function logStartupIssue(line) {
  try {
    fs.appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // no-op
  }
}
process.on("uncaughtException", (err) => logStartupIssue(`uncaughtException: ${err && err.stack}`));

function resolveServerLaunch() {
  if (app.isPackaged) {
    // Empaquetado: Node portátil + código de server/api + aircraft-profiles,
    // copiados por electron-builder (ver "extraResources" en package.json)
    // manteniendo la misma estructura relativa que profiles.ts/db.ts esperan
    // (server/api/src, con aircraft-profiles como hermano de server/).
    const base = path.join(process.resourcesPath, "app-data");
    return {
      nodeBin: path.join(base, "node", "node.exe"),
      serverEntry: path.join(base, "server", "api", "src", "server.ts"),
      cwd: path.join(base, "server", "api"),
    };
  }
  // Desarrollo: usa el código fuente real del repo y el Node del sistema.
  const repoRoot = path.join(__dirname, "..", "..", "..");
  return {
    nodeBin: "node",
    serverEntry: path.join(repoRoot, "server", "api", "src", "server.ts"),
    cwd: path.join(repoRoot, "server", "api"),
  };
}

function startBundledServer() {
  const { nodeBin, serverEntry, cwd } = resolveServerLaunch();
  try {
    serverProcess = spawn(nodeBin, ["--experimental-strip-types", "--experimental-sqlite", serverEntry], {
      cwd,
      env: { ...process.env, PORT: String(SERVER_PORT) },
      windowsHide: true,
    });
  } catch (err) {
    logStartupIssue(`spawn threw: ${err && err.stack}`);
    return;
  }

  serverProcess.on("error", (err) => logStartupIssue(`server spawn error: ${err && err.stack}`));
  serverProcess.stderr?.on("data", (chunk) => logStartupIssue(`server stderr: ${chunk}`.trimEnd()));
  serverProcess.on("exit", (code, signal) => {
    if (code !== 0) logStartupIssue(`server exited unexpectedly code=${code} signal=${signal}`);
    serverProcess = null;
  });
}

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const tryOnce = () => {
      const req = http.get({ host: "localhost", port: SERVER_PORT, path: "/api/health", timeout: 800 }, (res) => {
        res.resume();
        resolvePromise(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) return resolvePromise(false);
        setTimeout(tryOnce, 300);
      });
      req.on("timeout", () => req.destroy());
    };
    tryOnce();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
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
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  // Si ya hay un server/api corriendo (ej. desarrollo con `npm run dev` en
  // server/api), no intenta levantar uno propio ni pisa ese puerto.
  const alreadyRunning = await waitForServer(500);
  if (!alreadyRunning) {
    startBundledServer();
    // La primera ejecución del Node portátil empaquetado puede tardar bastante
    // más de lo normal en Windows (Defender/antivirus escaneando un binario
    // nuevo sin firmar) — se le da margen generoso antes de mostrar la
    // ventana, para no mostrar el error de "no se pudo conectar" de entrada.
    const ok = await waitForServer(45000);
    if (!ok) logStartupIssue("bundled server did not become ready within 45s");
  }

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});
