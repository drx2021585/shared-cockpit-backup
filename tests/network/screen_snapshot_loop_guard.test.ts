/**
 * Integración (tests-agent): confirma que el mensaje NUEVO `screen.snapshot`
 * (packages/protocol/types.ts) respeta la regla no negociable #2 —
 * "todo mensaje recibido de red se marca origin: remote y nunca se reenvía
 * como si fuera un cambio local" — igual que control.event/control.axis/
 * authority.transfer, a pesar de ser un tipo de mensaje NUEVO que
 * packages/synchronization-core no conocía cuando se escribió.
 *
 * IMPORTANTE (límite de responsabilidad de este agente): packages/synchronization-core
 * es propiedad de sync-engine-agent. Este archivo vive en tests/ y solo IMPORTA
 * (lectura) `LoopGuard` desde ese paquete — no lo modifica.
 *
 * Hallazgo real que documenta este test (reportado, no corregido aquí):
 * `SyncEngine.applyIncomingMessage` (packages/synchronization-core/src/engine.ts)
 * tiene un `switch (raw.type)` que solo cubre "control.event" | "control.axis" |
 * "authority.transfer" — el tipo `IncomingSyncMessage` de ese archivo NO incluye
 * "screen.snapshot" todavía, a diferencia de `SharedCockpitMessage` en
 * packages/protocol/types.ts, que sí lo incluye (junto con `isScreenSnapshot`).
 * Es decir: hoy NO existe una ruta de integración única para screen.snapshot a
 * través de SyncEngine — quien la conecte tendrá que, o bien extender esa unión
 * en synchronization-core, o usar `LoopGuard` directamente como se hace aquí.
 * No se sabe si esto es intencional (screen.snapshot es de solo lectura, sin
 * control de autoridad de escritura, así que quizás no necesite pasar por
 * SyncEngine.applyIncomingMessage en absoluto) — se deja como confirmación para
 * sync-engine-agent, no se asume ninguna de las dos.
 *
 * Lo que SÍ se confirma aquí con un test real: el building block genérico
 * (`LoopGuard`) que implementa la regla anti-eco NO está atado al tipo de
 * mensaje — funciona igual para una clave sintética "screen:<screenId>" con
 * `revision` como número de secuencia (mismo patrón que ya usa
 * `authority.transfer` con "authority.transfer:<group>" + `revision`, ver
 * engine.ts línea ~171). Por lo tanto, si sync-engine-agent decide enrutar
 * screen.snapshot por LoopGuard (directamente o vía SyncEngine extendido), la
 * garantía anti-ciclo ya es genérica y no necesitaría cambios en LoopGuard.
 *
 * Ejecutar: node --experimental-strip-types --test tests/network/screen_snapshot_loop_guard.test.ts
 * (mismo runner/flag que usa packages/synchronization-core/package.json → npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard } from "../../packages/synchronization-core/src/loop-guard.ts";

/** Forma reducida de packages/protocol/types.ts ScreenSnapshot, solo los
 *  campos que le importan a LoopGuard para esta prueba. */
interface FakeScreenSnapshot {
  type: "screen.snapshot";
  screenId: string;
  revision: number;
  origin: "local" | "remote";
}

function toLoopGuardKey(msg: FakeScreenSnapshot) {
  // Convención propuesta (análoga a authority.transfer): namespacing por tipo
  // de mensaje + screenId, revision como "sequence".
  return { controlId: `screen.snapshot:${msg.screenId}`, sequence: msg.revision, origin: msg.origin };
}

test("screen.snapshot: LoopGuard NUNCA reenvía un snapshot marcado origin remote (misma regla que control.event)", () => {
  const guard = new LoopGuard();
  const remoteSnapshot: FakeScreenSnapshot = {
    type: "screen.snapshot",
    screenId: "cdu_captain",
    revision: 7,
    origin: "remote",
  };

  assert.equal(guard.shouldApply(toLoopGuardKey(remoteSnapshot)), true, "el primer snapshot remoto debe aplicarse");
  assert.equal(
    guard.shouldRebroadcast(toLoopGuardKey(remoteSnapshot)),
    false,
    "un screen.snapshot de origen remoto jamás debe reenviarse como cambio local",
  );
});

test("screen.snapshot: revisiones duplicadas o fuera de orden se descartan igual que control.axis", () => {
  const guard = new LoopGuard();
  const first: FakeScreenSnapshot = { type: "screen.snapshot", screenId: "cdu_fo", revision: 10, origin: "remote" };
  assert.equal(guard.shouldApply(toLoopGuardKey(first)), true);

  const duplicate = { ...first, revision: 10 };
  assert.equal(guard.shouldApply(toLoopGuardKey(duplicate)), false, "revision duplicada debe descartarse");

  const stale = { ...first, revision: 4 };
  assert.equal(guard.shouldApply(toLoopGuardKey(stale)), false, "revision vieja/fuera de orden debe descartarse");

  const newer = { ...first, revision: 11 };
  assert.equal(guard.shouldApply(toLoopGuardKey(newer)), true, "revision más nueva sí debe aplicarse");
});

test("screen.snapshot: A->B->A nunca revive un ciclo de retroalimentación (misma garantía que lights.beacon)", () => {
  // Reproduce el mismo escenario del plan maestro sección 19, pero para el
  // canal confiable de pantallas en vez de un interruptor: A (bridge del
  // capitán) envía un snapshot -> B lo recibe y aplica -> B nunca lo
  // reenvía -> si por un bug de transporte el mismo mensaje "rebota" de
  // vuelta a B, se descarta por revision duplicada, nunca se reaplica.
  const clientBGuard = new LoopGuard();
  const messageFromA: FakeScreenSnapshot = {
    type: "screen.snapshot",
    screenId: "cdu_captain",
    revision: 42,
    origin: "remote",
  };

  const applied = clientBGuard.shouldApply(toLoopGuardKey(messageFromA));
  const rebroadcast = clientBGuard.shouldRebroadcast(toLoopGuardKey(messageFromA));
  assert.equal(applied, true);
  assert.equal(rebroadcast, false, "B nunca debe reenviar el snapshot de A");

  const echoBackToB = clientBGuard.shouldApply(toLoopGuardKey(messageFromA));
  assert.equal(echoBackToB, false, "un eco de transporte del mismo snapshot debe rechazarse, no reaplicarse");
});

test("screen.snapshot: dos pantallas distintas (cdu_captain vs cdu_fo) tienen contadores de revision independientes", () => {
  const guard = new LoopGuard();
  const captain: FakeScreenSnapshot = { type: "screen.snapshot", screenId: "cdu_captain", revision: 100, origin: "remote" };
  const fo: FakeScreenSnapshot = { type: "screen.snapshot", screenId: "cdu_fo", revision: 1, origin: "remote" };

  assert.equal(guard.shouldApply(toLoopGuardKey(captain)), true);
  // una revision baja para OTRA pantalla no debe verse afectada por el
  // contador alto de cdu_captain — son claves distintas.
  assert.equal(guard.shouldApply(toLoopGuardKey(fo)), true);
});
