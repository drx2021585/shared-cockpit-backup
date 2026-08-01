const { app, BrowserWindow, ipcMain, shell, dialog, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const crypto = require("node:crypto");
const express = require("express");
const { createServer } = require("node:http");
const { spawn, execFile } = require("node:child_process");
const { WebSocketServer, WebSocket } = require("ws");
const { autoUpdater } = require("electron-updater");
const { parse: parseYaml } = require("yaml");

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
ipcMain.handle("app:open-external", (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return false;
  }
  void shell.openExternal(url);
  return true;
});

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

async function getPublicNetworkAddresses() {
  let ipv4 = null;
  let ipv6 = null;

  try {
    const response = await fetch("https://api.ipify.org?format=json");
    const payload = await response.json();
    if (typeof payload?.ip === "string") {
      ipv4 = payload.ip;
    }
  } catch {}

  try {
    const response = await fetch("https://api64.ipify.org?format=json");
    const payload = await response.json();
    if (typeof payload?.ip === "string" && payload.ip.includes(":")) {
      ipv6 = payload.ip;
    }
  } catch {}

  return { ipv4, ipv6 };
}

ipcMain.handle("network:get-public-addresses", () => getPublicNetworkAddresses());

function getAppPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")).version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
}

// ---------------------------------------------------------------------------
// Relay directo embebido: host local en memoria para el flujo "port forward /
// self-hosted relay". Reutiliza el mismo contrato HTTP + WebSocket que consume
// la UI, pero vive dentro del proceso principal de Electron y no necesita
// PostgreSQL.
// ---------------------------------------------------------------------------

const DIRECT_HOST_DEFAULT_PORT = 25071;
const DIRECT_HOST_MAX_MESSAGE_SIZE = 64 * 1024;
const DIRECT_HOST_MAX_MESSAGES_PER_SECOND = 300;
const DIRECT_RELAY_TOKEN_BYTES = 32;
const DIRECT_JOIN_CODE_RE = /^[A-Z2-9]{3}-[A-Z2-9]{3}$/;
const DIRECT_FLOW_SEATS = new Set(["captain", "first_officer", "observer"]);
const DIRECT_FLIGHT_MESSAGE_TYPES = new Set([
  "control.event",
  "control.axis",
  "aircraft.snapshot",
  "flight.pose",
  "screen.snapshot",
  "authority.transfer",
]);

const DIRECT_LEVEL_SCORE = {
  full: 100,
  partial: 60,
  none: 0,
};

const DIRECT_SYSTEM_PREFIX_TO_CAPABILITY = {
  flight: "flightControls",
  flight_controls: "flightControls",
  gear: "flightControls",
  autopilot: "autopilot",
  autoflight: "autopilot",
  efis: "autopilot",
  fms: "autopilot",
  electrical: "electrical",
  apu: "electrical",
  hydraulics: "hydraulics",
  radios: "radios",
  comm: "radios",
  communications: "radios",
  mcdu: "mcdu",
  navigation: "mcdu",
  air: "air",
  anti_ice: "antiIce",
  engine: "engine",
  fuel: "fuel",
  fire_protection: "fireProtection",
  instruments: "instruments",
  warnings: "warnings",
  efb: "efb",
  misc: "cabinMisc",
  doors: "cabinMisc",
};

let directHostService = null;

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function directGenerateToken() {
  return crypto.randomBytes(DIRECT_RELAY_TOKEN_BYTES).toString("hex");
}

function directHashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function directGenerateJoinCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  const pick = (n, offset) =>
    Array.from({ length: n }, (_, index) => chars[bytes[offset + index] % chars.length]).join("");
  return `${pick(3, 0)}-${pick(3, 3)}`;
}

function directCreateEmptySessionState() {
  return {
    aircraftSnapshot: null,
    flightPose: null,
    authorityTransfer: null,
    controlEvents: new Map(),
    controlAxes: new Map(),
    screenSnapshots: new Map(),
  };
}

