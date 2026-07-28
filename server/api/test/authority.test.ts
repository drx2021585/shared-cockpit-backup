/**
 * Tests del adaptador server/api/src/authority.ts, que cablea
 * packages/synchronization-core (AuthorityManager/LoopGuard) al relay de
 * control.event/control.axis de src/server.ts. Ver packages/protocol/
 * README.md, sección "MVP de autoridad: grupo único flight_controls".
 *
 * Corre sin base de datos ni red -- authority.ts solo depende de
 * synchronization-core y de leer aircraft-profiles/*\/controls/*.yaml del
 * disco (real, no mockeado: son los manifests reales del repo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canRelayControlMessage,
  ensureSessionAuthority,
  getSessionAuthorityForTest,
  clearSessionAuthority,
  syncFlightControlsOwner,
  FLIGHT_CONTROLS_GROUP_ID,
} from "../src/authority.ts";

let joinCodeCounter = 0;
function freshJoinCode(): string {
  joinCodeCounter += 1;
  return `TST-${joinCodeCounter}`;
}

test("ensureSessionAuthority: siembra flight_controls con el control_owner real, nunca null", () => {
  const joinCode = freshJoinCode();
  const state = ensureSessionAuthority(joinCode, "first_officer");
  assert.equal(state.authorityManager.getOwner(FLIGHT_CONTROLS_GROUP_ID), "first_officer");

  // Llamar de nuevo con un control_owner distinto NO debe resembrar/pisar el
  // estado en memoria ya existente (ver comentario de ensureSessionAuthority:
  // el owner en memoria puede haber cambiado desde la última consulta a la
  // base por un authority.transfer real).
  const stateAgain = ensureSessionAuthority(joinCode, "captain");
  assert.equal(stateAgain, state);
  assert.equal(stateAgain.authorityManager.getOwner(FLIGHT_CONTROLS_GROUP_ID), "first_officer");

  clearSessionAuthority(joinCode);
});

test("ensureSessionAuthority: control_owner null/undefined cae a captain, nunca deja el grupo sin dueño", () => {
  const joinCode = freshJoinCode();
  const state = ensureSessionAuthority(joinCode, null);
  assert.equal(state.authorityManager.getOwner(FLIGHT_CONTROLS_GROUP_ID), "captain");
  assert.equal(state.authorityManager.canWrite(FLIGHT_CONTROLS_GROUP_ID, "captain"), true);
  clearSessionAuthority(joinCode);
});

test("canRelayControlMessage: un segundo jugador SIN autoridad sobre flight_controls es descartado", () => {
  const joinCode = freshJoinCode();
  const state = ensureSessionAuthority(joinCode, "captain");

  // El first officer no es dueño de flight_controls -> se descarta.
  const rejected = canRelayControlMessage(state, "first_officer", "flight.yoke.pitch", 1);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "no-authority");

  // El capitán (dueño real) sí puede.
  const accepted = canRelayControlMessage(state, "captain", "flight.yoke.pitch", 1);
  assert.equal(accepted.ok, true);

  clearSessionAuthority(joinCode);
});

test("canRelayControlMessage: un control authority:shared pasa sin restricción para cualquier asiento", () => {
  const joinCode = freshJoinCode();
  const state = ensureSessionAuthority(joinCode, "captain");

  // flight.flaps es authority:shared (aircraft-profiles/pmdg-737-900/
  // controls/flight-controls.yaml) -- no pertenece a flight_controls
  // (los 6 exclusive) ni al mapa de seat-restricted, así que el gate de
  // grupo no aplica y el mensaje pasa para AMBOS asientos.
  const fromFirstOfficer = canRelayControlMessage(state, "first_officer", "flight.flaps", 1);
  assert.equal(fromFirstOfficer.ok, true);

  const fromCaptain = canRelayControlMessage(state, "captain", "flight.flaps", 2);
  assert.equal(fromCaptain.ok, true);

  clearSessionAuthority(joinCode);
});

test("canRelayControlMessage: un control captain-only (autopilot) descarta al first officer", () => {
  const joinCode = freshJoinCode();
  const state = ensureSessionAuthority(joinCode, "captain");

  // autopilot.master es authority:captain-only en
  // aircraft-profiles/pmdg-737-900/controls/autopilot.yaml (y en
  // ifly-737-max8), no forma parte de flight_controls -- cambio de
  // comportamiento esperado documentado en packages/protocol/README.md,
  // punto 3: antes de este cambio esto pasaba sin gate, ahora se enforza.
  const fromFirstOfficer = canRelayControlMessage(state, "first_officer", "autopilot.master", 1);
  assert.equal(fromFirstOfficer.ok, false);
  if (!fromFirstOfficer.ok) assert.equal(fromFirstOfficer.reason, "no-authority");

  const fromCaptain = canRelayControlMessage(state, "captain", "autopilot.master", 1);
  assert.equal(fromCaptain.ok, true);

  clearSessionAuthority(joinCode);
});

test("canRelayControlMessage: LoopGuard descarta una secuencia duplicada/fuera de orden incluso para controles shared", () => {
  const joinCode = freshJoinCode();
  const state = ensureSessionAuthority(joinCode, "captain");

  const first = canRelayControlMessage(state, "captain", "flight.flaps", 5);
  assert.equal(first.ok, true);

  // Misma secuencia otra vez (duplicado/retransmisión) -- LoopGuard debe
  // descartarlo, no AuthorityManager (flight.flaps es shared, siempre puede
  // escribir el capitán).
  const duplicate = canRelayControlMessage(state, "captain", "flight.flaps", 5);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.reason, "loop-guard-duplicate");

  clearSessionAuthority(joinCode);
});

test("syncFlightControlsOwner: refleja un give-controls exitoso (Postgres) en el AuthorityManager en memoria", () => {
  const joinCode = freshJoinCode();
  const state = ensureSessionAuthority(joinCode, "captain");

  // Antes del transfer: el FO no puede escribir flight.yoke.pitch.
  const beforeTransfer = canRelayControlMessage(state, "first_officer", "flight.yoke.pitch", 1);
  assert.equal(beforeTransfer.ok, false);

  // Simula el resultado de un give-controls exitoso en db.ts (previousOwner
  // captain -> newOwner first_officer).
  syncFlightControlsOwner(joinCode, "first_officer");

  assert.equal(state.authorityManager.getOwner(FLIGHT_CONTROLS_GROUP_ID), "first_officer");
  const afterTransferFO = canRelayControlMessage(state, "first_officer", "flight.yoke.pitch", 2);
  assert.equal(afterTransferFO.ok, true);
  const afterTransferCaptain = canRelayControlMessage(state, "captain", "flight.yoke.roll", 1);
  assert.equal(afterTransferCaptain.ok, false);

  clearSessionAuthority(joinCode);
});

test("clearSessionAuthority: libera el estado en memoria (una sesión nueva con el mismo joinCode resiembra desde cero)", () => {
  const joinCode = freshJoinCode();
  ensureSessionAuthority(joinCode, "first_officer");
  assert.ok(getSessionAuthorityForTest(joinCode));

  clearSessionAuthority(joinCode);
  assert.equal(getSessionAuthorityForTest(joinCode), undefined);

  const resembradoState = ensureSessionAuthority(joinCode, "captain");
  assert.equal(resembradoState.authorityManager.getOwner(FLIGHT_CONTROLS_GROUP_ID), "captain");

  clearSessionAuthority(joinCode);
});
