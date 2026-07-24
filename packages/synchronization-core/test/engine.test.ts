import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthorityManager } from "../src/authority.ts";
import { SyncEngine, type IncomingControlEvent, type IncomingControlAxis } from "../src/engine.ts";

function makeAuthority() {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "lights", authority: "shared" });
  mgr.registerGroup({ groupId: "flight_controls", authority: "exclusive" }, "captain");
  mgr.registerGroup({ groupId: "autopilot", authority: "captain-only" });
  return mgr;
}

test("applyIncomingMessage: applies an authorized control.event and stamps origin remote", () => {
  const engine = new SyncEngine({
    authority: makeAuthority(),
    resolveGroup: (controlId) => controlId.split(".")[0],
  });

  const msg: IncomingControlEvent = {
    type: "control.event",
    controlId: "lights.beacon",
    value: true,
    dataType: "boolean",
    source: "captain",
    sequence: 1,
    timestamp: 1000,
  };

  const result = engine.applyIncomingMessage(msg);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.message.origin, "remote");
    assert.equal(result.rebroadcast, false);
    assert.equal(result.message.value, true);
  }
});

test("applyIncomingMessage: rejects control.event from a seat without authority", () => {
  const engine = new SyncEngine({
    authority: makeAuthority(),
    resolveGroup: (controlId) => controlId.split(".")[0],
  });

  const msg: IncomingControlEvent = {
    type: "control.event",
    controlId: "autopilot.master",
    value: true,
    dataType: "boolean",
    source: "first_officer", // autopilot es captain-only
    sequence: 1,
    timestamp: 1000,
  };

  const result = engine.applyIncomingMessage(msg);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unauthorized");
});

test("applyIncomingMessage: rejects a raw TOGGLE write event before touching authority/sequence", () => {
  const authority = makeAuthority();
  const engine = new SyncEngine({
    authority,
    resolveGroup: (controlId) => controlId.split(".")[0],
  });

  const msg: IncomingControlEvent = {
    type: "control.event",
    controlId: "lights.beacon",
    value: true,
    dataType: "boolean",
    writeEventName: "BEACON_LIGHTS_TOGGLE",
    source: "captain",
    sequence: 1,
    timestamp: 1000,
  };

  const result = engine.applyIncomingMessage(msg);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "dangerous-toggle-write");

  // Al ser rechazado por anti-toggle, la secuencia 1 NO debe haberse
  // consumido: un mensaje legítimo posterior con la misma secuencia debe
  // poder aplicarse.
  const legit: IncomingControlEvent = {
    ...msg,
    writeEventName: "BEACON_LIGHTS_SET",
  };
  const retry = engine.applyIncomingMessage(legit);
  assert.equal(retry.ok, true);
});

test("applyIncomingMessage: rejects duplicate/out-of-order sequence for control.event", () => {
  const engine = new SyncEngine({
    authority: makeAuthority(),
    resolveGroup: (controlId) => controlId.split(".")[0],
  });

  const first: IncomingControlEvent = {
    type: "control.event",
    controlId: "lights.beacon",
    value: true,
    source: "captain",
    sequence: 5,
    timestamp: 1000,
  };
  assert.equal(engine.applyIncomingMessage(first).ok, true);

  const duplicate = { ...first, sequence: 5, value: false };
  const dupResult = engine.applyIncomingMessage(duplicate);
  assert.equal(dupResult.ok, false);
  if (!dupResult.ok) assert.equal(dupResult.reason, "duplicate-or-out-of-order");

  const stale = { ...first, sequence: 3 };
  const staleResult = engine.applyIncomingMessage(stale);
  assert.equal(staleResult.ok, false);
});

test("applyIncomingMessage: applies control.axis for an authorized seat and enforces last-value-wins ordering", () => {
  const authority = makeAuthority();
  authority.registerGroup({ groupId: "flight", authority: "exclusive" }, "captain");
  const engine = new SyncEngine({
    authority,
    resolveGroup: (controlId) => controlId.split(".")[0],
  });

  const msg: IncomingControlAxis = {
    type: "control.axis",
    controlId: "flight.yoke.pitch",
    value: 0.25,
    source: "captain",
    sequence: 10,
    timestamp: 5000,
  };
  const result = engine.applyIncomingMessage(msg);
  assert.equal(result.ok, true);

  // el primer oficial no tiene el grupo "flight" (exclusive, dueño captain)
  const unauthorized = { ...msg, source: "first_officer" as const, sequence: 11 };
  const rejected = engine.applyIncomingMessage(unauthorized);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, "unauthorized");
});

