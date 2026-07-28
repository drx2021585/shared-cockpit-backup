/**
 * Tests de server/api/src/db.ts contra un Postgres FALSO en memoria.
 *
 * db.ts requiere DATABASE_URL real y usa `pg.Pool` directamente (no hay modo
 * mock/in-memory nativo, ni SQLite de respaldo — ver comentario al inicio de
 * db.ts). Este entorno NO tiene un Postgres real disponible, así que estos
 * tests interceptan el módulo "pg" con `t.mock.module()` (node:test,
 * requiere el flag --experimental-test-module-mocks) y sustituyen `Pool` por
 * el fake de test/support/fakePg.ts, que reproduce en memoria la semántica
 * exacta de cada consulta SQL que db.ts ejecuta.
 *
 * IMPORTANTE: esto NO es lo mismo que correr contra Postgres real. Cubre la
 * lógica de negocio en db.ts (control_owner/control_requested_by/
 * control_revision, resolución pilotName->seat, etc.) pero no valida
 * comportamiento específico de Postgres (constraints, tipos de columna,
 * concurrencia real de transacciones). Si se dispone de un Postgres real,
 * correr también contra él vía DATABASE_URL es responsabilidad de qa-agent /
 * CI, no de este archivo.
 *
 * Cada test importa src/db.ts de nuevo con un query string único en el
 * specifier para forzar una reevaluación fresca del módulo (y así un
 * `pool`/`dbReady` nuevos, aislados de otros tests en el mismo archivo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFakePgModule } from "./support/fakePg.ts";

process.env.DATABASE_URL = "postgres://fake-for-tests/fake";

let importCounter = 0;
async function freshDb(t: any) {
  const { exportsDefault } = makeFakePgModule();
  t.mock.module("pg", { exports: { default: exportsDefault } });
  importCounter += 1;
  const mod = await import(`../src/db.ts?case=${importCounter}`);
  await mod.dbReady;
  return mod;
}

test("createSession: control_owner arranca en el seat del creador", async (t) => {
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );

  const { session } = await db.createSession({
    sessionName: "Vuelo de prueba",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });

  assert.ok(session);
  assert.equal(session!.controlOwner, "captain");
  assert.equal(session!.controlRequestedBy, null);
  assert.equal(session!.controlRevision, 0);
  assert.equal(session!.creatorPilotName, "Alice");
});

test("requestControls: un segundo jugador puede solicitar control si no es el dueño", async (t) => {
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );
  const { session: created } = await db.createSession({
    sessionName: "Vuelo de prueba",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });
  await db.joinSession({ joinCode: created!.joinCode, pilotName: "Bob", seat: "first_officer" });

  const ok = await db.requestControls(created!.joinCode, "Bob");
  assert.equal(ok, true);

  const session = await db.getSessionByCode(created!.joinCode);
  assert.equal(session!.controlRequestedBy, "first_officer");
  // Solicitar controles todavía no transfiere nada: el dueño sigue siendo el mismo.
  assert.equal(session!.controlOwner, "captain");
});

test("requestControls: rechaza si quien pide ya es el dueño actual", async (t) => {
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );
  const { session: created } = await db.createSession({
    sessionName: "Vuelo de prueba",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });

  const ok = await db.requestControls(created!.joinCode, "Alice");
  assert.equal(ok, false);
});

test("giveControls: incrementa control_revision exactamente en 1 y devuelve previousOwner/newOwner correctos", async (t) => {
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );
  const { session: created } = await db.createSession({
    sessionName: "Vuelo de prueba",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });
  await db.joinSession({ joinCode: created!.joinCode, pilotName: "Bob", seat: "first_officer" });
  await db.requestControls(created!.joinCode, "Bob");

  const transfer = await db.giveControls(created!.joinCode, "Alice");
  assert.ok(transfer);
  assert.equal(transfer!.previousOwner, "captain");
  assert.equal(transfer!.newOwner, "first_officer");
  assert.equal(transfer!.revision, 1);

  const session = await db.getSessionByCode(created!.joinCode);
  assert.equal(session!.controlOwner, "first_officer");
  assert.equal(session!.controlRequestedBy, null);
  assert.equal(session!.controlRevision, 1);

  // Una segunda transferencia real (Bob pide y Alice/Bob la cede de vuelta) debe
  // volver a incrementar en exactamente 1, no reiniciar ni saltar.
  await db.requestControls(created!.joinCode, "Alice");
  const transfer2 = await db.giveControls(created!.joinCode, "Bob");
  assert.ok(transfer2);
  assert.equal(transfer2!.revision, 2);
  assert.equal(transfer2!.previousOwner, "first_officer");
  assert.equal(transfer2!.newOwner, "captain");
});

test("giveControls: retorna null si quien la ejecuta no es el dueño actual", async (t) => {
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );
  const { session: created } = await db.createSession({
    sessionName: "Vuelo de prueba",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });
  await db.joinSession({ joinCode: created!.joinCode, pilotName: "Bob", seat: "first_officer" });
  await db.requestControls(created!.joinCode, "Bob");

  // Bob pidió el control, pero Bob (no Alice, la dueña actual) intenta "darlo".
  const transfer = await db.giveControls(created!.joinCode, "Bob");
  assert.equal(transfer, null);

  const session = await db.getSessionByCode(created!.joinCode);
  assert.equal(session!.controlOwner, "captain", "el dueño no debe cambiar en un giveControls inválido");
  assert.equal(session!.controlRevision, 0, "la revisión no debe incrementar en un giveControls inválido");
});

test("giveControls: retorna null si no hay solicitud pendiente", async (t) => {
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );
  const { session: created } = await db.createSession({
    sessionName: "Vuelo de prueba",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });
  await db.joinSession({ joinCode: created!.joinCode, pilotName: "Bob", seat: "first_officer" });
  // Nadie llamó requestControls todavía.

  const transfer = await db.giveControls(created!.joinCode, "Alice");
  assert.equal(transfer, null);

  const session = await db.getSessionByCode(created!.joinCode);
  assert.equal(session!.controlOwner, "captain");
  assert.equal(session!.controlRevision, 0);
});

test("leaveSession: reasigna control_owner al otro asiento activo si el que se va era el dueño", async (t) => {
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );
  const { session: created } = await db.createSession({
    sessionName: "Vuelo de prueba",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });
  await db.joinSession({ joinCode: created!.joinCode, pilotName: "Bob", seat: "first_officer" });

  // Alice (captain, dueña actual del control) se va.
  const ok = await db.leaveSession(created!.joinCode, "Alice");
  assert.equal(ok, true);

  const session = await db.getSessionByCode(created!.joinCode);
  assert.equal(
    session!.controlOwner,
    "first_officer",
    "el control debe reasignarse al otro asiento activo (Bob) cuando el dueño se va"
  );
  assert.equal(session!.controlRequestedBy, null);
});

test("leaveSession limpia control_owner/control_requested_by cuando el dueño se va y no queda nadie más", async (t) => {
  // Escenario: el creador (Alice, captain, dueña del control) es el ÚNICO
  // participante y se va. leaveSession busca "el otro asiento activo"
  // (session.participants.find(p => p.pilot_name !== pilotName)), no lo
  // encuentra, y el fallback "usar el seat del creador de la sesión"
  // (session.creatorPilotName) ahora se salta explícitamente cuando el
  // creador ES quien se está yendo (ver db.ts, leaveSession). Como resultado,
  // control_owner y control_requested_by quedan en NULL en vez de apuntar a
  // un seat cuyo único ocupante ya está desconectado.
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );
  const { session: created } = await db.createSession({
    sessionName: "Vuelo en solitario",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });

  const ok = await db.leaveSession(created!.joinCode, "Alice");
  assert.equal(ok, true);

  const session = await db.getSessionByCode(created!.joinCode);
  assert.equal(
    session!.controlOwner,
    null,
    "control_owner debe quedar null cuando el dueño se va y no queda nadie más conectado"
  );
  assert.equal(session!.controlRequestedBy, null);
  assert.equal(session!.participants.length, 0, "no debería quedar nadie conectado en la sesión");
});

test("leaveSession: no toca control_owner si quien se va no era el dueño", async (t) => {
  const db = await freshDb(t);
  await db.pool.query(
    "INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    ["pmdg-737-900", "PMDG B737 NG", "PMDG", "1.0", 80, "{}", true, true]
  );
  const { session: created } = await db.createSession({
    sessionName: "Vuelo de prueba",
    aircraftProfileId: "pmdg-737-900",
    hostPilotName: "Alice",
    hostSeat: "captain",
    sim: "msfs2020",
  });
  await db.joinSession({ joinCode: created!.joinCode, pilotName: "Bob", seat: "first_officer" });

  const ok = await db.leaveSession(created!.joinCode, "Bob");
  assert.equal(ok, true);

  const session = await db.getSessionByCode(created!.joinCode);
  assert.equal(session!.controlOwner, "captain");
});
