/**
 * Servidor real: REST para sesiones/perfiles, WebSocket para señalización en
 * vivo (lista de participantes, ping, ciclo de vida de sesión). No hay datos
 * de relleno — el catálogo de aeronaves viene de escanear aircraft-profiles/
 * y las sesiones viven en PostgreSQL real y compartido (ver db.ts, requiere
 * DATABASE_URL — no hay fallback local).
 */
import express from "express";
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
  closeSession,
  leaveSession,
  requestControls,
  giveControls,
} from "./db.ts";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptimeSeconds: process.uptime() });
});

app.get("/api/aircraft-profiles", async (_req, res) => {
  res.json(await listAircraftProfiles());
});

app.post("/api/sessions", async (req, res) => {
  const { sessionName, aircraftProfileId, password, hostPilotName, hostSeat, sim } = req.body ?? {};
  if (!sessionName || !aircraftProfileId || !hostPilotName || !hostSeat || !sim) {
    return res.status(400).json({ error: "missing required fields" });
  }
  if (sim !== "msfs2020" && sim !== "msfs2024") {
    return res.status(400).json({ error: "invalid sim" });
  }
  try {
    const session = await createSession({
      sessionName,
      aircraftProfileId,
      password,
      hostPilotName,
      hostSeat,
      sim,
    });
    res.status(201).json(session);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/sessions/:code", async (req, res) => {
  const session = await getSessionByCode(req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ error: "session-not-found" });
  res.json(session);
});

app.post("/api/sessions/:code/join", async (req, res) => {
  const { pilotName, seat, password } = req.body ?? {};
  if (!pilotName || !seat) {
    return res.status(400).json({ error: "missing required fields" });
  }
  const result = await joinSession({ joinCode: req.params.code.toUpperCase(), pilotName, seat, password });
  if (!result.ok) {
    const status = result.reason === "session-not-found" ? 404 : 409;
    return res.status(status).json({ error: result.reason });
  }
  res.json(result.session);
});

app.delete("/api/sessions/:code", async (req, res) => {
  const joinCode = req.params.code.toUpperCase();
  const { pilotName } = req.body ?? {};
  if (!pilotName) {
    return res.status(400).json({ error: "missing pilot name" });
  }
  if (!(await closeSession(joinCode, pilotName))) {
    return res.status(404).json({ error: "session-not-found" });
  }
  for (const [ws, meta] of connections) {
    if (meta.joinCode === joinCode) {
      ws.close(4001, "session closed");
    }
  }
  res.status(204).end();
});

app.post("/api/sessions/:code/leave", async (req, res) => {
  const joinCode = req.params.code.toUpperCase();
  const { pilotName } = req.body ?? {};
  if (!pilotName) return res.status(400).json({ error: "missing pilot name" });
  if (!(await leaveSession(joinCode, pilotName))) {
    return res.status(404).json({ error: "session-not-found" });
  }
  await broadcastSessionState(joinCode);
  res.status(204).end();
});

app.post("/api/sessions/:code/request-controls", async (req, res) => {
  const joinCode = req.params.code.toUpperCase();
  const { pilotName } = req.body ?? {};
  if (!pilotName) return res.status(400).json({ error: "missing pilot name" });
  if (!(await requestControls(joinCode, pilotName))) {
    return res.status(409).json({ error: "controls-request-not-allowed" });
  }
  await broadcastSessionState(joinCode);
  res.status(204).end();
});

