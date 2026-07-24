import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LoopGuard,
  isDangerousToggleWrite,
  resolveSwitchConflict,
} from "../src/loop-guard.ts";

test("LoopGuard applies messages with increasing sequence numbers", () => {
  const guard = new LoopGuard();
  assert.equal(guard.shouldApply({ controlId: "lights.beacon", sequence: 1, origin: "remote" }), true);
  assert.equal(guard.shouldApply({ controlId: "lights.beacon", sequence: 2, origin: "remote" }), true);
});

test("LoopGuard rejects duplicate or out-of-order sequence numbers", () => {
  const guard = new LoopGuard();
  guard.shouldApply({ controlId: "lights.beacon", sequence: 5, origin: "remote" });
  // secuencia repetida o menor: debe rechazarse
  assert.equal(guard.shouldApply({ controlId: "lights.beacon", sequence: 5, origin: "remote" }), false);
  assert.equal(guard.shouldApply({ controlId: "lights.beacon", sequence: 3, origin: "remote" }), false);
});

test("LoopGuard NEVER rebroadcasts a remote-origin message (anti feedback-loop rule)", () => {
  const guard = new LoopGuard();
  const remoteMsg = { controlId: "lights.beacon", sequence: 1, origin: "remote" as const };
  assert.equal(guard.shouldRebroadcast(remoteMsg), false);
});

test("LoopGuard rebroadcasts a local-origin message", () => {
  const guard = new LoopGuard();
  const localMsg = { controlId: "lights.beacon", sequence: 1, origin: "local" as const };
  assert.equal(guard.shouldRebroadcast(localMsg), true);
});

test("full A-to-B-to-A cycle never re-triggers: B applies A's change, marks remote, never rebroadcasts", () => {
  // Simula el escenario exacto descrito en el plan maestro (sección 19):
  // Cliente A cambia Beacon a ON -> Cliente B recibe ON -> B lo aplica ->
  // B NO vuelve a enviarlo como cambio nuevo.
  const clientBGuard = new LoopGuard();
  const messageFromA = { controlId: "lights.beacon", sequence: 42, origin: "remote" as const };

  const applied = clientBGuard.shouldApply(messageFromA);
  const rebroadcast = clientBGuard.shouldRebroadcast(messageFromA);

  assert.equal(applied, true, "B debe aplicar el cambio recibido");
  assert.equal(rebroadcast, false, "B NUNCA debe reenviar un cambio de origen remoto");
});

test("anti-toggle: rejects a raw TOGGLE write event for a boolean control", () => {
  assert.equal(isDangerousToggleWrite("BEACON_LIGHTS_TOGGLE", "boolean"), true);
});

test("anti-toggle: accepts explicit SET_ON/SET_OFF-style write events", () => {
  assert.equal(isDangerousToggleWrite("BEACON_LIGHTS_SET", "boolean"), false);
});

test("anti-toggle: numeric controls are not subject to the toggle check", () => {
  assert.equal(isDangerousToggleWrite("FLAPS_TOGGLE", "number"), false);
});

test("switch conflict resolution: most recent explicit value wins, never inverts both", () => {
  // Jugador A pone la luz OFF a t=100, Jugador B la pone ON a t=105 (casi
  // simultáneo). El resultado debe ser un único estado determinista: ON.
  const a = { value: false, timestamp: 100, source: "captain" };
  const b = { value: true, timestamp: 105, source: "first_officer" };
  const resolved = resolveSwitchConflict(a, b);
  assert.equal(resolved.value, true);
  assert.equal(resolved.source, "first_officer");
});
