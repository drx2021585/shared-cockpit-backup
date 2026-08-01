"use strict";

const express = require("express");
const { createServer } = require("node:http");
const { randomBytes } = require("node:crypto");
const { execFile } = require("node:child_process");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");
const { parse: parseYaml } = require("yaml");

const SESSION_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// Mismo puerto por defecto que usa YourControls, para que quien ya tenga
// abierto o reenviado ese puerto no tenga que tocar el router otra vez. Es
// configurable desde Ajustes: los dos jugadores tienen que usar el mismo.
const DEFAULT_PORT = 25071;
const SERVER_API_VERSION = 1;
const FLIGHT_MESSAGE_TYPES = new Set([
  "control.event",
  "control.axis",
  "aircraft.snapshot",
  "flight.pose",
  "screen.snapshot",
  "authority.transfer",
]);

function parseVersion(version) {
  if (typeof version !== "string") return null;
  const normalized = version.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+){0,2}$/.test(normalized)) return null;
  return normalized.split(".").map((part) => Number(part));
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Piso de protocolo del direct host. NO es la version del anfitrion: si lo
// fuera, cada release dejaria fuera al invitado que va un parche atras, aunque
// hablen exactamente el mismo protocolo. Solo se sube cuando cambia de verdad
// el formato de los mensajes.
const DIRECT_MIN_CLIENT_VERSION = "0.1.48";

function buildHealthPayload(latestVersion) {
  return {
    status: "ok",
    uptimeSeconds: process.uptime(),
    apiVersion: SERVER_API_VERSION,
    minClientVersion: DIRECT_MIN_CLIENT_VERSION,
    latestClientVersion: latestVersion,
  };
}

const LEVEL_SCORE = {
  full: 100,
  partial: 60,
  none: 0,
};

const SYSTEM_PREFIX_TO_CAPABILITY = {
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

function readProfileControls(profileDir) {
  const controlsDir = path.join(profileDir, "controls");
  if (!existsSync(controlsDir)) return [];

  const controls = [];
  for (const file of readdirSync(controlsDir)) {
    if (!file.endsWith(".yaml")) continue;
    const parsed = parseYaml(readFileSync(path.join(controlsDir, file), "utf-8"));
    if (Array.isArray(parsed)) controls.push(...parsed);
  }
  return controls;
}

function computeCoverage(capabilities, controls) {
  const declaredLevels = Object.values(capabilities ?? {});
  if (declaredLevels.length === 0) return 0;

  const meanDeclaredCap =
    declaredLevels.reduce((sum, level) => sum + (LEVEL_SCORE[level] ?? 0), 0) / declaredLevels.length;

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
    const capabilityKey = SYSTEM_PREFIX_TO_CAPABILITY[prefix];
    const cap =
      capabilityKey && capabilities?.[capabilityKey] !== undefined
        ? LEVEL_SCORE[capabilities[capabilityKey]] ?? 0
        : meanDeclaredCap;
    const measured = (100 * bucket.bidirectional) / bucket.total;
    weightedScore += Math.min(measured, cap) * bucket.total;
    totalWeight += bucket.total;
  }

  return Math.round(weightedScore / totalWeight);
}

function scanAircraftProfiles(profilesDir) {
  if (!existsSync(profilesDir)) return [];

  const profiles = [];
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(profilesDir, entry.name, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;

    const manifest = parseYaml(readFileSync(manifestPath, "utf-8"));
    const controls = readProfileControls(path.join(profilesDir, entry.name));
    profiles.push({
      id: manifest.aircraft.id,
      name: manifest.aircraft.name,
      developer: manifest.aircraft.developer,
      schemaVersion: manifest.schemaVersion,
      version: manifest.versions?.tested?.[manifest.versions.tested.length - 1] ?? "unknown",
      availability: manifest.availability === "soon" ? "soon" : "released",
      coverage: computeCoverage(manifest.capabilities ?? {}, controls),
      capabilities: manifest.capabilities ?? {},
      compatibility: manifest.compatibility ?? { msfs2020: false, msfs2024: false },
      variants: Array.isArray(manifest.variants) ? manifest.variants.filter((value) => typeof value === "string") : [],
      verified: manifest.verification === "live-tested",
    });
  }
  return profiles;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1] : null;
}

