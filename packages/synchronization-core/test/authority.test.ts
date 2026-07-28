import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthorityManager } from "../src/authority.ts";

test("shared authority: both seats can write", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "lights", authority: "shared" });
  assert.equal(mgr.canWrite("lights", "captain"), true);
  assert.equal(mgr.canWrite("lights", "first_officer"), true);
});

test("exclusive authority: only current owner can write", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "flight_controls", authority: "exclusive" }, "captain");
  assert.equal(mgr.canWrite("flight_controls", "captain"), true);
  assert.equal(mgr.canWrite("flight_controls", "first_officer"), false);
});

test("transfer moves ownership and bumps revision", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "flight_controls", authority: "exclusive" }, "captain");

  const result = mgr.transfer("flight_controls", "captain", "first_officer");
  assert.equal(result.ok, true);
  assert.equal(result.revision, 1);
  assert.equal(mgr.canWrite("flight_controls", "first_officer"), true);
  assert.equal(mgr.canWrite("flight_controls", "captain"), false);
});

test("transfer fails if requester is not the current owner", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "flight_controls", authority: "exclusive" }, "captain");

  const result = mgr.transfer("flight_controls", "first_officer", "captain");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-current-owner");
  // el dueño no debe haber cambiado
  assert.equal(mgr.getOwner("flight_controls"), "captain");
});

test("shared group cannot be transferred (not exclusive)", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "radios", authority: "shared" });
  const result = mgr.transfer("radios", "captain", "first_officer");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "group-not-transferable");
});

test("captain-only authority blocks first officer writes", () => {
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "autopilot", authority: "captain-only" });
  assert.equal(mgr.canWrite("autopilot", "captain"), true);
  assert.equal(mgr.canWrite("autopilot", "first_officer"), false);
});

test("exclusive authority registered WITHOUT an initial owner blocks every seat until a transfer assigns one", () => {
  // Trampa real detectada al revisar aircraft-profiles/pmdg-737-900/controls/
  // flight-controls.yaml: flight.yoke.pitch, flight.yoke.roll y flight.rudder
  // (ejes continuos control.axis del PMDG 737) están declarados
  // `authority: exclusive`, pero nada en el perfil asigna un dueño inicial
  // por asiento. Si quien conecte AuthorityManager a un perfil real hace
  // `registerGroup({ groupId, authority: "exclusive" })` sin pasar
  // `initialOwner`, canWrite() da `false` para AMBOS asientos
  // indefinidamente (owner queda `null`, y `g.owner === seat` nunca es
  // cierto) -- ningún jugador puede escribir ese eje hasta que ocurra un
  // authority.transfer explícito. Este test documenta el comportamiento
  // (no es un bug de AuthorityManager: "nadie tiene autoridad todavía" es
  // una respuesta válida) para que quien integre autoridad real con ejes
  // continuos exclusive sepa que DEBE registrar un initialOwner explícito
  // (ej. "captain" por defecto) o el eje se verá como "no sincroniza" para
  // los dos jugadores por igual.
  const mgr = new AuthorityManager();
  mgr.registerGroup({ groupId: "flight", authority: "exclusive" }); // sin initialOwner
  assert.equal(mgr.getOwner("flight"), null);
  assert.equal(mgr.canWrite("flight", "captain"), false);
  assert.equal(mgr.canWrite("flight", "first_officer"), false);

  // Se recupera solo tras una transferencia explícita... pero transfer()
  // exige que `fromSeat` coincida con el owner actual (null), así que ni
  // siquiera una transferencia normal puede arrancarlo desde este estado:
  // hace falta asignar el owner inicial al registrar el grupo, no después.
  const attemptedTransfer = mgr.transfer("flight", "captain", "first_officer");
  assert.equal(attemptedTransfer.ok, false);
  assert.equal(attemptedTransfer.reason, "not-current-owner");
});
