/**
 * Bitácora en memoria de lo que pasó en la sesión, para el reporte descargable
 * ("Download report" en la vista Cockpit).
 *
 * POR QUÉ NO ES ESTADO DE REACT
 * -----------------------------
 * Los control.axis del otro piloto llegan a 20-60 Hz (yugo, alerones, timón).
 * Guardarlos en useState provocaría un re-render por cada muestra y tiraría el
 * rendimiento de la cabina justo cuando más importa. Esto es un módulo con estado
 * mutable a propósito: escribir es O(1) y no despierta a React. El reporte lo lee
 * una sola vez, cuando el usuario pulsa el botón.
 *
 * QUÉ APORTA AL DIAGNÓSTICO
 * -------------------------
 * Los fallos de cabina compartida son de dos lados por naturaleza: para
 * entenderlos hace falta saber "el otro piloto mandó X en el instante t, y mi
 * bridge falló al aplicarlo en t+dt". El reporte de un solo jugador con solo sus
 * errores no permite distinguir "no me llegó" de "me llegó y no lo pude aplicar",
 * que son dos bugs completamente distintos.
 */

/** Cuántos eventos de control del peer se conservan (los más recientes). */
const MAX_PEER_CONTROL_ENTRIES = 300;

/** Cuántos eventos de sesión se conservan. Son escasos, no hace falta más. */
const MAX_SESSION_EVENTS = 200;

export interface PeerControlEntry {
  controlId: string;
  channel: "event" | "axis";
  value: boolean | number | string;
  at: number;
}

export interface SessionEventEntry {
  kind: "connected" | "disconnected" | "reconnecting" | "closed" | "authority" | "note";
  detail: string;
  at: number;
}

interface Journal {
  startedAt: number;
  peerControls: PeerControlEntry[];
  /** Cuántas veces mandó cada control el otro piloto, sin recorte. */
  peerControlCounts: Record<string, number>;
  peerControlsTotal: number;
  sessionEvents: SessionEventEntry[];
}

function empty(): Journal {
  return {
    startedAt: Date.now(),
    peerControls: [],
    peerControlCounts: {},
    peerControlsTotal: 0,
    sessionEvents: [],
  };
}

let journal: Journal = empty();

export function recordPeerControl(
  controlId: string,
  channel: "event" | "axis",
  value: boolean | number | string,
): void {
  journal.peerControlsTotal += 1;
  journal.peerControlCounts[controlId] = (journal.peerControlCounts[controlId] ?? 0) + 1;

  journal.peerControls.push({ controlId, channel, value, at: Date.now() });
  if (journal.peerControls.length > MAX_PEER_CONTROL_ENTRIES) {
    journal.peerControls.shift();
  }
}

export function recordSessionEvent(kind: SessionEventEntry["kind"], detail: string): void {
  journal.sessionEvents.push({ kind, detail, at: Date.now() });
  if (journal.sessionEvents.length > MAX_SESSION_EVENTS) {
    journal.sessionEvents.shift();
  }
}

/** Copia inmutable para el reporte. */
export function readSessionJournal(): Journal {
  return {
    startedAt: journal.startedAt,
    peerControls: [...journal.peerControls],
    peerControlCounts: { ...journal.peerControlCounts },
    peerControlsTotal: journal.peerControlsTotal,
    sessionEvents: [...journal.sessionEvents],
  };
}

/** Se llama al entrar a una sesión nueva: lo anterior ya no describe nada. */
export function resetSessionJournal(): void {
  journal = empty();
}
