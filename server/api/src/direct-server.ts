import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { scanAircraftProfiles, type ScannedProfile } from "./profiles.ts";
import {
  audit,
  checkRateLimit,
  cleanText,
  clientIp,
  corsMiddleware,
  JOIN_CODE_RE,
  rateLimit,
  securityHeaders,
} from "./security.ts";
import {
  canRelayControlMessage,
  clearSessionAuthority,
  ensureSessionAuthority,
  FLIGHT_CONTROLS_GROUP_ID,
  syncFlightControlsOwner,
} from "./authority.ts";
import { buildHealthPayload, isClientVersionSupported } from "./compat.ts";
import { generateParticipantToken, hashPassword, hashToken, verifyPassword } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 8787);
const SESSION_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Seat = "captain" | "first_officer" | "observer";
type SimVersion = "msfs2020" | "msfs2024";

interface DirectParticipant {
  pilot_name: string;
  seat: Seat;
  joined_at: string;
  disconnected_at: string | null;
  token_hash: string;
}

interface DirectSessionRecord {
  id: string;
  joinCode: string;
  sessionName: string;
  aircraftProfileId: string;
  status: "waiting" | "active";
  sim: SimVersion;
  hasPassword: boolean;
  passwordHash: string | null;
  creatorPilotName: string;
  controlOwner: Seat | null;
  controlRequestedBy: Seat | null;
  controlRevision: number;
  participants: DirectParticipant[];
}

interface PublicSession {
  id: string;
  joinCode: string;
  sessionName: string;
  aircraftProfileId: string;
  status: "waiting" | "active";
  sim: SimVersion;
  hasPassword: boolean;
  creatorPilotName: string;
  controlOwner: string | null;
  controlRequestedBy: string | null;
  participants: Array<{ pilot_name: string; seat: Seat; joined_at: string }>;
  participantToken?: string;
}

interface ConnMeta {
  joinCode: string;
  pilotName: string;
  seat: Seat;
  msgWindowStart: number;
  msgCount: number;
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(securityHeaders);
app.use(corsMiddleware);

const scannedProfiles = scanAircraftProfiles();
const profilesById = new Map(scannedProfiles.map((profile) => [profile.id, profile]));
const sessions = new Map<string, DirectSessionRecord>();
const connections = new Map<WebSocket, ConnMeta>();

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: 64 * 1024 });

const WS_MAX_MESSAGES_PER_SECOND = 300;
const FLIGHT_MESSAGE_TYPES = new Set([
  "control.event",
  "control.axis",
  "aircraft.snapshot",
  "flight.pose",
  "screen.snapshot",
  "authority.transfer",
]);

function generateJoinCode(): string {
  const rand = (size: number) =>
    Array.from({ length: size }, () => SESSION_CODE_CHARS[Math.floor(Math.random() * SESSION_CODE_CHARS.length)]).join("");
  let candidate = "";
  do {
    candidate = `${rand(3)}-${rand(3)}`;
  } while (sessions.has(candidate));
  return candidate;
}

function activeParticipants(session: DirectSessionRecord): DirectParticipant[] {
  return session.participants.filter((participant) => participant.disconnected_at === null);
}

function recomputeSessionStatus(session: DirectSessionRecord) {
  const activePilots = activeParticipants(session).filter((participant) => participant.seat !== "observer");
  session.status = activePilots.length >= 2 ? "active" : "waiting";
}

function sanitizeSession(session: DirectSessionRecord, participantToken?: string): PublicSession {
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

function getSessionByCode(joinCode: string): PublicSession | null {
  const session = sessions.get(joinCode);
  return session ? sanitizeSession(session) : null;
}

function authenticateParticipant(joinCode: string, token: string | null): { pilotName: string; seat: Seat } | null {
  if (!token) return null;
  const session = sessions.get(joinCode);
  if (!session) return null;
  const hashed = hashToken(token);
  const participant = session.participants.find((entry) => entry.token_hash === hashed);
  if (!participant) return null;
  return { pilotName: participant.pilot_name, seat: participant.seat };
}

function seatOccupied(session: DirectSessionRecord, seat: Seat, excludePilotName?: string): boolean {
  return activeParticipants(session).some(
    (participant) => participant.seat === seat && participant.pilot_name !== excludePilotName
  );
}

function createDirectSession(input: {
  sessionName: string;
  aircraftProfileId: string;
  password?: string;
  hostPilotName: string;
  hostSeat: Seat;
  sim: SimVersion;
}) {
  const profile = profilesById.get(input.aircraftProfileId);
  if (!profile) throw new Error("unknown aircraft profile");
  if (!profile.compatibility[input.sim]) throw new Error(`aircraft-not-compatible-with-${input.sim}`);
  if (profile.availability === "soon") throw new Error("aircraft-coming-soon");

  const joinCode = generateJoinCode();
  const participantToken = generateParticipantToken();
  const session: DirectSessionRecord = {
    id: randomBytes(8).toString("hex"),
    joinCode,
    sessionName: input.sessionName,
    aircraftProfileId: input.aircraftProfileId,
    status: "waiting",
    sim: input.sim,
    hasPassword: !!input.password,
    passwordHash: input.password ? hashPassword(input.password) : null,
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
        token_hash: hashToken(participantToken),
      },
    ],
  };
  recomputeSessionStatus(session);
  sessions.set(joinCode, session);
  ensureSessionAuthority(joinCode, session.controlOwner);
  return { session: sanitizeSession(session, participantToken), participantToken };
}

