/**
 * Cliente real hacia server/api. Nada de datos generados en el cliente:
 * perfiles de aeronave, código de sesión y estado de participantes vienen
 * todos del backend real (SQLite + escaneo de aircraft-profiles/).
 */

// Backend compartido real (Render + Postgres/Supabase) — necesario para que
// dos pilotos en computadoras distintas puedan verse: un server/api local por
// máquina no alcanza, porque el relay de WebSocket solo conecta sockets del
// mismo proceso. Para desarrollo/pruebas solo-local, sobreescribir con
// VITE_API_BASE=http://localhost:8787 en un .env.local (gitignored).
//
// Migrado de Railway a Render: el GitHub App de la integración con Railway
// quedó desconectado y "Redeploy" seguía sirviendo un build viejo (nunca
// recogía commits nuevos) — ver render.yaml en la raíz del repo. La base de
// datos (Supabase) no cambió, solo dónde corre este proceso.
const API_BASE = import.meta.env.VITE_API_BASE ?? "https://shared-cockpit-api.onrender.com";

export interface AircraftProfile {
  id: string;
  name: string;
  developer: string;
  version: string;
  coverage: number;
  capabilities: Record<string, string>;
  compatibility: { msfs2020: boolean; msfs2024: boolean };
}

export interface SessionParticipant {
  pilot_name: string;
  seat: "captain" | "first_officer" | "observer";
  joined_at: string;
}

export interface Session {
  id: string;
  joinCode: string;
  sessionName: string;
  aircraftProfileId: string;
  status: "waiting" | "active";
  sim: "msfs2020" | "msfs2024";
  hasPassword: boolean;
  creatorPilotName: string;
  /** `seat` ("captain" | "first_officer"), NO pilotName — server/api resuelve
   *  autoridad por seat, no por nombre. Resolver a nombre de piloto en la UI
   *  buscando en `participants` el que tenga ese `seat`. */
  controlOwner: string | null;
  /** Igual que `controlOwner`: `seat`, no pilotName. */
  controlRequestedBy: string | null;
  participants: SessionParticipant[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(body?.error ?? "request-failed", res.status);
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number
  ) {
    super(code);
  }
}

export function fetchAircraftProfiles() {
  return request<AircraftProfile[]>("/api/aircraft-profiles");
}

export function createSession(input: {
  sessionName: string;
  aircraftProfileId: string;
  password?: string;
  hostPilotName: string;
  hostSeat: "captain" | "first_officer";
  sim: "msfs2020" | "msfs2024";
}) {
  return request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(input) });
}

export function joinSession(
  joinCode: string,
  input: { pilotName: string; seat: "captain" | "first_officer" | "observer"; password?: string }
) {
  return request<Session>(`/api/sessions/${joinCode}/join`, { method: "POST", body: JSON.stringify(input) });
}

export function fetchSession(joinCode: string) {
  return request<Session>(`/api/sessions/${joinCode}`);
}

export async function closeSession(joinCode: string, pilotName: string) {
  const res = await fetch(`${API_BASE}/api/sessions/${joinCode}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pilotName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? "request-failed", res.status);
  }
}

async function postSessionAction(joinCode: string, action: string, pilotName: string) {
  const res = await fetch(`${API_BASE}/api/sessions/${joinCode}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pilotName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? "request-failed", res.status);
  }
}

export function leaveSession(joinCode: string, pilotName: string) {
  return postSessionAction(joinCode, "leave", pilotName);
}

export function requestControls(joinCode: string, pilotName: string) {
  return postSessionAction(joinCode, "request-controls", pilotName);
}

export function giveControls(joinCode: string, pilotName: string) {
  return postSessionAction(joinCode, "give-controls", pilotName);
}

export function apiBaseUrl() {
  return API_BASE;
}
