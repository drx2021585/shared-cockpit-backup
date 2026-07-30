/**
 * Buffer en memoria de los `bridge.error` recibidos del bridge local, para el
 * reporte descargable de la vista Cockpit.
 *
 * POR QUÉ NO ES ESTADO DE REACT (regresión real, 0.1.14)
 * -----------------------------------------------------
 * En la 0.1.14 estos errores se guardaron en el estado de `useSimulatorBridge`, y
 * eso metió una regresión de rendimiento clara: cada mensaje del bridge pasa por
 * un `setState`, así que cada error creaba un objeto de estado nuevo con una copia
 * del array y forzaba un re-render de TODO lo que consume el bridge. Antes de ese
 * cambio los `bridge.error` no coincidían con ninguna rama del reductor, se
 * devolvía el estado idéntico y React se ahorraba el render -- eran gratis.
 *
 * El detonante es que los avisos de "esta L-Var no existe en la aeronave cargada"
 * también salen por este canal: con un perfil de 982 L-Vars llegan CIENTOS en
 * ráfaga al arrancar, cada uno con su copia de array y su re-render. El síntoma
 * era la app entera atascada durante los primeros segundos (botones que tardaban
 * en responder).
 *
 * Escribir acá es O(1) y no despierta a React. El contador que se muestra en vivo
 * sale de `bridge.diagnostics.errorsReported`, que llega cada 5 s -- un render cada
 * cinco segundos en vez de uno por error.
 *
 * Es el mismo patrón que lib/sessionJournal.ts, y por la misma razón.
 */

export interface BridgeErrorEntry {
  controlId: string;
  operation: string;
  message: string;
  timestamp: number;
}

/**
 * Cuántos errores se conservan. Acotado a propósito: una sesión con un perfil roto
 * puede generar miles y el reporte tiene que seguir siendo manejable. Se guardan
 * los MÁS RECIENTES, que son los que ocurrieron mientras se volaba; los primeros
 * suelen ser el estado inicial, todos iguales. El total sin recortar viaja en
 * `bridge.diagnostics.errorsReported`, así que se puede saber si esto truncó.
 */
const MAX_BRIDGE_ERRORS = 500;

let entries: BridgeErrorEntry[] = [];
let total = 0;

export function recordBridgeError(entry: BridgeErrorEntry): void {
  total += 1;
  entries.push(entry);
  if (entries.length > MAX_BRIDGE_ERRORS) {
    entries.shift();
  }
}

/** Copia inmutable para el reporte. */
export function readBridgeErrors(): { entries: BridgeErrorEntry[]; total: number } {
  return { entries: [...entries], total };
}

export function resetBridgeErrors(): void {
  entries = [];
  total = 0;
}