function joinDirectSession(
  joinCode: string,
  input: { pilotName: string; seat: Seat; password?: string }
): PublicSession {
  const session = sessions.get(joinCode);
  if (!session) throw new Error("session-not-found");
  if (session.hasPassword && session.passwordHash && !verifyPassword(input.password ?? "", session.passwordHash)) {
    throw new Error("invalid-password");
  }
  if (seatOccupied(session, input.seat)) {
    throw new Error(input.seat === "observer" ? "observer-seat-taken" : "seat-taken");
  }
  if (
    input.seat !== "observer" &&
    activeParticipants(session).filter((participant) => participant.seat !== "observer").length >= 2
  ) {
    throw new Error("session-full");
  }

  const token = generateParticipantToken();
  session.participants = session.participants.filter((participant) => participant.pilot_name !== input.pilotName);
  session.participants.push({
    pilot_name: input.pilotName,
    seat: input.seat,
    joined_at: new Date().toISOString(),
    disconnected_at: null,
    token_hash: hashToken(token),
  });
  recomputeSessionStatus(session);
  return sanitizeSession(session, token);
}

function markDisconnected(joinCode: string, pilotName: string) {
  const session = sessions.get(joinCode);
  if (!session) return;
  const participant = session.participants.find((entry) => entry.pilot_name === pilotName);
  if (!participant) return;
  participant.disconnected_at = new Date().toISOString();
  recomputeSessionStatus(session);
}

function markReconnected(joinCode: string, pilotName: string) {
  const session = sessions.get(joinCode);
  if (!session) return;
  const participant = session.participants.find((entry) => entry.pilot_name === pilotName);
  if (!participant) return;
  participant.disconnected_at = null;
  recomputeSessionStatus(session);
}

function closeDirectSession(joinCode: string, pilotName: string): boolean {
  const session = sessions.get(joinCode);
  if (!session) return false;
  if (session.creatorPilotName !== pilotName) return false;
  sessions.delete(joinCode);
  clearSessionAuthority(joinCode);
  return true;
}

function pickFallbackOwner(session: DirectSessionRecord): Seat | null {
  const activePilots = activeParticipants(session).filter((participant) => participant.seat !== "observer");
  if (activePilots.length === 0) return null;
  if (activePilots.some((participant) => participant.seat === "captain")) return "captain";
  if (activePilots.some((participant) => participant.seat === "first_officer")) return "first_officer";
  return null;
}

function leaveDirectSession(joinCode: string, pilotName: string): boolean {
  const session = sessions.get(joinCode);
  if (!session) return false;
  const participant = session.participants.find((entry) => entry.pilot_name === pilotName);
  if (!participant) return false;

  const leavingSeat = participant.seat;
  session.participants = session.participants.filter((entry) => entry.pilot_name !== pilotName);
  if (session.controlOwner === leavingSeat) {
    session.controlOwner = pickFallbackOwner(session);
  }
  if (session.controlRequestedBy === leavingSeat) {
    session.controlRequestedBy = null;
  }
  recomputeSessionStatus(session);
  if (activeParticipants(session).length === 0) {
    sessions.delete(joinCode);
    clearSessionAuthority(joinCode);
  }
  return true;
}

function requestDirectControls(joinCode: string, pilotName: string): boolean {
  const session = sessions.get(joinCode);
  if (!session) return false;
  const participant = activeParticipants(session).find((entry) => entry.pilot_name === pilotName);
  if (!participant || participant.seat === "observer") return false;
  if (session.controlOwner === participant.seat) return false;
  session.controlRequestedBy = participant.seat;
  return true;
}

