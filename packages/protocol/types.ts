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

export type SharedCockpitMessage =
  | ControlEvent
  | ControlAxis
  | AircraftSnapshot
  | AuthorityTransfer
  | SessionMessage;

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
