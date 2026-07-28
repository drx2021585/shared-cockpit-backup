/**
 * Integración real (tests-agent): ejercita el RELAY REAL de server/api
 * (server/api/src/server.ts, wss.on("connection")/ws.on("message")), no
 * synchronization-core aislado (eso ya está cubierto por
 * server/api/test/authority.test.ts, 8 tests sin DB/red, y por
 * tests/network/*.test.ts). Este archivo levanta el servidor Express+WS
 * REAL, con dos WebSockets reales conectados como si fueran dos asientos de
 * una misma sesión, y comprueba el comportamiento observable de punta a
 * punta: qué mensaje llega al OTRO cliente y cuál se descarta en silencio.
 *
 * Limitación real documentada (no un mock frágil inventado): server/api/src/db.ts
 * exige DATABASE_URL real y usa pg.Pool directamente, sin fallback local (ver
 * comentario al inicio de db.ts). Este entorno no tiene Postgres real
 * disponible. server/api/test/db.test.ts ya resolvió este mismo problema
 * antes que este archivo existiera: intercepta el módulo "pg" con
 * node:test (`mock.module`, requiere --experimental-test-module-mocks) y lo
 * sustituye por server/api/test/support/fakePg.ts, un fake en memoria que
 * reproduce la semántica exacta de cada consulta SQL de db.ts. Este archivo
 * reutiliza ESE MISMO fake (no inventa uno nuevo) para poder levantar
 * server.ts completo -- Express real, WebSocketServer real, authority.ts
 * real, db.ts real -- sin Postgres real. Si algún día hay Postgres real
 * disponible en CI, correr este mismo archivo contra DATABASE_URL real
 * (quitando el mock.module de "pg") sería una validación estrictamente más
 * fuerte, pero fuera del alcance de qa-agent decidir esa infraestructura.
 *
 * server.ts no exporta `httpServer`/`wss` (es un script, no un módulo
 * pensado para testing) -- no se modifica ese archivo (dominio de
 * networking-agent) para agregarle exports. Como consecuencia, este archivo
 * no puede cerrar el servidor "a mano" al terminar; en vez de eso, el hook
 * `after()` fuerza `process.exit(0)` tras dar tiempo a que el reporter de
 * node:test imprima resultados. Esto es intencional y autocontenido (no
 * depende de flags de ejecución), aunque también funciona bien combinado con
 * `--test-force-exit` (Node >= 22.7) si se prefiere ese mecanismo.
 *
 * Ejecutar:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *     --test tests/integration/authority_relay.test.ts
 */
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { makeFakePgModule } from "../../server/api/test/support/fakePg.ts";

// --- 1. Puerto libre real (evita colisiones con otro proceso/servidor local) ---
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const PORT = await getFreePort();
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

process.env.PORT = String(PORT);
process.env.DATABASE_URL = "postgres://fake-for-tests/fake";

// --- 2. Mock de "pg" (mismo fake que server/api/test/db.test.ts) ANTES de
// importar server.ts, para que db.ts (importado transitivamente por
// server.ts) construya su Pool sobre el fake en memoria, nunca contra
// Postgres real.
//
// mock.module() resuelve el specifier desde el archivo que lo invoca -- este
// archivo vive en tests/integration/, que no tiene su propio node_modules/pg
// (solo server/api/node_modules/pg lo tiene). Por eso resolvemos "pg" con la
// misma semántica CommonJS que usaría un import desde dentro de server/api
// (createRequire con base en ese paquete) y le pasamos a mock.module() la
// ruta absoluta ya resuelta, en vez del specifier desnudo "pg". ---
const requireFromServerApi = createRequire(new URL("../../server/api/test/", import.meta.url));
const resolvedPgPath = requireFromServerApi.resolve("pg");
const resolvedPgUrl = pathToFileURL(resolvedPgPath).href;
const { exportsDefault: fakePgExports } = makeFakePgModule();
mock.module(resolvedPgUrl, { exports: { default: fakePgExports } });