function giveDirectControls(joinCode: string, pilotName: string) {
  const session = sessions.get(joinCode);
  if (!session) return null;
  const participant = activeParticipants(session).find((entry) => entry.pilot_name === pilotName);
  if (!participant || participant.seat !== session.controlOwner || !session.controlRequestedBy) return null;
  const previousOwner = session.controlOwner;
  session.controlOwner = session.controlRequestedBy;
  session.controlRequestedBy = null;
  session.controlRevision += 1;
  syncFlightControlsOwner(joinCode, session.controlOwner);
  return {
    previousOwner,
    newOwner: session.controlOwner,
    revision: session.controlRevision,
  };
}

function clientVersion(req: Request): string | null {
  const value = req.headers["x-weconnect-client-version"];
  return typeof value === "string" ? value : null;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header.trim());
  return match ? match[1] : null;
}

function validateCodeParam(req: Request, res: Response, next: NextFunction) {
  const code = req.params.code?.toUpperCase() ?? "";
  if (!JOIN_CODE_RE.test(code)) {
    res.status(404).json({ error: "session-not-found" });
    return;
  }
  next();
}

function requireParticipant(req: Request, res: Response, next: NextFunction) {
  const joinCode = req.params.code.toUpperCase();
  const token = bearerToken(req);
  const auth = authenticateParticipant(joinCode, token);
  if (!auth) {
    res.status(401).json({ error: "invalid-token" });
    return;
  }
  res.locals.pilotName = auth.pilotName;
  res.locals.seat = auth.seat;
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({ ...buildHealthPayload(), mode: "direct-host" });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health") {
    next();
    return;
  }
  const version = clientVersion(req);
  if (!isClientVersionSupported(version)) {
    res.status(426).json({ error: "client-update-required", ...buildHealthPayload(), mode: "direct-host" });
    return;
  }
  next();
});

app.get("/api/aircraft-profiles", rateLimit("profiles", 60, 60_000), (_req, res) => {
  res.json(scannedProfiles);
});

app.get("/api/sessions/:code", rateLimit("session-read", 120, 60_000), validateCodeParam, (req, res) => {
  const session = getSessionByCode(req.params.code.toUpperCase());
  if (!session) {
    res.status(404).json({ error: "session-not-found" });
    return;
  }
  res.json(session);
});

