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
import { currentVersion } from "../data";
import { getRelayApiBaseUrl } from "./relayConfig";

const PARTICIPANT_TOKEN_STORAGE_KEY = "weconnect.participantToken";

export interface ServerHealth {
  status: "ok";
  uptimeSeconds: number;
  apiVersion: number;
  minClientVersion: string;
  latestClientVersion: string;
}

export interface AircraftProfile {
  id: string;
  name: string;
  developer: string;
  version: string;
  availability?: "released" | "soon";
  coverage: number;
  capabilities: Record<string, string>;
  compatibility: { msfs2020: boolean; msfs2024: boolean };
  /**
   * ¿El perfil se probó contra MSFS de verdad? Es un eje aparte de `coverage`:
   * un perfil generado automáticamente puede ser mecánicamente muy completo
   * (coverage alto) y no haberse volado nunca. Perfiles viejos servidos por un
   * backend anterior a este campo llegan sin él — se trata como no verificado.
   */
  verified?: boolean;
  /**
   * Modelos concretos que cubre este perfil, como se llaman en el paquete
   * instalado (ej. "iFly 737-MAX8200"). Un solo perfil puede cubrir varias
   * variantes cuando comparten cabina. Opcional: un backend anterior a este
   * campo responde sin él.
   */
  variants?: string[];
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
  /**
   * Token de participante: solo viene en la respuesta de create/join (nunca
   * en session.state ni en GET). Es la credencial con la que este cliente
   * autentica todas las acciones de sesión y el WebSocket — ver
   * getParticipantToken() abajo.
   */
  participantToken?: string;
}

function readStoredParticipantToken(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(PARTICIPANT_TOKEN_STORAGE_KEY);
  return typeof raw === "string" && /^[a-f0-9]{64}$/i.test(raw) ? raw : null;
}

function setParticipantToken(next: string | null) {
  participantToken = next;
  if (typeof window === "undefined") return;
  if (next) {
    window.sessionStorage.setItem(PARTICIPANT_TOKEN_STORAGE_KEY, next);
  } else {
    window.sessionStorage.removeItem(PARTICIPANT_TOKEN_STORAGE_KEY);
  }
}

// Credencial efímera de la sesión activa. Para que cerrar/abandonar la sesión
// siga funcionando tras un reload del renderer o un reinicio de módulos en
// desarrollo, se respalda en sessionStorage del navegador y se limpia al
// salir/cerrar. Nunca se loguea.
let participantToken: string | null = readStoredParticipantToken();

export function getParticipantToken(): string | null {
  return participantToken;
}

function authHeaders(): Record<string, string> {
  return {
    ...(participantToken ? { Authorization: `Bearer ${participantToken}` } : {}),
    "X-WeConnect-Client-Version": currentVersion,
  };
}

async function requestFromBaseUrl<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-WeConnect-Client-Version": currentVersion,
      ...init?.headers,
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(body?.error ?? "request-failed", res.status);
  }
  return body as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestFromBaseUrl<T>(getRelayApiBaseUrl(), path, init);
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

export function fetchServerHealth() {
  return request<ServerHealth>("/api/health");
}

export async function createSession(input: {
  sessionName: string;
  aircraftProfileId: string;
  password?: string;
  hostPilotName: string;
  // El anfitrión también puede quedarse como observador (instructor/streamer
  // que arma la sala sin volar). En ese caso el servidor siembra el dueño de
  // los controles en el asiento del capitán, que queda libre hasta que alguien
  // lo tome.
  hostSeat: "captain" | "first_officer" | "observer";
  sim: "msfs2020" | "msfs2024";
}) {
  const session = await request<Session>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
  setParticipantToken(session.participantToken ?? null);
  return session;
}

export async function createSessionAtBaseUrl(
  baseUrl: string,
  input: {
    sessionName: string;
    aircraftProfileId: string;
    password?: string;
    hostPilotName: string;
    hostSeat: "captain" | "first_officer" | "observer";
    sim: "msfs2020" | "msfs2024";
  }
) {
  const session = await requestFromBaseUrl<Session>(baseUrl, "/api/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
  setParticipantToken(session.participantToken ?? null);
  return session;
}

export async function joinSession(
  joinCode: string,
  input: { pilotName: string; seat: "captain" | "first_officer" | "observer"; password?: string }
) {
  const session = await request<Session>(`/api/sessions/${joinCode}/join`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  setParticipantToken(session.participantToken ?? null);
  return session;
}

export function fetchSession(joinCode: string) {
  return request<Session>(`/api/sessions/${joinCode}`);
}

// La identidad de todas las acciones de sesión sale del token (header
// Authorization) — el backend ya no confía en un pilotName del body. El
// parámetro pilotName se mantiene en las firmas para no romper a los
// llamadores, pero no viaja.
export async function closeSession(joinCode: string, _pilotName?: string) {
  const res = await fetch(`${getRelayApiBaseUrl()}/api/sessions/${joinCode}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? "request-failed", res.status);
  }
  setParticipantToken(null);
}

async function postSessionAction(joinCode: string, action: string) {
  const res = await fetch(`${getRelayApiBaseUrl()}/api/sessions/${joinCode}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? "request-failed", res.status);
  }
}

export async function leaveSession(joinCode: string, _pilotName?: string) {
  await postSessionAction(joinCode, "leave");
  setParticipantToken(null);
}

export function requestControls(joinCode: string, _pilotName?: string) {
  return postSessionAction(joinCode, "request-controls");
}

export function giveControls(joinCode: string, _pilotName?: string) {
  return postSessionAction(joinCode, "give-controls");
}

export function apiBaseUrl() {
  return getRelayApiBaseUrl();
}
