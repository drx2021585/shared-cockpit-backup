const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE ?? "https://shared-cockpit-api.onrender.com";
const RELAY_MODE_STORAGE_KEY = "weconnect.relayMode";
const RELAY_BASE_STORAGE_KEY = "weconnect.relayBaseUrl";

export type RelayMode = "managed" | "self-hosted";

export interface RelayConfig {
  mode: RelayMode;
  customBaseUrl: string;
}

// Puerto del direct host. Por defecto el mismo que YourControls (25071); los
// dos jugadores tienen que usar el mismo numero, y viaja dentro del codigo de
// invitacion directo para que el invitado no tenga que escribirlo.
const DIRECT_PORT_STORAGE_KEY = "weconnect.directHostPort";
export const DEFAULT_DIRECT_HOST_PORT = 25071;

export function readDirectHostPort(): number {
  if (typeof window === "undefined") return DEFAULT_DIRECT_HOST_PORT;
  const stored = Number(window.localStorage.getItem(DIRECT_PORT_STORAGE_KEY));
  return Number.isInteger(stored) && stored >= 1024 && stored <= 65535 ? stored : DEFAULT_DIRECT_HOST_PORT;
}

export function writeDirectHostPort(port: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DIRECT_PORT_STORAGE_KEY, String(port));
}

export function normalizeRelayBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export function readRelayConfig(): RelayConfig {
  if (typeof window === "undefined") {
    return { mode: "managed", customBaseUrl: "" };
  }
  const storedMode = window.localStorage.getItem(RELAY_MODE_STORAGE_KEY);
  const storedBaseUrl = window.localStorage.getItem(RELAY_BASE_STORAGE_KEY) ?? "";
  return {
    mode: storedMode === "self-hosted" ? "self-hosted" : "managed",
    customBaseUrl: storedBaseUrl,
  };
}

export function writeRelayConfig(config: RelayConfig) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(RELAY_MODE_STORAGE_KEY, config.mode);
  window.localStorage.setItem(RELAY_BASE_STORAGE_KEY, normalizeRelayBaseUrl(config.customBaseUrl));
}

export function getRelayApiBaseUrl() {
  const config = readRelayConfig();
  if (config.mode !== "self-hosted") return DEFAULT_API_BASE;
  const normalized = normalizeRelayBaseUrl(config.customBaseUrl);
  return normalized || DEFAULT_API_BASE;
}

export function getDefaultRelayApiBaseUrl() {
  return DEFAULT_API_BASE;
}