function directRememberMessage(cache, joinCode, msg) {
  let state = cache.get(joinCode);
  if (!state) {
    state = directCreateEmptySessionState();
    cache.set(joinCode, state);
  }
  switch (msg.type) {
    case "aircraft.snapshot":
      state.aircraftSnapshot = msg;
      break;
    case "flight.pose":
      state.flightPose = msg;
      break;
    case "authority.transfer":
      state.authorityTransfer = msg;
      break;
    case "control.event":
      if (typeof msg.controlId === "string") state.controlEvents.set(msg.controlId, msg);
      break;
    case "control.axis":
      if (typeof msg.controlId === "string") state.controlAxes.set(msg.controlId, msg);
      break;
    case "screen.snapshot":
      if (typeof msg.screenId === "string") state.screenSnapshots.set(msg.screenId, msg);
      break;
  }
}

function directReplayMessages(cache, joinCode) {
  const state = cache.get(joinCode);
  if (!state) return [];
  return [
    ...(state.aircraftSnapshot ? [state.aircraftSnapshot] : []),
    ...(state.authorityTransfer ? [state.authorityTransfer] : []),
    ...Array.from(state.controlEvents.values()),
    ...Array.from(state.controlAxes.values()),
    ...Array.from(state.screenSnapshots.values()),
    ...(state.flightPose ? [state.flightPose] : []),
  ];
}

function getBundledAircraftProfilesDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "aircraft-profiles");
  }
  return path.join(__dirname, "..", "..", "..", "aircraft-profiles");
}

function directReadProfileControls(profileDir) {
  const controlsDir = path.join(profileDir, "controls");
  if (!fs.existsSync(controlsDir)) return [];
  const controls = [];
  for (const file of fs.readdirSync(controlsDir)) {
    if (!file.endsWith(".yaml")) continue;
    const parsed = parseYaml(fs.readFileSync(path.join(controlsDir, file), "utf-8"));
    if (Array.isArray(parsed)) controls.push(...parsed);
  }
  return controls;
}

function directComputeCoverage(capabilities, controls) {
  const declaredLevels = Object.values(capabilities ?? {});
  if (declaredLevels.length === 0) return 0;

  const meanDeclaredCap =
    declaredLevels.reduce((sum, level) => sum + (DIRECT_LEVEL_SCORE[level] ?? 0), 0) /
    declaredLevels.length;

  if (controls.length === 0) return Math.round(meanDeclaredCap);

  const bySystem = new Map();
  for (const control of controls) {
    const prefix = String(control?.id ?? "").split(".")[0];
    const bucket = bySystem.get(prefix) ?? { total: 0, bidirectional: 0 };
    bucket.total += 1;
    if (control?.read && control?.write) bucket.bidirectional += 1;
    bySystem.set(prefix, bucket);
  }

  let weightedScore = 0;
  let totalWeight = 0;
  for (const [prefix, bucket] of bySystem) {
    const capabilityKey = DIRECT_SYSTEM_PREFIX_TO_CAPABILITY[prefix];
    const cap =
      capabilityKey && capabilities?.[capabilityKey] !== undefined
        ? DIRECT_LEVEL_SCORE[capabilities[capabilityKey]] ?? 0
        : meanDeclaredCap;
    const measured = (100 * bucket.bidirectional) / bucket.total;
    weightedScore += Math.min(measured, cap) * bucket.total;
    totalWeight += bucket.total;
  }

  return totalWeight > 0 ? Math.round(weightedScore / totalWeight) : Math.round(meanDeclaredCap);
}

function scanBundledAircraftProfiles() {
  const profilesDir = getBundledAircraftProfilesDir();
  if (!fs.existsSync(profilesDir)) return [];

  const profiles = [];
  for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const profileDir = path.join(profilesDir, entry.name);
    const manifestPath = path.join(profileDir, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = parseYaml(fs.readFileSync(manifestPath, "utf-8"));
    const controls = directReadProfileControls(profileDir);
    profiles.push({
      id: manifest.aircraft.id,
      name: manifest.aircraft.name,
      developer: manifest.aircraft.developer,
      version: manifest.versions?.tested?.[manifest.versions.tested.length - 1] ?? "unknown",
      availability: manifest.availability === "soon" ? "soon" : "released",
      coverage: directComputeCoverage(manifest.capabilities ?? {}, controls),
      capabilities: manifest.capabilities ?? {},
      compatibility: manifest.compatibility ?? { msfs2020: false, msfs2024: false },
      variants: Array.isArray(manifest.variants)
        ? manifest.variants.filter((value) => typeof value === "string")
        : [],
      verified: manifest.verification === "live-tested",
    });
  }

  return profiles.sort((left, right) => right.coverage - left.coverage);
}

