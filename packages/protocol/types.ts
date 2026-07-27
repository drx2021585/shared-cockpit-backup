/**
 * @shared-cockpit/protocol
 * Tipos derivados de messages.schema.json. Cambiar esto requiere aprobación
 * del orquestador — lo consumen sync-engine, networking, frontend, y (vía IPC
 * local serializado a JSON) simconnect-bridge y wasm-bridge.
 */

export type ControlAuthority =
  | "exclusive"
  | "shared"
  | "captain-only"
  | "first-officer-only"
  | "instructor-only"
  | "local-only";

export type ParticipantRole = "captain" | "first_officer" | "observer";

export type MessageOrigin = "local" | "remote";

/** Canal confiable, ordenado, sin pérdida. */
export interface ControlEvent {
  type: "control.event";
  sessionId: string;
  controlId: string;
  value: boolean | number | string;
  source: string;
  /** Asignado por el receptor al recibir; NUNCA se serializa hacia la red. */
  origin?: MessageOrigin;
  sequence: number;
  timestamp: number;
}

/** Canal rápido, best-effort. Último valor gana, no se retransmiten paquetes viejos. */
export interface ControlAxis {
  type: "control.axis";
  sessionId: string;
  controlId: string;
  value: number;
  sequence: number;
  timestamp: number;
}

export interface AircraftSnapshotSystems {
  electrical?: Record<string, unknown>;
  hydraulic?: Record<string, unknown>;
  fuel?: Record<string, unknown>;
  lights?: Record<string, unknown>;
  autopilot?: Record<string, unknown>;
  radios?: Record<string, unknown>;
}

export interface AircraftSnapshot {
  type: "aircraft.snapshot";
  sessionId: string;
  revision: number;
  profile: string;
  systems: AircraftSnapshotSystems;
}

export interface AuthorityTransfer {
  type: "authority.transfer";
  sessionId: string;
  group: string;
  previousOwner: string;
  newOwner: string;
  revision: number;
}

export interface SessionMessage {
  type: "session.join" | "session.leave" | "session.role_change" | "session.ping";
  sessionId: string;
  userId?: string;
  role?: ParticipantRole;
  timestamp?: number;
}

/**
 * Colores de celda del CDU/MCDU del PMDG NG3 SDK
 * (PMDG_NG3_CDU_COLOR_* en PMDG_NG3_SDK.h). 0..5, sin más valores posibles.
 */
export type ScreenCellColorId = 0 | 1 | 2 | 3 | 4 | 5;

/** Una celda de una pantalla de solo lectura (ej. CDU). */
export interface ScreenCell {
  /** Carácter de la celda; cadena vacía o espacio para celda en blanco. */
  char: string;
  /** Uno de los 6 colores definidos por el SDK (ver ScreenCellColorId). */
  colorId: ScreenCellColorId;
  /** Bitmask de flags del SDK (ej. PMDG_NG3_CDU_FLAG_SMALL_FONT=0x01, _REVERSE=0x02, _UNUSED=0x04). */
  flags: number;
}

/**
 * Contenido completo de una pantalla de solo lectura de un addon de terceros
 * (ej. CDU/MCDU del PMDG NG3 SDK vía Client Data Area PMDG_NG3_CDU_0/1).
 * Canal confiable, baja frecuencia, on-demand/on-change — NUNCA a la
 * frecuencia de un control.axis. Estrictamente de solo lectura en esta
 * versión: no representa botones escribibles (ver
 * docs/plan-737-fullsync-2026-07-25.md, sección "Diseño propuesto: pantalla
 * del CDU/MCDU").
 */
export interface ScreenSnapshot {
  type: "screen.snapshot";
  sessionId: string;
  /** Identificador normalizado de la pantalla, ej. "cdu_captain" / "cdu_fo". */
  screenId: string;
  /** Número de filas de la grilla (ej. 14 para el CDU del PMDG NG3). */
  rows: number;
  /** Número de columnas de la grilla (ej. 24 para el CDU del PMDG NG3). */
  cols: number;
  /** Celdas en orden row-major, longitud esperada rows*cols. */
  cells: ScreenCell[];
  /** Espeja PMDG_NG3_CDU_Screen.Powered; si es false, la UI puede ignorar 'cells'. */
  powered?: boolean;
  /** Se incrementa en cada snapshot enviado; descarta snapshots viejos/fuera de orden. */
  revision: number;
  /** Asignado por el receptor al recibir; NUNCA se serializa hacia la red. */
  origin?: MessageOrigin;
  timestamp?: number;
}

export type SharedCockpitMessage =
  | ControlEvent
  | ControlAxis
  | AircraftSnapshot
  | AuthorityTransfer
  | SessionMessage
  | ScreenSnapshot;

/** Helper de guardas de tipo, uso libre por cualquier agente. */
export function isControlEvent(m: SharedCockpitMessage): m is ControlEvent {
  return m.type === "control.event";
}
export function isControlAxis(m: SharedCockpitMessage): m is ControlAxis {
  return m.type === "control.axis";
}
export function isAircraftSnapshot(m: SharedCockpitMessage): m is AircraftSnapshot {
  return m.type === "aircraft.snapshot";
}
export function isAuthorityTransfer(m: SharedCockpitMessage): m is AuthorityTransfer {
  return m.type === "authority.transfer";
}
export function isScreenSnapshot(m: SharedCockpitMessage): m is ScreenSnapshot {
  return m.type === "screen.snapshot";
}
