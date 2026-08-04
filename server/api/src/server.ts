/**
 * Servidor real: REST para sesiones/perfiles, WebSocket para señalización en
 * vivo (lista de participantes, ping, ciclo de vida de sesión). No hay datos
 * de relleno — el catálogo de aeronaves viene de escanear aircraft-profiles/
 * y las sesiones viven en PostgreSQL real y compartido (ver db.ts, requiere
 * DATABASE_URL — no hay fallback local).
 *
 * Seguridad (ver src/auth.ts y src/security.ts):
 * - Toda acción sensible (cerrar/salir/pedir/ceder controles, y el propio
 *   WebSocket) exige el token de participante emitido en create/join. El
 *   pilotName del body ya NO se usa como identidad.
 * - Contraseñas de sesión hasheadas (scrypt) en la base.
 * - Rate limiting por IP en endpoints y handshake WS.
 * - CORS con allowlist (nada de "*").
 */
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { scanAircraftProfiles } from "./profiles.ts";
import {
  dbReady,
  syncAircraftProfiles,
  listAircraftProfiles,
  createSession,
  getSessionByCode,
  joinSession,
  markDisconnected,
  markReconnected,
  closeSession,
  leaveSession,
  requestControls,
  giveControls,
  authenticateParticipant,
} from "./db.ts";
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
  syncFlightControlsOwner,
  FLIGHT_CONTROLS_GROUP_ID,
} from "./authority.ts";
import { buildHealthPayload, isClientVersionSupported } from "./compat.ts";
import { SessionStateCache } from "./session-state-cache.ts";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
// Render/Railway terminan TLS y ponen la IP real en X-Forwarded-For — sin
// esto, req.ip sería la IP interna del proxy y el rate limiting por IP
// castigaría a todos los clientes juntos.
app.set("trust proxy", 1);
// Límite de payload: ninguna petición legítima de esta API pasa de unos
// cientos de bytes.
app.use(express.json({ limit: "16kb" }));
app.use(securityHeaders);
app.use(corsMiddleware);

function clientVersion(req: Request): string | null {
  const value = req.headers["x-weconnect-client-version"];
  return typeof value === "string" ? value : null;
}

/** Extrae el Bearer token del header Authorization (o null). */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Valida el formato del join code de la URL antes de tocar la base. */
function validateCodeParam(req: Request, res: Response, next: NextFunction) {
  const code = req.params.code?.toUpperCase() ?? "";
  if (!JOIN_CODE_RE.test(code)) {
    res.status(404).json({ error: "session-not-found" });
    return;
  }
  next();
}

/**
 * Autenticación por token de participante. Resuelve la identidad real
 * (pilotName/seat) desde la base y la cuelga de res.locals — el body deja de
 * ser fuente de identidad.
 */
function requireParticipant(req: Request, res: Response, next: NextFunction) {
  const joinCode = req.params.code.toUpperCase();
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "missing-token" });
    return;
  }
  authenticateParticipant(joinCode, token)
    .then((auth) => {
      if (!auth) {
        audit("auth-failed", { joinCode, ip: req.ip, path: req.path });
        res.status(401).json({ error: "invalid-token" });
        return;
      }
      res.locals.pilotName = auth.pilotName;
      res.locals.seat = auth.seat;
      next();
    })
    .catch(next);
}

app.get("/api/health", (_req, res) => {
  res.json(buildHealthPayload());
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health") {
    next();
    return;
  }
  const version = clientVersion(req);
  if (!isClientVersionSupported(version)) {
    res.status(426).json({
      error: "client-update-required",
      ...buildHealthPayload(),
    });
    return;
  }
  next();
});

app.get("/api/aircraft-profiles", rateLimit("profiles", 60, 60_000), async (_req, res) => {
  res.json(await listAircraftProfiles());
});

