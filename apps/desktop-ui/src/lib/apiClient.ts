/**
 * Cliente real hacia server/api. Nada de datos generados en el cliente:
 * perfiles de aeronave, código de sesión y estado de participantes vienen
 * todos del backend real (SQLite + escaneo de aircraft-profiles/).
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

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
  hasPassword: boolean;
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

export function apiBaseUrl() {
  return API_BASE;
}
