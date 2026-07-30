/**
 * Análisis puro del reporte de diagnóstico: sin DOM, sin globals del navegador y
 * sin estado. Está separado de diagnosticsReport.ts justamente para poder
 * probarlo -- ese módulo toca `navigator`, `Blob` y `document`, así que no se
 * puede importar desde un test de node.
 *
 * Acá vive la lógica que puede estar MAL de forma silenciosa (agrupar, detectar
 * ráfagas), a diferencia del armado del JSON, que es copiar campos.
 */

export interface AnalyzableError {
  controlId: string;
  operation: string;
  message: string;
  timestamp: number;
}

export interface ErrorGroup {
  operation: string;
  message: string;
  occurrences: number;
  distinctControls: number;
  controls: string[];
}

/** Cuántos controles distintos se listan por grupo antes de recortar. */
const MAX_CONTROLS_PER_GROUP = 40;

/**
 * Agrupa por (operación, mensaje). Un perfil roto produce cientos de líneas que
 * dicen exactamente lo mismo; lo que hace falta saber es cuántos controles
 * DISTINTOS están afectados y cuáles, no repetir el texto 300 veces.
 */
export function groupErrors(errors: readonly AnalyzableError[]): ErrorGroup[] {
  const groups = new Map<
    string,
    { operation: string; message: string; count: number; controls: Set<string> }
  >();

  for (const e of errors) {
    const key = `${e.operation}::${e.message}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (e.controlId) existing.controls.add(e.controlId);
    } else {
      groups.set(key, {
        operation: e.operation,
        message: e.message,
        count: 1,
        controls: new Set(e.controlId ? [e.controlId] : []),
      });
    }
  }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => ({
      operation: g.operation,
      message: g.message,
      occurrences: g.count,
      distinctControls: g.controls.size,
      controls: [...g.controls].sort().slice(0, MAX_CONTROLS_PER_GROUP),
    }));
}

/**
 * Mayor número de errores dentro de una misma ventana de un segundo.
 *
 * Es la métrica que delató la avalancha de escrituras que rompió la primera
 * sesión real de dos jugadores: 111 errores en un solo segundo. Un pico alto
 * significa "algo está fallando en masa" (el estado entero de la cabina
 * reaplicándose), que es un diagnóstico completamente distinto de "hay unos
 * controles mal configurados" -- y el total de errores por sí solo no los
 * distingue.
 *
 * Ventana deslizante sobre los timestamps ordenados: O(n log n) por el sort.
 */
export function peakErrorsPerSecond(errors: readonly AnalyzableError[]): number {
  if (errors.length === 0) return 0;

  const times = errors.map((e) => e.timestamp).sort((a, b) => a - b);
  let peak = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    // La ventana es inclusiva: dos errores separados exactamente 1000 ms cuentan
    // como el mismo segundo.
    while (times[end] - times[start] > 1000) start++;
    peak = Math.max(peak, end - start + 1);
  }
  return peak;
}