app.post("/api/sessions", rateLimit("create-session", 10, 5 * 60_000), async (req, res) => {
  const body = req.body ?? {};
  const sessionName = cleanText(body.sessionName, 80);
  const aircraftProfileId = cleanText(body.aircraftProfileId, 80);
  const hostPilotName = cleanText(body.hostPilotName, 40);
  const { hostSeat, sim, password } = body;
  if (!sessionName || !aircraftProfileId || !hostPilotName || !hostSeat || !sim) {
    return res.status(400).json({ error: "missing required fields" });
  }
  if (sim !== "msfs2020" && sim !== "msfs2024") {
    return res.status(400).json({ error: "invalid sim" });
  }
  if (hostSeat !== "captain" && hostSeat !== "first_officer" && hostSeat !== "observer") {
    return res.status(400).json({ error: "invalid seat" });
  }
  if (password !== undefined && password !== "" &&
      (typeof password !== "string" || password.length > 128)) {
    return res.status(400).json({ error: "invalid password" });
  }
  try {
    const { session, participantToken } = await createSession({
      sessionName,
      aircraftProfileId,
      password: password || undefined,
      hostPilotName,
      hostSeat,
      sim,
    });
    if (session) {
      // Siembra flight_controls con el owner real desde el momento en que la
      // sesión existe, no solo cuando el primer socket se conecta (ver
      // packages/protocol/README.md, "Cómo se siembra el dueño inicial").
      ensureSessionAuthority(session.joinCode, session.controlOwner);
    }
    audit("session-created", { joinCode: session?.joinCode, ip: req.ip });
    res.status(201).json({ ...session, participantToken });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get(
  "/api/sessions/:code",
  rateLimit("get-session", 60, 60_000),
  validateCodeParam,
  async (req, res) => {
    const session = await getSessionByCode(req.params.code.toUpperCase());
    if (!session) return res.status(404).json({ error: "session-not-found" });
    res.json(session);
  }
);

app.post(
  "/api/sessions/:code/join",
  rateLimit("join-session", 15, 5 * 60_000),
  validateCodeParam,
  async (req, res) => {
    const joinCode = req.params.code.toUpperCase();
    // Freno adicional por joinCode: aunque un atacante rote de IP, una misma
    // sesión no admite más de este puñado de intentos por ventana (anti
    // brute-force de contraseñas cortas).
    if (!checkRateLimit("join-by-code", joinCode, 20, 5 * 60_000)) {
      audit("rate-limited", { route: "join-by-code", joinCode, ip: req.ip });
      return res.status(429).json({ error: "too-many-requests" });
    }
    const body = req.body ?? {};
    const pilotName = cleanText(body.pilotName, 40);
    const { seat, password } = body;
    if (!pilotName || !seat) {
      return res.status(400).json({ error: "missing required fields" });
    }
    if (seat !== "captain" && seat !== "first_officer" && seat !== "observer") {
      return res.status(400).json({ error: "invalid seat" });
    }
    if (password !== undefined && (typeof password !== "string" || password.length > 128)) {
      return res.status(400).json({ error: "invalid password" });
    }
    const result = await joinSession({ joinCode, pilotName, seat, password });
    if (!result.ok) {
      if (result.reason === "invalid-password") {
        audit("join-invalid-password", { joinCode, ip: req.ip });
      }
      const status = result.reason === "session-not-found" ? 404 : 409;
      return res.status(status).json({ error: result.reason });
    }
    audit("session-joined", { joinCode, ip: req.ip });
    res.json({ ...result.session, participantToken: result.participantToken });
  }
);

app.delete(
  "/api/sessions/:code",
  rateLimit("session-action", 60, 60_000),
  validateCodeParam,
  requireParticipant,
  async (req, res) => {
    const joinCode = req.params.code.toUpperCase();
    const pilotName = res.locals.pilotName as string;
    if (!(await closeSession(joinCode, pilotName))) {
      // closeSession solo cierra si pilotName es el creador — para cualquier
      // otro participante autenticado esto es un 403, no un 404.
      return res.status(403).json({ error: "not-session-creator" });
    }
    audit("session-closed", { joinCode, ip: req.ip });
    for (const [ws, meta] of connections) {
      if (meta.joinCode === joinCode) {
        ws.close(4001, "session closed");
      }
    }
    sessionStateCache.clear(joinCode);
    clearSessionAuthority(joinCode);
    res.status(204).end();
  }
);

app.post(
  "/api/sessions/:code/leave",
  rateLimit("session-action", 60, 60_000),
  validateCodeParam,
  requireParticipant,
  async (req, res) => {
    const joinCode = req.params.code.toUpperCase();
    const pilotName = res.locals.pilotName as string;
    if (!(await leaveSession(joinCode, pilotName))) {
      return res.status(404).json({ error: "session-not-found" });
    }
    audit("session-left", { joinCode, ip: req.ip });
    for (const [ws, meta] of connections) {
      if (meta.joinCode === joinCode && meta.pilotName === pilotName) {
        ws.close(4001, "session left");
      }
    }
    await broadcastSessionState(joinCode);
    res.status(204).end();
  }
);

app.post(
  "/api/sessions/:code/request-controls",
  rateLimit("session-action", 60, 60_000),
  validateCodeParam,
  requireParticipant,
  async (req, res) => {
    const joinCode = req.params.code.toUpperCase();
    const pilotName = res.locals.pilotName as string;
    if (!(await requestControls(joinCode, pilotName))) {
      return res.status(409).json({ error: "controls-request-not-allowed" });
    }
    audit("controls-requested", { joinCode, ip: req.ip });
    await broadcastSessionState(joinCode);
    res.status(204).end();
  }
);

app.post(
  "/api/sessions/:code/give-controls",
  rateLimit("session-action", 60, 60_000),
  validateCodeParam,
  requireParticipant,
  async (req, res) => {
    const joinCode = req.params.code.toUpperCase();
    const pilotName = res.locals.pilotName as string;
    const transfer = await giveControls(joinCode, pilotName);
    if (!transfer) {
      return res.status(409).json({ error: "control-transfer-not-allowed" });
    }
    audit("controls-transferred", {
      joinCode,
      previousOwner: transfer.previousOwner,
      newOwner: transfer.newOwner,
      ip: req.ip,
    });
    // Flujo autoritativo: server/api (Postgres) es la fuente de verdad
    // PERSISTENTE de "quién es el dueño" a nivel de sesión (sobrevive a
    // reconexión). Una vez que giveControls confirma el cambio en la base de
    // datos, se emite un authority.transfer REAL por WebSocket con la forma
    // exacta de packages/protocol — es este mensaje el que
    // packages/synchronization-core (AuthorityManager/SyncEngine) debe tratar
    // como autoritativo al sembrarse/resincronizarse, no el relay peer-to-peer
    // de authority.transfer que los clientes puedan iniciar entre ellos (ver
    // FLIGHT_MESSAGE_TYPES/relayFlightMessage más abajo). Ese relay sigue
    // siendo válido para propagar cambios YA resueltos en memoria entre pares
    // conectados directamente, pero no reemplaza este flujo request-controls
    // -> give-controls vía HTTP+DB, que es el único que persiste y el que se
    // usa para reconstruir el estado tras una reconexión. No son dos
    // mecanismos redundantes compitiendo por la misma verdad.
    //
    // Refleja el nuevo owner en el AuthorityManager EN MEMORIA de esta
    // sesión (ver authority.ts, syncFlightControlsOwner): sin esto, el gate
    // de canRelayControlMessage seguiría rechazando al nuevo dueño real para
    // flight.yoke.pitch/roll y flight.rudder indefinidamente.
    syncFlightControlsOwner(joinCode, transfer.newOwner);
    broadcastAuthorityTransfer(joinCode, transfer);
    await broadcastSessionState(joinCode);
    res.status(204).end();
  }
);

const httpServer = createServer(app);
// maxPayload: ningún mensaje del protocolo (control.event/axis, snapshot)
// legítimo se acerca a 64KB — corta payloads abusivos antes de parsearlos.
const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: 64 * 1024 });

interface ConnMeta {
  joinCode: string;
  pilotName: string;
  /** 'captain' | 'first_officer' | 'observer' — usado por el gate de authority.ts. */
  seat: string;
  /** Ventana simple de mensajes/segundo para frenar clientes abusivos. */
  msgWindowStart: number;
  msgCount: number;
}

const connections = new Map<WebSocket, ConnMeta>();
const sessionStateCache = new SessionStateCache();

// Tope generoso: el canal rápido (control.axis) legítimo corre a 20-60Hz por
// eje; 300 msg/s por socket ya es varias veces eso. Por encima se descartan
// mensajes (sin cerrar la conexión, para no castigar ráfagas transitorias).
const WS_MAX_MESSAGES_PER_SECOND = 300;

// Tipos de mensaje de vuelo que este servidor retransmite como relay puro
// (sin lógica de autoridad ni anti-ciclo: eso vive en synchronization-core).
// Forma tomada de packages/protocol/messages.schema.json — NO modificar ese
// esquema desde aquí; si falta un campo, es territorio del orchestrator.
const FLIGHT_MESSAGE_TYPES = new Set([
  "control.event",
  "control.axis",
  "aircraft.snapshot",
  "flight.pose",
  "screen.snapshot",
  "authority.transfer",
]);

/**
 * Validación mínima de forma contra messages.schema.json: confirma que los
 * campos requeridos están presentes, tienen el tipo básico correcto y que los
 * strings respetan topes de longitud sanos (nada del protocolo real se acerca
 * a estos límites; solo cortan abuso). No es un validador de JSON Schema
 * completo (no hay ajv en las deps de este paquete); si se necesita
 * validación estricta, es una decisión a nivel de dependencias que le
 * corresponde decidir al orchestrator.
 */
function validateFlightMessage(msg: any): string | null {
  if (typeof msg !== "object" || msg === null) return "not-an-object";
  const type = msg.type;
  if (typeof type !== "string") return "missing-type";

  const shortStr = (v: unknown, max = 128) => typeof v === "string" && v.length > 0 && v.length <= max;
  const finiteNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);

  switch (type) {
    case "control.event": {
      const required = ["sessionId", "controlId", "value", "source", "sequence", "timestamp"];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
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
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (!shortStr(msg.controlId)) return "invalid:controlId";
      if (!finiteNum(msg.value)) return "invalid:value";
      if (!finiteNum(msg.sequence)) return "invalid:sequence";
      if (!finiteNum(msg.timestamp)) return "invalid:timestamp";
      return null;
    }
    case "aircraft.snapshot": {
      const required = ["revision", "profile", "systems"];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (!finiteNum(msg.revision)) return "invalid:revision";
      if (!shortStr(msg.profile)) return "invalid:profile";
      if (typeof msg.systems !== "object" || msg.systems === null) return "invalid:systems";
      return null;
    }
    case "flight.pose": {
      const required = [
        "sessionId",
        "sequence",
        "timestamp",
        "lat",
        "lon",
        "alt",
        "pitch",
        "bank",
        "heading",
        "groundSpeed",
        "indicatedAirspeed",
        "verticalSpeed",
      ];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (!shortStr(msg.sessionId)) return "invalid:sessionId";
      if (!finiteNum(msg.sequence)) return "invalid:sequence";
      if (!finiteNum(msg.timestamp)) return "invalid:timestamp";
      if (!finiteNum(msg.lat) || msg.lat < -90 || msg.lat > 90) return "invalid:lat";
      if (!finiteNum(msg.lon) || msg.lon < -180 || msg.lon > 180) return "invalid:lon";
      if (!finiteNum(msg.alt)) return "invalid:alt";
      if (!finiteNum(msg.pitch)) return "invalid:pitch";
      if (!finiteNum(msg.bank)) return "invalid:bank";
      if (!finiteNum(msg.heading)) return "invalid:heading";
      if (!finiteNum(msg.groundSpeed)) return "invalid:groundSpeed";
      if (!finiteNum(msg.indicatedAirspeed)) return "invalid:indicatedAirspeed";
      if (!finiteNum(msg.verticalSpeed)) return "invalid:verticalSpeed";
      return null;
    }
    case "authority.transfer": {
      const required = ["group", "previousOwner", "newOwner", "revision"];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (!shortStr(msg.group)) return "invalid:group";
      if (!shortStr(msg.previousOwner, 64)) return "invalid:previousOwner";
      if (!shortStr(msg.newOwner, 64)) return "invalid:newOwner";
      if (!finiteNum(msg.revision)) return "invalid:revision";
      return null;
    }
    case "screen.snapshot": {
      const required = ["sessionId", "screenId", "rows", "cols", "cells", "revision"];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (!shortStr(msg.sessionId)) return "invalid:sessionId";
      if (!shortStr(msg.screenId)) return "invalid:screenId";
      if (!finiteNum(msg.rows) || msg.rows < 1) return "invalid:rows";
      if (!finiteNum(msg.cols) || msg.cols < 1) return "invalid:cols";
      if (!Array.isArray(msg.cells)) return "invalid:cells";
      if (msg.cells.length > 24 * 14) return "invalid:cells";
      for (const cell of msg.cells) {
        if (typeof cell !== "object" || cell === null) return "invalid:cell";
        if (!("char" in cell) || typeof cell.char !== "string" || cell.char.length > 1) return "invalid:cell.char";
        if (!finiteNum(cell.colorId) || cell.colorId < 0 || cell.colorId > 5) return "invalid:cell.colorId";
        if (!finiteNum(cell.flags) || cell.flags < 0) return "invalid:cell.flags";
      }
      if ("powered" in msg && typeof msg.powered !== "boolean") return "invalid:powered";
      if (!finiteNum(msg.revision)) return "invalid:revision";
      if ("timestamp" in msg && !finiteNum(msg.timestamp)) return "invalid:timestamp";
      return null;
    }
    default:
      return "unknown-type";
  }
}