// --- 3. Levanta el servidor real. server.ts corre `main()` (no exportado) al
// importarse: escanea aircraft-profiles/ real, siembra el catálogo en el pg
// fake, y llama httpServer.listen(PORT). ---
await import("../../server/api/src/server.ts");

async function waitForServerReady(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // todavía no está escuchando -- reintentar
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("server/api real (test) nunca quedó listo en /api/health");
}

await waitForServerReady();

// --- Helpers de alto nivel sobre la API real (HTTP + WS), sin tocar authority.ts
// directamente: todo pasa por los mismos endpoints/mensajes que usaría un
// cliente real (apps/desktop-ui). ---

interface CreatedSession {
  joinCode: string;
  hostToken: string;
  hostPilotName: string;
}

async function createPmdgSession(hostPilotName: string, hostSeat: "captain" | "first_officer"): Promise<CreatedSession> {
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionName: `Vuelo de prueba ${hostPilotName}`,
      aircraftProfileId: "pmdg-737-900",
      hostPilotName,
      hostSeat,
      sim: "msfs2020",
    }),
  });
  assert.equal(res.status, 201, "createSession debe responder 201");
  const body = await res.json();
  return { joinCode: body.joinCode, hostToken: body.participantToken, hostPilotName };
}

async function joinSessionAs(
  joinCode: string,
  pilotName: string,
  seat: "captain" | "first_officer"
): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/sessions/${joinCode}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pilotName, seat }),
  });
  assert.equal(res.status, 200, "join debe responder 200");
  const body = await res.json();
  return body.participantToken as string;
}

interface ConnectedSeat {
  socket: WebSocket;
  received: any[];
}

async function connectSeat(joinCode: string, token: string): Promise<ConnectedSeat> {
  const socket = new WebSocket(`${WS_URL}?code=${joinCode}&token=${token}`);
  const received: any[] = [];
  socket.addEventListener("message", (ev) => {
    try {
      received.push(JSON.parse(String(ev.data)));
    } catch {
      // ignorado -- no relevante para estas aserciones
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("ws error al conectar")), { once: true });
  });
  return { socket, received };
}

function controlEvents(received: any[], controlId: string): any[] {
  return received.filter((m) => m.type === "control.event" && m.controlId === controlId);
}

async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------
// Caso 1: control exclusive (flight.yoke.pitch) -- solo el dueño de
// autoridad (captain, dueño por defecto al crear la sesión) ve su mensaje
// reenviado; el mensaje del asiento sin autoridad (first officer) se
// descarta en silencio, sin cerrar la conexión de ningún socket.
// -----------------------------------------------------------------------
test("relay real: flight.yoke.pitch -- solo el dueño de flight_controls llega al otro cliente", async () => {
  const created = await createPmdgSession("Alice", "captain");
  const foToken = await joinSessionAs(created.joinCode, "Bob", "first_officer");

  const captain = await connectSeat(created.joinCode, created.hostToken);
  const firstOfficer = await connectSeat(created.joinCode, foToken);
  await settle();

  // Bob (first officer, SIN autoridad sobre flight_controls) intenta escribir
  // el yoke -- debe descartarse en silencio: Alice (captain) nunca lo ve.
  firstOfficer.socket.send(
    JSON.stringify({
      type: "control.event",
      sessionId: created.joinCode,
      controlId: "flight.yoke.pitch",
      value: 0.42,
      source: "bob-bridge",
      sequence: 1,
      timestamp: Date.now(),
    })
  );
  await settle();
  assert.equal(
    controlEvents(captain.received, "flight.yoke.pitch").length,
    0,
    "el capitán NUNCA debe recibir el yoke escrito por el first officer sin autoridad"
  );

  // Alice (captain, dueña real de flight_controls) escribe el mismo control
  // -- SÍ debe llegar a Bob, marcado origin: remote (regla no negociable).
  captain.socket.send(
    JSON.stringify({
      type: "control.event",
      sessionId: created.joinCode,
      controlId: "flight.yoke.pitch",
      value: -0.15,
      source: "alice-bridge",
      sequence: 1,
      timestamp: Date.now(),
    })
  );
  await settle();
  const relayed = controlEvents(firstOfficer.received, "flight.yoke.pitch");
  assert.equal(relayed.length, 1, "el first officer SÍ debe recibir el yoke escrito por el capitán (dueño real)");
  assert.equal(relayed[0].origin, "remote", "todo mensaje reenviado por red debe marcarse origin: remote");
  assert.equal(relayed[0].sourcePilot, "Alice", "sourcePilot debe salir de la identidad autenticada del socket");
  assert.equal(relayed[0].value, -0.15);

  // Ninguna de las dos conexiones se cerró por el mensaje descartado.
  assert.equal(captain.socket.readyState, WebSocket.OPEN);
  assert.equal(firstOfficer.socket.readyState, WebSocket.OPEN);

  captain.socket.close();
  firstOfficer.socket.close();
});