function directBuildHealthPayload() {
  const version = getAppPackageVersion();
  return {
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    apiVersion: 1,
    minClientVersion: version,
    latestClientVersion: version,
  };
}

function directNormalizeVersion(version) {
  return String(version ?? "")
    .trim()
    .replace(/^v/i, "");
}

function directIsClientVersionSupported(version) {
  return directNormalizeVersion(version) === directNormalizeVersion(getAppPackageVersion());
}

function directValidateFlightMessage(msg) {
  if (typeof msg !== "object" || msg === null) return "not-an-object";
  const type = msg.type;
  if (typeof type !== "string") return "missing-type";

  const shortStr = (value, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max;
  const finiteNum = (value) => typeof value === "number" && Number.isFinite(value);

  switch (type) {
    case "control.event":
      if (!shortStr(msg.sessionId) || !shortStr(msg.controlId) || !shortStr(msg.source, 64)) return "invalid";
      if (!["boolean", "number", "string"].includes(typeof msg.value)) return "invalid";
      if (!finiteNum(msg.sequence) || !finiteNum(msg.timestamp)) return "invalid";
      return null;
    case "control.axis":
      if (!shortStr(msg.controlId) || !finiteNum(msg.value) || !finiteNum(msg.sequence) || !finiteNum(msg.timestamp)) return "invalid";
      return null;
    case "aircraft.snapshot":
      if (!finiteNum(msg.revision) || !shortStr(msg.profile) || typeof msg.systems !== "object" || msg.systems === null) return "invalid";
      return null;
    case "flight.pose":
      if (!shortStr(msg.sessionId) || !finiteNum(msg.sequence) || !finiteNum(msg.timestamp)) return "invalid";
      if (!finiteNum(msg.lat) || !finiteNum(msg.lon) || !finiteNum(msg.alt)) return "invalid";
      if (!finiteNum(msg.pitch) || !finiteNum(msg.bank) || !finiteNum(msg.heading)) return "invalid";
      if (!finiteNum(msg.groundSpeed) || !finiteNum(msg.indicatedAirspeed) || !finiteNum(msg.verticalSpeed)) return "invalid";
      return null;
    case "authority.transfer":
      if (!shortStr(msg.group) || !shortStr(msg.previousOwner, 64) || !shortStr(msg.newOwner, 64) || !finiteNum(msg.revision)) return "invalid";
      return null;
    case "screen.snapshot":
      if (!shortStr(msg.sessionId) || !shortStr(msg.screenId) || !finiteNum(msg.rows) || !finiteNum(msg.cols) || !Array.isArray(msg.cells) || !finiteNum(msg.revision)) return "invalid";
      return null;
    default:
      return "unknown-type";
  }
}

function createDirectHostService(port) {
  const appServer = express();
  const httpServer = createServer(appServer);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: DIRECT_HOST_MAX_MESSAGE_SIZE });
  const profiles = scanBundledAircraftProfiles();
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const sessions = new Map();
  const connections = new Map();
  const sessionStateCache = new Map();
  const startedAt = Date.now();

  function findSession(joinCode) {
    const session = sessions.get(joinCode);
    return session && !session.endedAt ? session : null;
  }

  function listParticipants(session) {
    return Array.from(session.participants.values())
      .filter((participant) => participant.disconnectedAt === null)
      .map((participant) => ({
        pilot_name: participant.pilotName,
        seat: participant.seat,
        joined_at: participant.joinedAt,
      }));
  }

  function buildSessionResponse(session) {
    return {
      id: session.id,
      joinCode: session.joinCode,
      sessionName: session.sessionName,
      aircraftProfileId: session.aircraftProfileId,
      status: session.status,
      sim: session.sim,
      hasPassword: !!session.password,
      creatorPilotName: session.creatorPilotName,
      controlOwner: session.controlOwner,
      controlRequestedBy: session.controlRequestedBy,
      controlRevision: session.controlRevision,
      participants: listParticipants(session),
    };
  }

  function authenticate(joinCode, token) {
    if (!token) return null;
    const session = findSession(joinCode);
    if (!session) return null;
    const tokenHash = directHashToken(token);
    for (const participant of session.participants.values()) {
      if (participant.tokenHash === tokenHash) {
        return { pilotName: participant.pilotName, seat: participant.seat };
      }
    }
    return null;
  }

  function broadcastSessionState(joinCode) {
    const session = findSession(joinCode);
    if (!session) return;
    const payload = JSON.stringify({ type: "session.state", session: buildSessionResponse(session) });
    for (const [ws, meta] of connections) {
      if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  function broadcastAuthorityTransfer(joinCode, transfer) {
    const outgoing = {
      type: "authority.transfer",
      sessionId: joinCode,
      group: "flight_controls",
      previousOwner: transfer.previousOwner,
      newOwner: transfer.newOwner,
      revision: transfer.revision,
    };
    directRememberMessage(sessionStateCache, joinCode, outgoing);
    const payload = JSON.stringify(outgoing);
    for (const [ws, meta] of connections) {
      if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  function relayFlightMessage(senderWs, joinCode, pilotName, msg) {
    const outgoing = { ...msg, origin: "remote", sourcePilot: pilotName };
    directRememberMessage(sessionStateCache, joinCode, outgoing);
    const payload = JSON.stringify(outgoing);
    for (const [ws, meta] of connections) {
      if (ws === senderWs) continue;
      if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  appServer.use(express.json({ limit: "16kb" }));
  appServer.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-WeConnect-Client-Version");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  appServer.use("/api", (req, res, next) => {
    if (req.path === "/health") {
      next();
      return;
    }
    const version = req.headers["x-weconnect-client-version"];
    if (!directIsClientVersionSupported(typeof version === "string" ? version : null)) {
      res.status(426).json({
        error: "client-update-required",
        ...directBuildHealthPayload(),
      });
      return;
    }
    next();
  });

  appServer.get("/api/health", (_req, res) => {
    const payload = directBuildHealthPayload();
    payload.uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
    res.json(payload);
  });

  appServer.get("/api/aircraft-profiles", (_req, res) => {
    res.json(profiles);
  });

  appServer.post("/api/sessions", (req, res) => {
    const sessionName = cleanText(req.body?.sessionName, 80);
    const aircraftProfileId = cleanText(req.body?.aircraftProfileId, 80);
    const hostPilotName = cleanText(req.body?.hostPilotName, 40);
    const hostSeat = req.body?.hostSeat;
    const sim = req.body?.sim;
    const password = typeof req.body?.password === "string" && req.body.password.length > 0 ? req.body.password : null;
    if (!sessionName || !aircraftProfileId || !hostPilotName || !DIRECT_FLOW_SEATS.has(hostSeat) || (sim !== "msfs2020" && sim !== "msfs2024")) {
      res.status(400).json({ error: "missing required fields" });
      return;
    }
    const profile = profilesById.get(aircraftProfileId);
    if (!profile || profile.availability === "soon" || !profile.compatibility?.[sim]) {
      res.status(400).json({ error: "unknown aircraft profile" });
      return;
    }
    let joinCode = directGenerateJoinCode();
    while (sessions.has(joinCode)) joinCode = directGenerateJoinCode();
    const participantToken = directGenerateToken();
    const participant = {
      pilotName: hostPilotName,
      seat: hostSeat,
      joinedAt: new Date().toISOString(),
      disconnectedAt: null,
      tokenHash: directHashToken(participantToken),
    };
    const session = {
      id: crypto.randomBytes(12).toString("hex"),
      joinCode,
      sessionName,
      aircraftProfileId,
      status: "waiting",
      sim,
      password,
      creatorPilotName: hostPilotName,
      controlOwner: hostSeat === "observer" ? "captain" : hostSeat,
      controlRequestedBy: null,
      controlRevision: 0,
      endedAt: null,
      participants: new Map([[hostPilotName, participant]]),
    };
    sessions.set(joinCode, session);
    res.status(201).json({ ...buildSessionResponse(session), participantToken });
  });

  appServer.get("/api/sessions/:code", (req, res) => {
    const joinCode = String(req.params.code ?? "").toUpperCase();
    if (!DIRECT_JOIN_CODE_RE.test(joinCode)) {
      res.status(404).json({ error: "session-not-found" });
      return;
    }
    const session = findSession(joinCode);
    if (!session) {
      res.status(404).json({ error: "session-not-found" });
      return;
    }
    res.json(buildSessionResponse(session));
  });

  appServer.post("/api/sessions/:code/join", (req, res) => {
    const joinCode = String(req.params.code ?? "").toUpperCase();
    const session = findSession(joinCode);
    if (!session) {
      res.status(404).json({ error: "session-not-found" });
      return;
    }
    const pilotName = cleanText(req.body?.pilotName, 40);
    const seat = req.body?.seat;
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!pilotName || !DIRECT_FLOW_SEATS.has(seat)) {
      res.status(400).json({ error: "missing required fields" });
      return;
    }
    if (session.password && session.password !== password) {
      res.status(409).json({ error: "invalid-password" });
      return;
    }
    const activeCount = Array.from(session.participants.values()).filter(
      (participant) => participant.disconnectedAt === null && participant.seat !== "observer"
    ).length;
    if (activeCount >= 2 && seat !== "observer") {
      res.status(409).json({ error: "session-full" });
      return;
    }
    const participantToken = directGenerateToken();
    session.participants.set(pilotName, {
      pilotName,
      seat,
      joinedAt: session.participants.get(pilotName)?.joinedAt ?? new Date().toISOString(),
      disconnectedAt: null,
      tokenHash: directHashToken(participantToken),
    });
    if (seat !== "observer" && activeCount + 1 >= 2) {
      session.status = "active";
    }
    res.json({ ...buildSessionResponse(session), participantToken });
  });

  function requireParticipant(req, res, next) {
    const joinCode = String(req.params.code ?? "").toUpperCase();
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+([a-f0-9]{64})$/i.exec(header.trim()) : null;
    const auth = authenticate(joinCode, match?.[1] ?? null);
    if (!auth) {
      res.status(401).json({ error: "invalid-token" });
      return;
    }
    req.weconnectAuth = auth;
    next();
  }

  appServer.delete("/api/sessions/:code", requireParticipant, (req, res) => {
    const joinCode = String(req.params.code ?? "").toUpperCase();
    const auth = req.weconnectAuth;
    const session = findSession(joinCode);
    if (!session) {
      res.status(404).json({ error: "session-not-found" });
      return;
    }
    if (session.creatorPilotName !== auth.pilotName) {
      res.status(403).json({ error: "not-session-creator" });
      return;
    }
    session.endedAt = new Date().toISOString();
    session.status = "ended";
    for (const [ws, meta] of connections) {
      if (meta.joinCode === joinCode) ws.close(4001, "session closed");
    }
    sessionStateCache.delete(joinCode);
    res.status(204).end();
  });

  appServer.post("/api/sessions/:code/leave", requireParticipant, (req, res) => {
    const joinCode = String(req.params.code ?? "").toUpperCase();
    const auth = req.weconnectAuth;
    const session = findSession(joinCode);
    const participant = session?.participants.get(auth.pilotName);
    if (!session || !participant) {
      res.status(404).json({ error: "session-not-found" });
      return;
    }
    participant.disconnectedAt = new Date().toISOString();
    participant.tokenHash = null;
    if (session.controlOwner === participant.seat) {
      const nextParticipant = Array.from(session.participants.values()).find(
        (candidate) => candidate.disconnectedAt === null && candidate.seat !== "observer" && candidate.pilotName !== participant.pilotName
      );
      session.controlOwner = nextParticipant?.seat ?? null;
      session.controlRequestedBy = null;
    }
    broadcastSessionState(joinCode);
    res.status(204).end();
  });

  appServer.post("/api/sessions/:code/request-controls", requireParticipant, (req, res) => {
    const joinCode = String(req.params.code ?? "").toUpperCase();
    const auth = req.weconnectAuth;
    const session = findSession(joinCode);
    if (!session || auth.seat === "observer" || session.controlOwner === auth.seat) {
      res.status(409).json({ error: "controls-request-not-allowed" });
      return;
    }
    session.controlRequestedBy = auth.seat;
    broadcastSessionState(joinCode);
    res.status(204).end();
  });

  appServer.post("/api/sessions/:code/give-controls", requireParticipant, (req, res) => {
    const joinCode = String(req.params.code ?? "").toUpperCase();
    const auth = req.weconnectAuth;
    const session = findSession(joinCode);
    if (!session || session.controlOwner !== auth.seat || !session.controlRequestedBy) {
      res.status(409).json({ error: "control-transfer-not-allowed" });
      return;
    }
    const previousOwner = session.controlOwner;
    session.controlOwner = session.controlRequestedBy;
    session.controlRequestedBy = null;
    session.controlRevision += 1;
    broadcastAuthorityTransfer(joinCode, {
      previousOwner,
      newOwner: session.controlOwner,
      revision: session.controlRevision,
    });
    broadcastSessionState(joinCode);
    res.status(204).end();
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const joinCode = (url.searchParams.get("code") ?? "").toUpperCase();
    const token = url.searchParams.get("token");
    const clientVersion = url.searchParams.get("clientVersion");
    if (!directIsClientVersionSupported(clientVersion)) {
      ws.close(4002, "client update required");
      return;
    }
    const auth = DIRECT_JOIN_CODE_RE.test(joinCode) ? authenticate(joinCode, token) : null;
    if (!auth) {
      ws.close(4000, "invalid session or token");
      return;
    }

    connections.set(ws, {
      joinCode,
      pilotName: auth.pilotName,
      seat: auth.seat,
      msgWindowStart: Date.now(),
      msgCount: 0,
    });

    const session = findSession(joinCode);
    if (session) {
      const participant = session.participants.get(auth.pilotName);
      if (participant) participant.disconnectedAt = null;
      broadcastSessionState(joinCode);
      for (const cached of directReplayMessages(sessionStateCache, joinCode)) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(JSON.stringify(cached));
      }
    }

    ws.on("message", (raw) => {
      const meta = connections.get(ws);
      if (!meta) return;
      const now = Date.now();
      if (now - meta.msgWindowStart >= 1000) {
        meta.msgWindowStart = now;
        meta.msgCount = 0;
      }
      meta.msgCount += 1;
      if (meta.msgCount > DIRECT_HOST_MAX_MESSAGES_PER_SECOND) return;

      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", clientSentAt: msg.clientSentAt, serverTime: Date.now() }));
          return;
        }
        if (!DIRECT_FLIGHT_MESSAGE_TYPES.has(msg.type)) return;
        const error = directValidateFlightMessage(msg);
        if (error) return;
        if (typeof msg.sessionId === "string" && msg.sessionId !== meta.joinCode) return;
        relayFlightMessage(ws, meta.joinCode, meta.pilotName, msg);
      } catch {
        return;
      }
    });

    ws.on("close", () => {
      const meta = connections.get(ws);
      connections.delete(ws);
      if (!meta) return;
      const session = findSession(meta.joinCode);
      const participant = session?.participants.get(meta.pilotName);
      if (participant) participant.disconnectedAt = new Date().toISOString();
      broadcastSessionState(meta.joinCode);
    });
  });

  return {
    port,
    async start() {
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, "0.0.0.0", () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });
      return {
        port,
        localIpv4: getLocalNetworkAddresses().ipv4,
        localIpv6: getLocalNetworkAddresses().ipv6,
        profiles: profiles.length,
      };
    },
    async stop() {
      for (const ws of connections.keys()) {
        try {
          ws.close();
        } catch {}
      }
      await new Promise((resolve) => {
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}

ipcMain.handle("relay:get-config", () => ({
  defaultPort: DIRECT_HOST_DEFAULT_PORT,
  running: !!directHostService,
  port: directHostService?.port ?? null,
  localAddresses: getLocalNetworkAddresses(),
}));

ipcMain.handle("relay:start-direct-host", async (_event, portValue) => {
  const requestedPort = Number(portValue);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
    ? requestedPort
    : DIRECT_HOST_DEFAULT_PORT;

  if (directHostService && directHostService.port === port) {
    return {
      ok: true,
      running: true,
      port,
      localAddresses: getLocalNetworkAddresses(),
    };
  }

  if (directHostService) {
    await directHostService.stop();
    directHostService = null;
  }

  const service = createDirectHostService(port);
  try {
    const started = await service.start();
    directHostService = service;
    return { ok: true, running: true, ...started };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), running: false };
  }
});