/**
 * Relay puro: retransmite el mensaje de vuelo a los demás sockets de la
 * misma sesión (mismo joinCode), sin enviárselo de vuelta al remitente.
 * Marca origin: "remote" en el mensaje reenviado — regla no negociable del
 * proyecto (ver CLAUDE.md): todo mensaje recibido de red se marca como tal
 * y nunca se reenvía como si fuera un cambio local. El campo `origin` ya
 * existe en el schema (ControlEvent) como "asignado por el receptor, nunca
 * enviado por red", así que aquí actuamos como el receptor que reenvía.
 * `sourcePilot` sale de la identidad autenticada del socket (token), no de
 * lo que el emisor haya puesto en el mensaje.
 */
function relayFlightMessage(senderWs: WebSocket, joinCode: string, pilotName: string, msg: any) {
  const outgoing = { ...msg, origin: "remote", sourcePilot: pilotName };
  sessionStateCache.remember(joinCode, outgoing);
  const payload = JSON.stringify(outgoing);
  for (const [ws, meta] of connections) {
    if (ws === senderWs) continue;
    if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// El MVP solo tiene un grupo de controles transferible ("flight_controls",
// importado de ./authority.ts). Si más adelante hace falta más de un grupo
// (luces, radios, etc.), el groupId debería venir del perfil de aeronave
// activo de la sesión (packages/profile-schema), no seguir hardcodeado aquí.

interface AuthorityTransferResult {
  previousOwner: string;
  newOwner: string;
  revision: number;
}

/**
 * Emite el mensaje authority.transfer AUTORITATIVO (forma exacta de
 * packages/protocol/types.ts: group, previousOwner, newOwner, revision,
 * sessionId) a todos los sockets conectados de la sesión, tras un
 * give-controls exitoso en la base de datos. `sessionId` aquí es el join
 * code (así es como el resto del código de este archivo y el cliente
 * (useSessionSocket.ts) usan `sessionId` en mensajes de vuelo — no el id
 * interno hex de la fila `sessions`).
 */
function broadcastAuthorityTransfer(joinCode: string, transfer: AuthorityTransferResult) {
  const outgoing = {
    type: "authority.transfer",
    sessionId: joinCode,
    group: FLIGHT_CONTROLS_GROUP_ID,
    previousOwner: transfer.previousOwner,
    newOwner: transfer.newOwner,
    revision: transfer.revision,
  };
  sessionStateCache.remember(joinCode, outgoing);
  const payload = JSON.stringify(outgoing);
  for (const [ws, meta] of connections) {
    if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

async function broadcastSessionState(joinCode: string) {
  const session = await getSessionByCode(joinCode);
  if (!session) return;
  const payload = JSON.stringify({ type: "session.state", session });
  for (const [ws, meta] of connections) {
    if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

wss.on("connection", async (ws, req) => {
  const ip = clientIp(req);
  if (!checkRateLimit("ws-handshake", ip, 30, 60_000)) {
    audit("rate-limited", { route: "ws-handshake", ip });
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

  // El socket queda ligado a la identidad AUTENTICADA (token emitido en
  // create/join), no a un nombre elegido libremente en la query string.
  const auth = JOIN_CODE_RE.test(joinCode) ? await authenticateParticipant(joinCode, token) : null;
  if (!auth) {
    audit("ws-auth-failed", { joinCode, ip });
    ws.close(4000, "invalid session or token");
    return;
  }
  const pilotName = auth.pilotName;
  const seat = auth.seat;

  connections.set(ws, { joinCode, pilotName, seat, msgWindowStart: Date.now(), msgCount: 0 });
  await markReconnected(joinCode, pilotName);
  // Siembra (si hace falta; ver ensureSessionAuthority) flight_controls en
  // memoria con el control_owner real de esta sesión, cubriendo el caso de
  // reconexión tras un reinicio del proceso donde el mapa en memoria se
  // perdió pero Postgres sigue siendo la fuente de verdad.
  const sessionForAuthority = await getSessionByCode(joinCode);
  if (sessionForAuthority) {
    ensureSessionAuthority(joinCode, sessionForAuthority.controlOwner);
  }
  await broadcastSessionState(joinCode);
  for (const cached of sessionStateCache.replay(joinCode)) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(JSON.stringify(cached));
  }

  ws.on("message", async (raw) => {
    const meta = connections.get(ws);
    if (!meta) return;

    // Freno por socket: descarta el exceso sin cerrar la conexión.
    const now = Date.now();
    if (now - meta.msgWindowStart >= 1000) {
      meta.msgWindowStart = now;
      meta.msgCount = 0;
    }
    meta.msgCount += 1;
    if (meta.msgCount > WS_MAX_MESSAGES_PER_SECOND) {
      if (meta.msgCount === WS_MAX_MESSAGES_PER_SECOND + 1) {
        audit("ws-flood-dropped", { joinCode: meta.joinCode, ip });
      }
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());
      // Ping real de ida y vuelta — el cliente mide su propio RTT con esto,
      // no un número inventado.
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", clientSentAt: msg.clientSentAt, serverTime: Date.now() }));
        return;
      }

      if (FLIGHT_MESSAGE_TYPES.has(msg.type)) {
        const error = validateFlightMessage(msg);
        if (error) {
          // mensaje mal formado — se descarta, no se retransmite ni se cae la conexión
          console.warn(`[ws] mensaje de vuelo rechazado (${error}) de ${pilotName}@${joinCode}`);
          return;
        }
        // Un socket solo puede inyectar mensajes de SU sesión: si el mensaje
        // trae sessionId, tiene que coincidir con el joinCode autenticado.
        if (typeof msg.sessionId === "string" && msg.sessionId !== meta.joinCode) {
          console.warn(`[ws] sessionId ajeno rechazado de ${pilotName}@${joinCode}`);
          return;
        }
        // Gate de autoridad/anti-ciclo real (packages/synchronization-core)
        // para control.event/control.axis: ver packages/protocol/README.md,
        // "MVP de autoridad: grupo único flight_controls". aircraft.snapshot
        // y authority.transfer (peer-to-peer, no el authoritativo de
        // give-controls) siguen siendo relay puro, sin gate ni dedupe por
        // secuencia de LoopGuard (no tienen controlId/sequence propios en el
        // mismo sentido que un control individual).
        if (msg.type === "control.event" || msg.type === "control.axis") {
          const authorityState = ensureSessionAuthority(meta.joinCode, undefined);
          const decision = canRelayControlMessage(authorityState, meta.seat, msg.controlId, msg.sequence);
          if (!decision.ok) {
            console.warn(
              `[ws] control descartado (${decision.reason}) controlId=${msg.controlId} de ${pilotName}@${joinCode}`
            );
            return;
          }
        }
        if (msg.type === "flight.pose") {
          const authorityState = ensureSessionAuthority(meta.joinCode, undefined);
          if (!authorityState.authorityManager.canWrite(FLIGHT_CONTROLS_GROUP_ID, meta.seat as any)) {
            console.warn(`[ws] flight.pose descartado (no-authority) de ${pilotName}@${joinCode}`);
            return;
          }
        }
        relayFlightMessage(ws, meta.joinCode, meta.pilotName, msg);
        return;
      }
    } catch {
      // mensaje malformado — se ignora, no se cae la conexión
    }
  });

  ws.on("close", async () => {
    const meta = connections.get(ws);
    connections.delete(ws);
    if (meta) {
      await markDisconnected(meta.joinCode, meta.pilotName);
      await broadcastSessionState(meta.joinCode);
    }
  });
});

async function main() {
  await dbReady;
  await syncAircraftProfiles(scanAircraftProfiles());

  httpServer.listen(PORT, () => {
    console.log(`Shared Cockpit API real corriendo en http://localhost:${PORT}`);
    console.log(`WebSocket de sesión en ws://localhost:${PORT}/ws`);
  });
}

main().catch((err) => {
  console.error("[server] fallo fatal al arrancar:", err.message ?? err);
  process.exit(1);
});