// -----------------------------------------------------------------------
// Caso 2: control shared (flight.flaps) -- se reenvía sin importar quién lo
// envíe, ninguno de los dos asientos es "dueño" de un control shared.
// -----------------------------------------------------------------------
test("relay real: flight.flaps (shared) se reenvía sin importar quién lo escriba", async () => {
  const created = await createPmdgSession("Carol", "captain");
  const foToken = await joinSessionAs(created.joinCode, "Dave", "first_officer");

  const captain = await connectSeat(created.joinCode, created.hostToken);
  const firstOfficer = await connectSeat(created.joinCode, foToken);
  await settle();

  // Dave (first officer, sin ser dueño de flight_controls) escribe flaps --
  // flight.flaps es authority: shared en aircraft-profiles/pmdg-737-900, así
  // que NO pasa por el gate de flight_controls y debe llegar a Carol.
  firstOfficer.socket.send(
    JSON.stringify({
      type: "control.event",
      sessionId: created.joinCode,
      controlId: "flight.flaps",
      value: 5,
      source: "dave-bridge",
      sequence: 1,
      timestamp: Date.now(),
    })
  );
  await settle();
  const fromDave = controlEvents(captain.received, "flight.flaps");
  assert.equal(fromDave.length, 1, "flight.flaps escrito por el first officer SÍ debe llegar al capitán");
  assert.equal(fromDave[0].origin, "remote");
  assert.equal(fromDave[0].sourcePilot, "Dave");

  // Carol (captain) también puede escribirlo -- llega a Dave igual.
  captain.socket.send(
    JSON.stringify({
      type: "control.event",
      sessionId: created.joinCode,
      controlId: "flight.flaps",
      value: 10,
      source: "carol-bridge",
      // LoopGuard deduplica por (controlId, sequence) sin importar quién lo
      // envía -- una sesión, un contador de secuencia por control, no por
      // asiento. sequence: 2 (no 1) para que esta escritura de Carol no se
      // confunda con un duplicado de la de Dave (sequence: 1) sobre el mismo
      // controlId.
      sequence: 2,
      timestamp: Date.now(),
    })
  );
  await settle();
  const fromCarol = controlEvents(firstOfficer.received, "flight.flaps");
  assert.equal(fromCarol.length, 1, "flight.flaps escrito por el capitán también debe llegar al first officer");
  assert.equal(fromCarol[0].sourcePilot, "Carol");

  captain.socket.close();
  firstOfficer.socket.close();
});