function generateJoinCode(existingSessions) {
  const rand = (size) =>
    Array.from({ length: size }, () => SESSION_CODE_CHARS[Math.floor(Math.random() * SESSION_CODE_CHARS.length)]).join("");
  let candidate = "";
  do {
    candidate = `${rand(3)}-${rand(3)}`;
  } while (existingSessions.has(candidate));
  return candidate;
}

function activeParticipants(session) {
  return session.participants.filter((participant) => participant.disconnected_at === null);
}

function recomputeSessionStatus(session) {
  const activePilots = activeParticipants(session).filter((participant) => participant.seat !== "observer");
  session.status = activePilots.length >= 2 ? "active" : "waiting";
}

function sanitizeSession(session, participantToken) {
  return {
    id: session.id,
    joinCode: session.joinCode,
    sessionName: session.sessionName,
    aircraftProfileId: session.aircraftProfileId,
    status: session.status,
    sim: session.sim,
    hasPassword: session.hasPassword,
    creatorPilotName: session.creatorPilotName,
    controlOwner: session.controlOwner,
    controlRequestedBy: session.controlRequestedBy,
    participants: activeParticipants(session).map((participant) => ({
      pilot_name: participant.pilot_name,
      seat: participant.seat,
      joined_at: participant.joined_at,
    })),
    ...(participantToken ? { participantToken } : {}),
  };
}

