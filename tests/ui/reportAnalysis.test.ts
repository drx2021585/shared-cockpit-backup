import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupErrors,
  peakErrorsPerSecond,
  type AnalyzableError,
} from "../../apps/desktop-ui/src/lib/reportAnalysis.ts";

/**
 * Análisis del reporte de diagnóstico descargable (vista Cockpit, "Download
 * report"). Lo que se prueba acá es la lógica que puede estar mal EN SILENCIO: si
 * la agrupación cuenta de más, o si la detección de ráfagas no dispara, el reporte
 * sale igual de bonito y me lleva a la conclusión equivocada.
 */

const err = (
  controlId: string,
  message: string,
  timestamp: number,
  operation = "confirmAfterWrite",
): AnalyzableError => ({ controlId, operation, message, timestamp });

test("groupErrors colapsa el mismo mensaje y cuenta controles distintos", () => {
  const groups = groupErrors([
    err("engine.apu_sw", "no convergió", 1),
    err("gear.autobrake_sw", "no convergió", 2),
    err("engine.apu_sw", "no convergió", 3), // control repetido: NO cuenta doble
    err("fuel.crossfeed_sw", "NO SE MOVIÓ", 4),
  ]);

  assert.equal(groups.length, 2);

  // Ordenado por número de ocurrencias, descendente.
  assert.equal(groups[0].message, "no convergió");
  assert.equal(groups[0].occurrences, 3);
  assert.equal(groups[0].distinctControls, 2);
  assert.deepEqual(groups[0].controls, ["engine.apu_sw", "gear.autobrake_sw"]);

  assert.equal(groups[1].occurrences, 1);
});

test("groupErrors separa por operación aunque el mensaje coincida", () => {
  const groups = groupErrors([
    err("a", "falló", 1, "read"),
    err("a", "falló", 2, "write"),
  ]);
  assert.equal(groups.length, 2);
});

test("groupErrors no inventa un control cuando el id viene vacío", () => {
  // Los avisos del cliente de L-Vars llegan sin controlId (el texto ya lo nombra).
  const groups = groupErrors([err("", "L-Var inexistente", 1, "read")]);
  assert.equal(groups[0].occurrences, 1);
  assert.equal(groups[0].distinctControls, 0);
  assert.deepEqual(groups[0].controls, []);
});

test("peakErrorsPerSecond detecta la ráfaga que delató la avalancha", () => {
  // 111 errores en el mismo segundo fue la firma real del bug que rompió la
  // primera sesión de dos jugadores.
  const burst = Array.from({ length: 111 }, (_, i) => err(`c${i}`, "no convergió", 1_000_000 + i * 5));
  assert.equal(peakErrorsPerSecond(burst), 111);
});

test("peakErrorsPerSecond no confunde errores repartidos en el tiempo con una ráfaga", () => {
  // Uno cada 5 segundos: mismo total, diagnóstico opuesto.
  const spread = Array.from({ length: 50 }, (_, i) => err(`c${i}`, "no convergió", i * 5000));
  assert.equal(peakErrorsPerSecond(spread), 1);
});

test("peakErrorsPerSecond encuentra el pico aunque no esté al principio", () => {
  const errors = [
    err("a", "x", 0),
    err("b", "x", 10_000),
    err("c", "x", 10_100),
    err("d", "x", 10_200),
    err("e", "x", 30_000),
  ];
  assert.equal(peakErrorsPerSecond(errors), 3);
});

test("peakErrorsPerSecond tolera timestamps desordenados", () => {
  // Los errores llegan por WebSocket; no hay garantía de orden estricto.
  const errors = [err("a", "x", 500), err("b", "x", 0), err("c", "x", 250)];
  assert.equal(peakErrorsPerSecond(errors), 3);
});

test("peakErrorsPerSecond con la lista vacía es 0, no NaN", () => {
  assert.equal(peakErrorsPerSecond([]), 0);
});