ipcMain.handle("relay:stop-direct-host", async () => {
  if (!directHostService) return { ok: true, running: false };
  await directHostService.stop();
  directHostService = null;
  return { ok: true, running: false };
});


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
let bridgeRestartTimer = null;
let appQuitting = false;

// Secreto efímero compartido entre esta app y el bridge local: se genera al
// lanzar el bridge, viaja como variable de entorno al proceso hijo y como
// ?token= en el WebSocket del renderer (ver preload "bridge:get-token" +
// bridgeClient.ts). Así, otro proceso local (o una página web apuntando a
// ws://localhost:7620) no puede inyectar comandos al simulador. Si el bridge
// ya estaba corriendo lanzado a mano (sin token), queda null y el bridge
// acepta sin token — compatibilidad con el flujo manual de desarrollo.
let bridgeToken = null;

// El token se persiste porque el bridge sobrevive a la ventana que lo lanzó.
// Cuando launchBridgeIfNeeded() encuentra el puerto ya ocupado se rendía y
// dejaba bridgeToken = null; a partir de ahí el renderer reconectaba SIN token,
// el bridge lo rechazaba ("token del bridge ausente o inválido"), el socket
// moría en <400ms y la UI lo mostraba como "Not running" para siempre. Guardar
// el token permite reengancharse al bridge que ya está corriendo en vez de
// quedar bloqueado. Vive en userData, que ya es un directorio solo del usuario.
function bridgeTokenFilePath() {
  return path.join(app.getPath("userData"), "bridge-token");
}