// -----------------------------------------------------------------------
// Caso 3: tras una transferencia de autoridad real vía
// POST /api/sessions/:code/give-controls, el NUEVO dueño puede escribir
// flight_controls inmediatamente -- verifica el fix de syncFlightControlsOwner
// (server/api/src/authority.ts): antes de ese fix, el nuevo dueño se habría
// quedado bloqueado para siempre porque el AuthorityManager en memoria nunca
// se resembraba tras un give-controls exitoso en Postgres.
// -----------------------------------------------------------------------
test("relay real: tras give-controls exitoso, el nuevo dueño escribe flight_controls de inmediato", async () => {
  const created = await createPmdgSession("Erin", "captain");
  const foToken = await joinSessionAs(created.joinCode, "Frank", "first_officer");

  const captain = await connectSeat(created.joinCode, created.hostToken);
  const firstOfficer = await connectSeat(created.joinCode, foToken);
  await settle();

  // Antes de la transferencia: Frank (first officer) NO puede escribir el
  // rudder -- Erin (captain) sigue siendo la dueña.
  firstOfficer.socket.send(
    JSON.stringify({
      type: "control.event",
      sessionId: created.joinCode,
      controlId: "flight.rudder",
      value: 0.2,
      source: "frank-bridge",
      sequence: 1,
      timestamp: Date.now(),
    })
  );
  await settle();
  assert.equal(
    controlEvents(captain.received, "flight.rudder").length,
    0,
    "antes de la transferencia, Frank no debe poder escribir flight_controls"
  );

  // Flujo real de transferencia: Frank pide el control, Erin lo cede vía HTTP
  // (mismos endpoints que usa apps/desktop-ui).
  const requestRes = await fetch(`${BASE_URL}/api/sessions/${created.joinCode}/request-controls`, {
    method: "POST",
    headers: { authorization: `Bearer ${foToken}` },
  });
  assert.equal(requestRes.status, 204);

  const giveRes = await fetch(`${BASE_URL}/api/sessions/${created.joinCode}/give-controls`, {
    method: "POST",
    headers: { authorization: `Bearer ${created.hostToken}` },
  });
  assert.equal(giveRes.status, 204);

  // El give-controls exitoso también debe emitir un authority.transfer
  // autoritativo por WebSocket a ambos sockets (server.ts, broadcastAuthorityTransfer).
  await settle();
  const transferSeenByCaptain = captain.received.find((m) => m.type === "authority.transfer");
  assert.ok(transferSeenByCaptain, "el capitán debe recibir el authority.transfer autoritativo tras give-controls");
  assert.equal(transferSeenByCaptain.previousOwner, "captain");
  assert.equal(transferSeenByCaptain.newOwner, "first_officer");

  // Inmediatamente después (mismo proceso, sin reconexión de ningún socket):
  // Frank, el NUEVO dueño, SÍ debe poder escribir flight.rudder ya mismo.
  firstOfficer.socket.send(
    JSON.stringify({
      type: "control.event",
      sessionId: created.joinCode,
      controlId: "flight.rudder",
      value: -0.3,
      source: "frank-bridge",
      sequence: 2,
      timestamp: Date.now(),
    })
  );
  await settle();
  const relayedToCaptain = controlEvents(captain.received, "flight.rudder");
  assert.equal(
    relayedToCaptain.length,
    1,
    "tras el fix de syncFlightControlsOwner, el nuevo dueño (Frank) debe poder escribir flight_controls de inmediato, sin quedar bloqueado para siempre"
  );
  assert.equal(relayedToCaptain[0].value, -0.3);
  assert.equal(relayedToCaptain[0].sourcePilot, "Frank");

  // Y el dueño anterior (Erin) ya NO puede: el mismo control exclusive no
  // puede tener dos escritores simultáneos.
  captain.socket.send(
    JSON.stringify({
      type: "control.event",
      sessionId: created.joinCode,
      controlId: "flight.yoke.roll",
      value: 0.1,
      source: "erin-bridge",
      sequence: 1,
      timestamp: Date.now(),
    })
  );
  await settle();
  assert.equal(
    controlEvents(firstOfficer.received, "flight.yoke.roll").length,
    0,
    "Erin (dueña anterior) ya no debe poder escribir flight_controls tras cederlos"
  );

  captain.socket.close();
  firstOfficer.socket.close();
});

after(async () => {
  // server.ts no expone httpServer/wss para cerrarlos "a mano" (no se
  // modifica ese archivo -- dominio de networking-agent). Forzamos la
  // terminación del proceso de este archivo de test (node --test corre cada
  // archivo en su propio proceso hijo) tras dar un margen para que el
  // reporter imprima resultados.
  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
});