app.post("/api/sessions", rateLimit("create-session", 10, 5 * 60_000), (req, res) => {
  const body = req.body ?? {};
  const sessionName = cleanText(body.sessionName, 80);
  const aircraftProfileId = cleanText(body.aircraftProfileId, 80);
  const hostPilotName = cleanText(body.hostPilotName, 40);
  const { hostSeat, sim, password } = body;
  if (!sessionName || !aircraftProfileId || !hostPilotName || !hostSeat || !sim) {
    res.status(400).json({ error: "missing required fields" });
    return;
  }
  if (sim !== "msfs2020" && sim !== "msfs2024") {
    res.status(400).json({ error: "invalid sim" });
    return;
  }
  if (hostSeat !== "captain" && hostSeat !== "first_officer" && hostSeat !== "observer") {
    res.status(400).json({ error: "invalid seat" });
    return;
  }
  if (password !== undefined && password !== "" && (typeof password !== "string" || password.length > 128)) {
    res.status(400).json({ error: "invalid password" });
    return;
  }
  try {
    const session = createDirectSession({
      sessionName,
      aircraftProfileId,
      password: password || undefined,
      hostPilotName,
      hostSeat,
      sim,
    });
    audit("direct-session-created", { joinCode: session.session.joinCode, ip: req.ip });
    res.status(201).json(session.session);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sessions/:code/join", rateLimit("join-session", 20, 5 * 60_000), validateCodeParam, (req, res) => {
  const body = req.body ?? {};
  const pilotName = cleanText(body.pilotName, 40);
  const seat = body.seat;
  const password = typeof body.password === "string" ? body.password : undefined;
  if (!pilotName || (seat !== "captain" && seat !== "first_officer" && seat !== "observer")) {
    res.status(400).json({ error: "invalid join request" });
    return;
  }
  try {
    const session = joinDirectSession(req.params.code.toUpperCase(), { pilotName, seat, password });
    audit("direct-session-joined", { joinCode: req.params.code.toUpperCase(), ip: req.ip });
    res.status(200).json(session);
  } catch (err: any) {
    const code = err.message;
    const status = code === "session-not-found" ? 404 : code === "invalid-password" ? 403 : 409;
    res.status(status).json({ error: code });
  }
});

app.delete(
  "/api/sessions/:code",
  rateLimit("close-session", 10, 5 * 60_000),
  validateCodeParam,
  requireParticipant,
  (req, res) => {
    const joinCode = req.params.code.toUpperCase();
    const pilotName = res.locals.pilotName as string;
    if (!closeDirectSession(joinCode, pilotName)) {
      res.status(403).json({ error: "not-session-creator" });
      return;
    }
    for (const [ws, meta] of connections) {
      if (meta.joinCode === joinCode) {
        ws.close(4001, "session closed");
      }
    }
    res.status(204).end();
  }
);

app.post("/api/sessions/:code/leave", rateLimit("session-action", 60, 60_000), validateCodeParam, requireParticipant, (req, res) => {
  const joinCode = req.params.code.toUpperCase();
  const pilotName = res.locals.pilotName as string;
  if (!leaveDirectSession(joinCode, pilotName)) {
    res.status(404).json({ error: "session-not-found" });
    return;
  }
  void broadcastSessionState(joinCode);
  res.status(204).end();
});

app.post("/api/sessions/:code/request-controls", rateLimit("session-action", 60, 60_000), validateCodeParam, requireParticipant, (req, res) => {
  const joinCode = req.params.code.toUpperCase();
  const pilotName = res.locals.pilotName as string;
  if (!requestDirectControls(joinCode, pilotName)) {
    res.status(409).json({ error: "controls-request-not-allowed" });
    return;
  }
  void broadcastSessionState(joinCode);
  res.status(204).end();
});

app.post("/api/sessions/:code/give-controls", rateLimit("session-action", 60, 60_000), validateCodeParam, requireParticipant, (req, res) => {
  const joinCode = req.params.code.toUpperCase();
  const pilotName = res.locals.pilotName as string;
  const transfer = giveDirectControls(joinCode, pilotName);
  if (!transfer) {
    res.status(409).json({ error: "control-transfer-not-allowed" });
    return;
  }
  broadcastAuthorityTransfer(joinCode, transfer);
  void broadcastSessionState(joinCode);
  res.status(204).end();
});

function validateFlightMessage(msg: any): string | null {
  if (typeof msg !== "object" || msg === null) return "not-an-object";
  const type = msg.type;
  if (typeof type !== "string") return "missing-type";

  const shortStr = (v: unknown, max = 128) => typeof v === "string" && v.length > 0 && v.length <= max;
  const finiteNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

  switch (type) {
    case "control.event": {
      const required = ["sessionId", "controlId", "value", "source", "sequence", "timestamp"];
      for (const field of required) if (!(field in msg)) return `missing-field:${field}`;
      if (!shortStr(msg.sessionId)) return "invalid:sessionId";
      if (!shortStr(msg.controlId)) return "invalid:controlId";
      if (!["boolean", "number", "string"].includes(typeof msg.value)) return "invalid:value";
      if (typeof msg.value === "string" && msg.value.length > 1024) return "invalid:value";
      if (!shortStr(msg.source, 64)) return "invalid:source";
      if (!finiteNum(msg.sequence)) return "invalid:sequence";
      if (!finiteNum(msg.timestamp)) return "invalid:timestamp";
      return null;
    }
    case "control.axis": {
      const required = ["controlId", "value", "sequence", "timestamp"];
      for (const field of required) if (!(field in msg)) return `missing-field:${field}`;
      if (!shortStr(msg.controlId)) return "invalid:controlId";
      if (!finiteNum(msg.value)) return "invalid:value";
      if (!finiteNum(msg.sequence)) return "invalid:sequence";
      if (!finiteNum(msg.timestamp)) return "invalid:timestamp";
      return null;
    }
    case "aircraft.snapshot": {
      const required = ["revision", "profile", "systems"];
      for (const field of required) if (!(field in msg)) return `missing-field:${field}`;
      if (!finiteNum(msg.revision)) return "invalid:revision";
      if (!shortStr(msg.profile)) return "invalid:profile";
      if (typeof msg.systems !== "object" || msg.systems === null) return "invalid:systems";
      return null;
    }
    case "flight.pose": {
      const required = ["sessionId", "sequence", "timestamp", "lat", "lon", "alt", "pitch", "bank", "heading", "groundSpeed", "indicatedAirspeed", "verticalSpeed"];
      for (const field of required) if (!(field in msg)) return `missing-field:${field}`;
      if (!shortStr(msg.sessionId)) return "invalid:sessionId";
      if (!finiteNum(msg.sequence) || !finiteNum(msg.timestamp)) return "invalid:sequence";
      if (!finiteNum(msg.lat) || msg.lat < -90 || msg.lat > 90) return "invalid:lat";
      if (!finiteNum(msg.lon) || msg.lon < -180 || msg.lon > 180) return "invalid:lon";
      if (!finiteNum(msg.alt) || !finiteNum(msg.pitch) || !finiteNum(msg.bank) || !finiteNum(msg.heading)) return "invalid:pose";
      if (!finiteNum(msg.groundSpeed) || !finiteNum(msg.indicatedAirspeed) || !finiteNum(msg.verticalSpeed)) return "invalid:speed";
      return null;
    }
    case "authority.transfer": {
      const required = ["group", "previousOwner", "newOwner", "revision"];
      for (const field of required) if (!(field in msg)) return `missing-field:${field}`;
      if (!shortStr(msg.group) || !shortStr(msg.previousOwner, 64) || !shortStr(msg.newOwner, 64)) return "invalid:group";
      if (!finiteNum(msg.revision)) return "invalid:revision";
      return null;
    }
    case "screen.snapshot": {
      const required = ["sessionId", "screenId", "rows", "cols", "cells", "revision"];
      for (const field of required) if (!(field in msg)) return `missing-field:${field}`;
      if (!shortStr(msg.sessionId) || !shortStr(msg.screenId)) return "invalid:screen";
      if (!finiteNum(msg.rows) || msg.rows < 1 || !finiteNum(msg.cols) || msg.cols < 1) return "invalid:grid";
      if (!Array.isArray(msg.cells) || msg.cells.length > 24 * 14) return "invalid:cells";
      if (!finiteNum(msg.revision)) return "invalid:revision";
      return null;
    }
    default:
      return "unknown-type";
  }
}

function relayFlightMessage(senderWs: WebSocket, joinCode: string, pilotName: string, msg: any) {
  const payload = JSON.stringify({ ...msg, origin: "remote", sourcePilot: pilotName });
  for (const [ws, meta] of connections) {
    if (ws === senderWs) continue;
    if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastAuthorityTransfer(joinCode: string, transfer: { previousOwner: string; newOwner: string; revision: number }) {
  const payload = JSON.stringify({
    type: "authority.transfer",
    sessionId: joinCode,
    group: FLIGHT_CONTROLS_GROUP_ID,
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

async function broadcastSessionState(joinCode: string) {
  const session = getSessionByCode(joinCode);
  if (!session) return;
  const payload = JSON.stringify({ type: "session.state", session });
  for (const [ws, meta] of connections) {
    if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  if (!checkRateLimit("ws-handshake", ip, 30, 60_000)) {
    ws.close(4000, "too many connection attempts");
    return;
  }
  const url = new URL(req.url ?? "", "http://localhost");
  const joinCode = (url.searchParams.get("code") ?? "").toUpperCase();
  const token = url.searchParams.get("token");
  const version = url.searchParams.get("clientVersion");

  if (!isClientVersionSupported(version)) {
    ws.close(4002, "client update required");
    return;
  }
  const auth = JOIN_CODE_RE.test(joinCode) ? authenticateParticipant(joinCode, token) : null;
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
  markReconnected(joinCode, auth.pilotName);
  ensureSessionAuthority(joinCode, getSessionByCode(joinCode)?.controlOwner);
  void broadcastSessionState(joinCode);

  ws.on("message", (raw) => {
    const meta = connections.get(ws);
    if (!meta) return;

    const now = Date.now();
    if (now - meta.msgWindowStart >= 1000) {
      meta.msgWindowStart = now;
      meta.msgCount = 0;
    }
    meta.msgCount += 1;
    if (meta.msgCount > WS_MAX_MESSAGES_PER_SECOND) return;

    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", clientSentAt: msg.clientSentAt, serverTime: Date.now() }));
        return;
      }
      if (!FLIGHT_MESSAGE_TYPES.has(msg.type)) return;
      const error = validateFlightMessage(msg);
      if (error) return;
      if (typeof msg.sessionId === "string" && msg.sessionId !== meta.joinCode) return;

      if (msg.type === "control.event" || msg.type === "control.axis") {
        const authorityState = ensureSessionAuthority(meta.joinCode, undefined);
        const decision = canRelayControlMessage(authorityState, meta.seat, msg.controlId, msg.sequence);
        if (!decision.ok) return;
      }
      if (msg.type === "flight.pose") {
        const authorityState = ensureSessionAuthority(meta.joinCode, undefined);
        if (!authorityState.authorityManager.canWrite(FLIGHT_CONTROLS_GROUP_ID, meta.seat)) return;
      }

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
      void broadcastSessionState(meta.joinCode);
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Shared Cockpit direct host corriendo en http://0.0.0.0:${PORT}`);
  console.log(`WebSocket directo en ws://0.0.0.0:${PORT}/ws`);
});