app.post("/api/sessions/:code/give-controls", async (req, res) => {
  const joinCode = req.params.code.toUpperCase();
  const { pilotName } = req.body ?? {};
  if (!pilotName) return res.status(400).json({ error: "missing pilot name" });
  const transfer = await giveControls(joinCode, pilotName);
  if (!transfer) {
    return res.status(409).json({ error: "control-transfer-not-allowed" });
  }
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
  broadcastAuthorityTransfer(joinCode, transfer);
  await broadcastSessionState(joinCode);
  res.status(204).end();
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

interface ConnMeta {
  joinCode: string;
  pilotName: string;
}

const connections = new Map<WebSocket, ConnMeta>();

// Tipos de mensaje de vuelo que este servidor retransmite como relay puro
// (sin lógica de autoridad ni anti-ciclo: eso vive en synchronization-core).
// Forma tomada de packages/protocol/messages.schema.json — NO modificar ese
// esquema desde aquí; si falta un campo, es territorio del orchestrator.
const FLIGHT_MESSAGE_TYPES = new Set([
  "control.event",
  "control.axis",
  "aircraft.snapshot",
  "authority.transfer",
]);

/**
 * Validación mínima de forma contra messages.schema.json: solo confirma que
 * los campos requeridos están presentes y tienen el tipo básico correcto.
 * No es un validador de JSON Schema completo (no hay ajv en las deps de este
 * paquete); si se necesita validación estricta, es una decisión a nivel de
 * dependencias que le corresponde decidir al orchestrator.
 */
function validateFlightMessage(msg: any): string | null {
  if (typeof msg !== "object" || msg === null) return "not-an-object";
  const type = msg.type;
  if (typeof type !== "string") return "missing-type";

  switch (type) {
    case "control.event": {
      const required = ["sessionId", "controlId", "value", "source", "sequence", "timestamp"];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (typeof msg.sessionId !== "string") return "invalid:sessionId";
      if (typeof msg.controlId !== "string") return "invalid:controlId";
      if (!["boolean", "number", "string"].includes(typeof msg.value)) return "invalid:value";
      if (typeof msg.source !== "string") return "invalid:source";
      if (typeof msg.sequence !== "number") return "invalid:sequence";
      if (typeof msg.timestamp !== "number") return "invalid:timestamp";
      return null;
    }
    case "control.axis": {
      const required = ["controlId", "value", "sequence", "timestamp"];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (typeof msg.controlId !== "string") return "invalid:controlId";
      if (typeof msg.value !== "number") return "invalid:value";
      if (typeof msg.sequence !== "number") return "invalid:sequence";
      if (typeof msg.timestamp !== "number") return "invalid:timestamp";
      return null;
    }
    case "aircraft.snapshot": {
      const required = ["revision", "profile", "systems"];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (typeof msg.revision !== "number") return "invalid:revision";
      if (typeof msg.profile !== "string") return "invalid:profile";
      if (typeof msg.systems !== "object" || msg.systems === null) return "invalid:systems";
      return null;
    }
    case "authority.transfer": {
      const required = ["group", "previousOwner", "newOwner", "revision"];
      for (const field of required) {
        if (!(field in msg)) return `missing-field:${field}`;
      }
      if (typeof msg.group !== "string") return "invalid:group";
      if (typeof msg.previousOwner !== "string") return "invalid:previousOwner";
      if (typeof msg.newOwner !== "string") return "invalid:newOwner";
      if (typeof msg.revision !== "number") return "invalid:revision";
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
 */
function relayFlightMessage(senderWs: WebSocket, joinCode: string, pilotName: string, msg: any) {
  const outgoing = { ...msg, origin: "remote", sourcePilot: pilotName };
  const payload = JSON.stringify(outgoing);
  for (const [ws, meta] of connections) {
    if (ws === senderWs) continue;
    if (meta.joinCode === joinCode && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// El MVP solo tiene un grupo de controles transferible ("flight_controls").
// Si más adelante hace falta más de un grupo (luces, radios, etc.), el
// groupId debería venir del perfil de aeronave activo de la sesión
// (packages/profile-schema), no seguir hardcodeado aquí.
const FLIGHT_CONTROLS_GROUP_ID = "flight_controls";

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
  const url = new URL(req.url ?? "", "http://localhost");
  const joinCode = (url.searchParams.get("code") ?? "").toUpperCase();
  const pilotName = url.searchParams.get("pilot") ?? "";

  if (!joinCode || !pilotName || !(await getSessionByCode(joinCode))) {
    ws.close(4000, "invalid session or pilot");
    return;
  }

  connections.set(ws, { joinCode, pilotName });
  await broadcastSessionState(joinCode);

  ws.on("message", async (raw) => {
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
        const meta = connections.get(ws);
        if (meta) {
          relayFlightMessage(ws, meta.joinCode, meta.pilotName, msg);
        }
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