function persistBridgeToken(token) {
  try {
    fs.writeFileSync(bridgeTokenFilePath(), token, { encoding: "utf8", mode: 0o600 });
  } catch {
    // No crítico: sin el archivo se pierde solo la capacidad de reengancharse a
    // un bridge heredado; el flujo normal (lanzarlo nosotros) sigue igual.
  }
}

function readPersistedBridgeToken() {
  try {
    return fs.readFileSync(bridgeTokenFilePath(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

ipcMain.handle("bridge:get-token", async () => {
  if (appQuitting || bridgeProcess) {
    return bridgeToken;
  }
  if (await isBridgePortOpen()) {
    // Bridge heredado: sigue vivo de una ventana anterior de la app (o lanzado
    // a mano). No se relanza -- fallaría al bindear -- pero SÍ hay que recuperar
    // el token con el que arrancó, o cada reconexión sería rechazada.
    if (!bridgeToken) {
      bridgeToken = readPersistedBridgeToken();
    }
    return bridgeToken;
  }
  await launchBridgeIfNeeded();
  return bridgeToken;
});

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
    // al intentar bindear el mismo puerto. Se recupera el token con el que se
    // lanzó para poder reengancharse; si no hay archivo (bridge lanzado a mano
    // en desarrollo) queda null, que es justo lo que ese bridge espera.
    bridgeToken = readPersistedBridgeToken();
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
  persistBridgeToken(bridgeToken);

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
    bridgeToken = null;
    scheduleBridgeRestart();
  });
  bridgeProcess.on("error", (err) => {
    console.warn(`[bridge] no se pudo lanzar: ${err?.message ?? err}`);
    bridgeProcess = null;
    bridgeToken = null;
    scheduleBridgeRestart();
  });
}

// Nombre del proceso tal como lo ve Windows -- se mata POR NOMBRE, nunca por
// "quién tiene el puerto 7620". El bridge sirve el WebSocket con HttpListener,
// que es http.sys en modo kernel: el LISTENING de ese puerto siempre aparece a
// nombre del PID 4 (System), así que buscar al dueño del puerto y matarlo
// apuntaría al kernel, no al bridge.
const BRIDGE_PROCESS_NAME = "SharedCockpit.Bridge.exe";
let bridgeReplaceInFlight = false;

function killBridgeProcesses() {
  return new Promise((resolve) => {
    execFile("taskkill", ["/F", "/IM", BRIDGE_PROCESS_NAME], { windowsHide: true }, (err) => {
      // err también aparece cuando no había ningún proceso vivo ("not found"),
      // que para nuestro propósito es exactamente el estado deseado.
      resolve(!err);
    });
  });
}

/** Espera a que http.sys libere el puerto tras matar al bridge que lo tenía. */
async function waitForBridgePortClosed(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isBridgePortOpen())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// launchBridgeIfNeeded() se rinde si el puerto ya está ocupado, para no pelear
// con un bridge lanzado a mano. El efecto secundario es que un bridge VIEJO
// squatteando el 7620 dejaba a la app pegada a él para siempre: la UI mostraba
// "BRIDGE UPDATE REQUIRED" y el único arreglo era abrir el Task Manager. Este
// handler es la salida en la app: mata cualquier bridge (nuestro o ajeno) y
// levanta el empaquetado, que sí trae la API que esta versión exige.
ipcMain.handle("bridge:replace-stale", async () => {
  if (process.platform !== "win32") {
    return { ok: false, reason: "unsupported-platform" };
  }
  if (bridgeReplaceInFlight) {
    return { ok: false, reason: "already-in-progress" };
  }
  const exePath = getBridgeExecutablePath();
  if (!fs.existsSync(exePath)) {
    return { ok: false, reason: "bundled-bridge-missing" };
  }

  bridgeReplaceInFlight = true;
  try {
    clearBridgeRestartTimer();
    if (bridgeProcess && !bridgeProcess.killed) {
      bridgeProcess.kill();
    }
    bridgeProcess = null;
    bridgeToken = null;

    await killBridgeProcesses();
    if (!(await waitForBridgePortClosed(5000))) {
      return { ok: false, reason: "port-still-busy" };
    }

    await launchBridgeIfNeeded();
    return bridgeProcess
      ? { ok: true, reason: "restarted" }
      : { ok: false, reason: "launch-failed" };
  } finally {
    bridgeReplaceInFlight = false;
  }
});

function clearBridgeRestartTimer() {
  if (bridgeRestartTimer) {
    clearTimeout(bridgeRestartTimer);
    bridgeRestartTimer = null;
  }
}

function scheduleBridgeRestart() {
  if (appQuitting || bridgeProcess) {
    return;
  }

  clearBridgeRestartTimer();
  bridgeRestartTimer = setTimeout(() => {
    bridgeRestartTimer = null;
    if (!appQuitting) {
      launchBridgeIfNeeded();
    }
  }, 1000);
}

function stopBridge() {
  appQuitting = true;
  clearBridgeRestartTimer();
  if (bridgeProcess && !bridgeProcess.killed) {
    bridgeProcess.kill();
  }
  bridgeProcess = null;
  bridgeToken = null;
  bridgeLogStream?.end();
  bridgeLogStream = null;
}

async function stopDirectHost() {
  if (!directHostService) return;
  await directHostService.stop();
  directHostService = null;
}

app.on("before-quit", () => {
  stopBridge();
  void stopDirectHost();
});

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