function createDirectRelay(options) {
  // `port` cambia si el preferido esta ocupado: baseUrl(), isPortOpen() y los
  // helpers de PowerShell leen siempre el que quedo activo.
  let port = options.port ?? DEFAULT_PORT;
  const portCandidates = Array.from({ length: 5 }, (_, index) => port + index);
  const appVersion = options.appVersion;
  const profilesDir = options.profilesDir;
  const currentPid = Number(options.currentPid ?? process.pid);
  const currentExecPath = String(options.currentExecPath ?? process.execPath).toLowerCase();

  let server = null;
  let wss = null;
  let starting = null;
  let profiles = [];
  const sessions = new Map();
  const connections = new Map();

  function baseUrl() {
    return `http://127.0.0.1:${port}`;
  }

  function isClientVersionSupported(version) {
    if (!version) return false;
    return compareVersions(version, DIRECT_MIN_CLIENT_VERSION) >= 0;
  }

  function runPowerShell(command) {
    return new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  async function getListeningProcessIds() {
    const stdout = await runPowerShell(
      `$ids = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); $ids | ConvertTo-Json -Compress`
    ).catch(() => "[]");
    try {
      const parsed = JSON.parse(String(stdout || "[]").trim() || "[]");
      return Array.isArray(parsed) ? parsed.map((value) => Number(value)).filter(Number.isFinite) : [Number(parsed)].filter(Number.isFinite);
    } catch {
      return [];
    }
  }

  async function getListeningProcessDetails() {
    const stdout = await runPowerShell(
      [
        `$connections = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique);`,
        `$rows = @();`,
        `foreach ($id in $connections) {`,
        `  try {`,
        `    $process = Get-Process -Id $id -ErrorAction Stop;`,
        `    $rows += [pscustomobject]@{ pid = $process.Id; processName = $process.ProcessName; path = $process.Path };`,
        `  } catch {`,
        `    $rows += [pscustomobject]@{ pid = $id; processName = $null; path = $null };`,
        `  }`,
        `}`,
        `$rows | ConvertTo-Json -Compress`,
      ].join(" ")
    ).catch(() => "[]");
    try {
      const parsed = JSON.parse(String(stdout || "[]").trim() || "[]");
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((entry) => ({
          pid: Number(entry?.pid),
          processName: typeof entry?.processName === "string" ? entry.processName : "",
          path: typeof entry?.path === "string" ? entry.path : "",
        }))
        .filter((entry) => Number.isFinite(entry.pid));
    } catch {
      return [];
    }
  }

  function looksLikeWeConnectOwner(owner) {
    const processName = String(owner.processName || "").toLowerCase();
    const processPath = String(owner.path || "").toLowerCase();
    const currentExecBase = path.basename(currentExecPath);
    const ownerExecBase = path.basename(processPath);
    if (owner.pid === currentPid) return false;
    if (processPath && ownerExecBase && ownerExecBase === currentExecBase) return true;
    if (processPath && currentExecPath && processPath === currentExecPath) return true;
    return (
      processName === "electron" ||
      processName === "we connect" ||
      processName === "weconnect" ||
      processName === "sharedcockpit.bridge" ||
      processPath.includes("we connect") ||
      processPath.includes("shared-cockpit") ||
      processPath.includes("sharedcockpit")
    );
  }

  function formatOwners(owners) {
    if (!owners.length) return `unknown process on port ${port}`;
    return owners
      .map((owner) => {
        const name = owner.processName || "unknown";
        return owner.path ? `${name} (PID ${owner.pid}, ${owner.path})` : `${name} (PID ${owner.pid})`;
      })
      .join("; ");
  }

  async function killManageableListeningProcesses() {
    const owners = await getListeningProcessDetails();
    const manageable = owners.filter(looksLikeWeConnectOwner);
    if (manageable.length === 0) {
      return { killed: false, owners };
    }
    await runPowerShell(
      `Stop-Process -Id ${manageable.map((owner) => owner.pid).join(",")} -Force -ErrorAction SilentlyContinue`
    ).catch(() => undefined);
    return { killed: true, owners, manageable };
  }

  async function killListeningProcesses() {
    const ids = await getListeningProcessIds();
    if (ids.length === 0) return;
    await runPowerShell(`Stop-Process -Id ${ids.join(",")} -Force -ErrorAction SilentlyContinue`).catch(() => undefined);
  }

  async function waitForPortClosed(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await isPortOpen())) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  async function fetchExistingHealth() {
    try {
      const response = await fetch(`${baseUrl()}/api/health`, {
        headers: { "X-WeConnect-Client-Version": appVersion },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  function authenticateParticipant(joinCode, token) {
    if (!token) return null;
    const session = sessions.get(joinCode);
    if (!session) return null;
    const participant = session.participants.find((entry) => entry.participantToken === token);
    if (!participant) return null;
    return { pilotName: participant.pilot_name, seat: participant.seat };
  }

  function seatOccupied(session, seat) {
    return activeParticipants(session).some((participant) => participant.seat === seat);
  }

  function createSessionRecord(input) {
    const profile = profiles.find((entry) => entry.id === input.aircraftProfileId);
    if (!profile) throw new Error("unknown aircraft profile");
    if (!profile.compatibility[input.sim]) throw new Error(`aircraft-not-compatible-with-${input.sim}`);
    if (profile.availability === "soon") throw new Error("aircraft-coming-soon");

    const joinCode = generateJoinCode(sessions);
    const participantToken = randomBytes(32).toString("hex");
    const session = {
      id: randomBytes(8).toString("hex"),
      joinCode,
      sessionName: input.sessionName,
      aircraftProfileId: input.aircraftProfileId,
      status: "waiting",
      sim: input.sim,
      hasPassword: false,
      creatorPilotName: input.hostPilotName,
      controlOwner: input.hostSeat === "observer" ? "captain" : input.hostSeat,
      controlRequestedBy: null,
      controlRevision: 0,
      participants: [
        {
          pilot_name: input.hostPilotName,
          seat: input.hostSeat,
          joined_at: new Date().toISOString(),
          disconnected_at: null,
          participantToken,
        },
      ],
    };
    recomputeSessionStatus(session);
    sessions.set(joinCode, session);
    return sanitizeSession(session, participantToken);
  }

  function joinSessionRecord(joinCode, input) {
    const session = sessions.get(joinCode);
    if (!session) throw new Error("session-not-found");
    if (seatOccupied(session, input.seat)) throw new Error(input.seat === "observer" ? "observer-seat-taken" : "seat-taken");
    if (
      input.seat !== "observer" &&
      activeParticipants(session).filter((participant) => participant.seat !== "observer").length >= 2
    ) {
      throw new Error("session-full");
    }

    const participantToken = randomBytes(32).toString("hex");
    session.participants = session.participants.filter((participant) => participant.pilot_name !== input.pilotName);
    session.participants.push({
      pilot_name: input.pilotName,
      seat: input.seat,
      joined_at: new Date().toISOString(),
      disconnected_at: null,
      participantToken,
    });
    recomputeSessionStatus(session);
    return sanitizeSession(session, participantToken);
  }

  function markDisconnected(joinCode, pilotName) {
    const session = sessions.get(joinCode);
    if (!session) return;
    const participant = session.participants.find((entry) => entry.pilot_name === pilotName);
    if (!participant) return;
    participant.disconnected_at = new Date().toISOString();
    recomputeSessionStatus(session);
  }

  function markReconnected(joinCode, pilotName) {
    const session = sessions.get(joinCode);
    if (!session) return;
    const participant = session.participants.find((entry) => entry.pilot_name === pilotName);
    if (!participant) return;
    participant.disconnected_at = null;
    recomputeSessionStatus(session);
  }

  function leaveSessionRecord(joinCode, pilotName) {
    const session = sessions.get(joinCode);
    if (!session) return false;
    const participant = session.participants.find((entry) => entry.pilot_name === pilotName);
    if (!participant) return false;

    const leavingSeat = participant.seat;
    session.participants = session.participants.filter((entry) => entry.pilot_name !== pilotName);
    if (session.controlOwner === leavingSeat) {
      session.controlOwner = activeParticipants(session).some((entry) => entry.seat === "captain")
        ? "captain"
        : activeParticipants(session).some((entry) => entry.seat === "first_officer")
          ? "first_officer"
          : null;
    }
    if (session.controlRequestedBy === leavingSeat) {
      session.controlRequestedBy = null;
    }
    recomputeSessionStatus(session);
    if (activeParticipants(session).length === 0) {
      sessions.delete(joinCode);
    }
    return true;
  }

  function requestControls(joinCode, pilotName) {
    const session = sessions.get(joinCode);
    if (!session) return false;
    const participant = activeParticipants(session).find((entry) => entry.pilot_name === pilotName);
    if (!participant || participant.seat === "observer") return false;
    if (session.controlOwner === participant.seat) return false;
    session.controlRequestedBy = participant.seat;
    return true;
  }

  function giveControls(joinCode, pilotName) {
    const session = sessions.get(joinCode);
    if (!session) return null;
    const participant = activeParticipants(session).find((entry) => entry.pilot_name === pilotName);
    if (!participant || participant.seat !== session.controlOwner || !session.controlRequestedBy) return null;
    const previousOwner = session.controlOwner;
    session.controlOwner = session.controlRequestedBy;
    session.controlRequestedBy = null;
    session.controlRevision += 1;
    return {
      previousOwner,
      newOwner: session.controlOwner,
      revision: session.controlRevision,
    };
  }

  function broadcastSessionState(joinCode) {
    const session = sessions.get(joinCode);
    if (!session) return;
    const payload = JSON.stringify({ type: "session.state", session: sanitizeSession(session) });
    for (const [ws, meta] of connections) {
      if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  function broadcastAuthorityTransfer(joinCode, transfer) {
    const payload = JSON.stringify({
      type: "authority.transfer",
      sessionId: joinCode,
      group: "flight_controls",
      previousOwner: transfer.previousOwner,
      newOwner: transfer.newOwner,
      revision: transfer.revision,
    });
    for (const [ws, meta] of connections) {
      if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  function relayFlightMessage(senderWs, joinCode, pilotName, msg) {
    const payload = JSON.stringify({ ...msg, origin: "remote", sourcePilot: pilotName });
    for (const [ws, meta] of connections) {
      if (ws === senderWs) continue;
      if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  function buildApp() {
    const relayApp = express();

    // CORS. El renderer empaquetado se sirve por file:// (Origin: null) y el
    // invitado llama desde otro origen, así que todo /api va por preflight.
    // Va ANTES del gate de versión de abajo: un preflight no lleva cabeceras
    // custom y ese gate lo respondía con 426.
    // ponytail: gemelo de corsMiddleware en server/api/src/security.ts, que no
    // es importable desde aquí (TS, otro paquete). Tocar los dos a la vez.
    relayApp.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-WeConnect-Client-Version");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });

    relayApp.use(express.json({ limit: "16kb" }));

    relayApp.get("/api/health", (_req, res) => {
      res.json({ ...buildHealthPayload(appVersion), mode: "direct-host" });
    });

    relayApp.use("/api", (req, res, next) => {
      if (req.path === "/health") {
        next();
        return;
      }
      const version = typeof req.headers["x-weconnect-client-version"] === "string" ? req.headers["x-weconnect-client-version"] : null;
      if (!isClientVersionSupported(version)) {
        res.status(426).json({ error: "client-update-required", ...buildHealthPayload(appVersion), mode: "direct-host" });
        return;
      }
      next();
    });

    relayApp.get("/api/aircraft-profiles", (_req, res) => {
      res.json(profiles);
    });

    relayApp.get("/api/sessions/:code", (req, res) => {
      const session = sessions.get((req.params.code ?? "").toUpperCase());
      if (!session) {
        res.status(404).json({ error: "session-not-found" });
        return;
      }
      res.json(sanitizeSession(session));
    });

    relayApp.post("/api/sessions", (req, res) => {
      const body = req.body ?? {};
      const sessionName = cleanText(body.sessionName, 80);
      const aircraftProfileId = cleanText(body.aircraftProfileId, 80);
      const hostPilotName = cleanText(body.hostPilotName, 40);
      const hostSeat = body.hostSeat;
      const sim = body.sim;
      if (!sessionName || !aircraftProfileId || !hostPilotName || !hostSeat || !sim) {
        res.status(400).json({ error: "missing required fields" });
        return;
      }
      if (hostSeat !== "captain" && hostSeat !== "first_officer" && hostSeat !== "observer") {
        res.status(400).json({ error: "invalid seat" });
        return;
      }
      if (sim !== "msfs2020" && sim !== "msfs2024") {
        res.status(400).json({ error: "invalid sim" });
        return;
      }
      try {
        res.status(201).json(createSessionRecord({ sessionName, aircraftProfileId, hostPilotName, hostSeat, sim }));
      } catch (error) {
        res.status(400).json({ error: error.message ?? "session-create-failed" });
      }
    });

    relayApp.post("/api/sessions/:code/join", (req, res) => {
      const joinCode = (req.params.code ?? "").toUpperCase();
      const body = req.body ?? {};
      const pilotName = cleanText(body.pilotName, 40);
      const seat = body.seat;
      if (!pilotName || (seat !== "captain" && seat !== "first_officer" && seat !== "observer")) {
        res.status(400).json({ error: "invalid join request" });
        return;
      }
      try {
        res.json(joinSessionRecord(joinCode, { pilotName, seat }));
      } catch (error) {
        const code = error.message ?? "session-join-failed";
        res.status(code === "session-not-found" ? 404 : 409).json({ error: code });
      }
    });

    relayApp.delete("/api/sessions/:code", (req, res) => {
      const joinCode = (req.params.code ?? "").toUpperCase();
      const auth = authenticateParticipant(joinCode, bearerToken(req));
      const session = sessions.get(joinCode);
      if (!auth || !session) {
        res.status(401).json({ error: "invalid-token" });
        return;
      }
      if (session.creatorPilotName !== auth.pilotName) {
        res.status(403).json({ error: "not-session-creator" });
        return;
      }
      sessions.delete(joinCode);
      for (const [ws, meta] of connections) {
        if (meta.joinCode === joinCode) {
          ws.close(4001, "session closed");
        }
      }
      res.status(204).end();
    });

    relayApp.post("/api/sessions/:code/leave", (req, res) => {
      const joinCode = (req.params.code ?? "").toUpperCase();
      const auth = authenticateParticipant(joinCode, bearerToken(req));
      if (!auth) {
        res.status(401).json({ error: "invalid-token" });
        return;
      }
      if (!leaveSessionRecord(joinCode, auth.pilotName)) {
        res.status(404).json({ error: "session-not-found" });
        return;
      }
      broadcastSessionState(joinCode);
      res.status(204).end();
    });

    relayApp.post("/api/sessions/:code/request-controls", (req, res) => {
      const joinCode = (req.params.code ?? "").toUpperCase();
      const auth = authenticateParticipant(joinCode, bearerToken(req));
      if (!auth) {
        res.status(401).json({ error: "invalid-token" });
        return;
      }
      if (!requestControls(joinCode, auth.pilotName)) {
        res.status(409).json({ error: "controls-request-not-allowed" });
        return;
      }
      broadcastSessionState(joinCode);
      res.status(204).end();
    });

    relayApp.post("/api/sessions/:code/give-controls", (req, res) => {
      const joinCode = (req.params.code ?? "").toUpperCase();
      const auth = authenticateParticipant(joinCode, bearerToken(req));
      if (!auth) {
        res.status(401).json({ error: "invalid-token" });
        return;
      }
      const transfer = giveControls(joinCode, auth.pilotName);
      if (!transfer) {
        res.status(409).json({ error: "control-transfer-not-allowed" });
        return;
      }
      broadcastAuthorityTransfer(joinCode, transfer);
      broadcastSessionState(joinCode);
      res.status(204).end();
    });

    return relayApp;
  }

  function attachWebSocket(httpServer) {
    const wsServer = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: 64 * 1024 });

    wsServer.on("connection", (ws, req) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const joinCode = (url.searchParams.get("code") ?? "").toUpperCase();
      const token = url.searchParams.get("token");
      const version = url.searchParams.get("clientVersion");
      if (!isClientVersionSupported(version)) {
        ws.close(4002, "client update required");
        return;
      }
      const auth = authenticateParticipant(joinCode, token);
      if (!auth) {
        ws.close(4000, "invalid session or token");
        return;
      }

      connections.set(ws, { joinCode, pilotName: auth.pilotName, seat: auth.seat });
      markReconnected(joinCode, auth.pilotName);
      broadcastSessionState(joinCode);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", clientSentAt: msg.clientSentAt, serverTime: Date.now() }));
            return;
          }
          if (!FLIGHT_MESSAGE_TYPES.has(msg.type)) return;
          const meta = connections.get(ws);
          if (!meta) return;
          if (typeof msg.sessionId === "string" && msg.sessionId !== meta.joinCode) return;
          relayFlightMessage(ws, meta.joinCode, meta.pilotName, msg);
        } catch {
          return;
        }
      });

      ws.on("close", () => {
        const meta = connections.get(ws);
        connections.delete(ws);
        if (meta) {
          markDisconnected(meta.joinCode, meta.pilotName);
          broadcastSessionState(meta.joinCode);
        }
      });
    });

    return wsServer;
  }

  function isPortOpen() {
    return new Promise((resolve) => {
      const socket = net.createConnection({ port, host: "127.0.0.1" });
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

  // El renderer llama ensureHost() desde varios lados a la vez (dos useEffect
  // de App.tsx, apiClient en cada request, Party/Profile). Sin este candado
  // todos entraban con server === null y hacian listen(8787) en paralelo:
  // EADDRINUSE y proceso principal caido.
  function ensureRunning() {
    starting = starting ?? startRelay().finally(() => { starting = null; });
    return starting;
  }

  async function startRelay() {
    if (server) {
      return { started: false, baseUrl: baseUrl() };
    }
    if (await isPortOpen()) {
      const existingHealth = await fetchExistingHealth();
      const sameVersionRelay =
        existingHealth?.mode === "direct-host" && existingHealth.latestClientVersion === appVersion;
      if (sameVersionRelay) {
        return { started: false, baseUrl: baseUrl(), external: true };
      }
      // Intento de recuperar el puerto preferido (mantiene estable el codigo
      // de invitacion). Si no se logra, no se aborta: se cae al siguiente
      // puerto de la lista mas abajo.
      if (existingHealth?.mode === "direct-host") {
        await killListeningProcesses();
      } else {
        await killManageableListeningProcesses();
      }
      await waitForPortClosed(5000);
    }

    profiles = scanAircraftProfiles(profilesDir);
    const relayApp = buildApp();
    server = createServer(relayApp);

    // El puerto preferido puede estar ocupado por algo que no es nuestro
    // (otro programa, una instancia sin permisos para matar). Antes eso era
    // un error fatal; ahora se prueba el siguiente. El puerto elegido viaja
    // al invitado dentro del codigo de invitacion directo, asi que cambiarlo
    // no rompe nada (ver buildDirectInviteCode en src/lib).
    for (const candidate of portCandidates) {
      port = candidate;
      try {
        await listen();
        // El WebSocketServer se engancha DESPUES de bindear: creado con
        // { server }, `ws` re-emite el EADDRINUSE del http.Server sobre si
        // mismo, y ese 'error' sin listener es una excepcion no capturada que
        // se lleva puesto el proceso principal de Electron.
        wss = attachWebSocket(server);
        return { started: true, baseUrl: baseUrl() };
      } catch (err) {
        if (err?.code !== "EADDRINUSE") {
          await stop();
          throw new Error(`Direct host failed to bind port ${port}: ${err?.message ?? err}`);
        }
      }
    }

    await stop();
    port = portCandidates[0];
    const owners = formatOwners(await getListeningProcessDetails());
    throw new Error(
      `Direct host could not open any port on this PC (tried ${portCandidates.join(", ")}). Port ${portCandidates[0]} is held by ${owners}.`
    );
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, "0.0.0.0", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  async function stop() {
    const pending = [];
    if (wss) {
      pending.push(
        new Promise((resolve) => {
          wss.close(() => resolve());
        })
      );
    }
    for (const ws of connections.keys()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    connections.clear();
    if (server) {
      pending.push(
        new Promise((resolve) => {
          server.close(() => resolve());
        })
      );
    }
    await Promise.allSettled(pending);
    server = null;
    wss = null;
  }

  return {
    ensureRunning,
    stop,
    baseUrl,
  };
}

module.exports = {
  createDirectRelay,
};