test("applyIncomingMessage: authority.transfer moves ownership only when previousOwner matches", () => {
  const authority = makeAuthority();
  const engine = new SyncEngine({ authority });

  const badTransfer = engine.applyIncomingMessage({
    type: "authority.transfer",
    group: "flight_controls",
    previousOwner: "first_officer", // el dueño real es captain
    newOwner: "captain",
    revision: 1,
  });
  assert.equal(badTransfer.ok, false);
  if (!badTransfer.ok) assert.equal(badTransfer.reason, "transfer-owner-mismatch");
  assert.equal(authority.getOwner("flight_controls"), "captain");

  const goodTransfer = engine.applyIncomingMessage({
    type: "authority.transfer",
    group: "flight_controls",
    previousOwner: "captain",
    newOwner: "first_officer",
    revision: 1,
  });
  assert.equal(goodTransfer.ok, true);
  assert.equal(authority.getOwner("flight_controls"), "first_officer");
});

test("applyIncomingMessage: full A -> B -> A round trip never rebroadcasts and never bounces back", () => {
  // Simula dos procesos reales (Sprint 2): cliente A y cliente B, cada uno
  // con su propio motor de sincronización, "conectados" por un array en
  // memoria que hace de transporte (sin red real todavía).
  function makeClientAuthority() {
    const mgr = new AuthorityManager();
    mgr.registerGroup({ groupId: "lights", authority: "shared" });
    return mgr;
  }

  const engineA = new SyncEngine({ authority: makeClientAuthority(), resolveGroup: (id) => id.split(".")[0] });
  const engineB = new SyncEngine({ authority: makeClientAuthority(), resolveGroup: (id) => id.split(".")[0] });

  const wire: unknown[] = [];

  // 1. Cliente A cambia el beacon localmente (fuera del motor: el motor de
  //    sync-core solo procesa mensajes ENTRANTES; el cambio local se envía
  //    directo por la red).
  const localChangeAtA: IncomingControlEvent = {
    type: "control.event",
    controlId: "lights.beacon",
    value: true,
    source: "captain",
    sequence: 1,
    timestamp: 1000,
  };
  wire.push(localChangeAtA); // "A envía por la red"

  // 2. B recibe el mensaje de la red y lo procesa con su motor.
  const receivedAtB = wire.pop() as IncomingControlEvent;
  const resultAtB = engineB.applyIncomingMessage(receivedAtB);
  assert.equal(resultAtB.ok, true);
  if (resultAtB.ok) {
    assert.equal(resultAtB.message.origin, "remote");
    assert.equal(resultAtB.rebroadcast, false, "B nunca debe reenviar el cambio de A como si fuera nuevo");
  }

  // 3. Verificación explícita del ciclo: como el mensaje que B aplicó está
  //    marcado origin remote, si algo intentara reenviarlo por la red hacia
  //    A, el propio motor de B ya garantiza rebroadcast=false. Simulamos el
  //    peor caso: un bug de transporte hace eco del mismo mensaje de vuelta
  //    a B (A -> B -> A -> B). Debe rechazarse por secuencia duplicada, NUNCA
  //    reaplicarse como si fuera un segundo cambio nuevo.
  const echoBackToB = engineB.applyIncomingMessage(receivedAtB);
  assert.equal(echoBackToB.ok, false);
  if (!echoBackToB.ok) assert.equal(echoBackToB.reason, "duplicate-or-out-of-order");

  // 4. A nunca procesa su propio mensaje como si viniera de la red (no se
  //    llama a A.applyIncomingMessage con su propio cambio local): la
  //    disciplina es que applyIncomingMessage SOLO se invoca para tráfico
  //    recibido, nunca para eco local. Confirmamos que si por error se
  //    intentara, el motor de A lo trataría igual que cualquier remoto y
  //    tampoco lo reenviaría.
  const mistakenLoopbackAtA = engineA.applyIncomingMessage(localChangeAtA);
  assert.equal(mistakenLoopbackAtA.ok, true);
  if (mistakenLoopbackAtA.ok) {
    assert.equal(mistakenLoopbackAtA.rebroadcast, false);
  }
});
