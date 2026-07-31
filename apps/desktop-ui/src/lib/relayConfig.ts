const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE ?? "https://shared-cockpit-api.onrender.com";
const RELAY_MODE_STORAGE_KEY = "weconnect.relayMode";
const RELAY_BASE_STORAGE_KEY = "weconnect.relayBaseUrl";

export type RelayMode = "managed" | "self-hosted";

export interface RelayConfig {
  mode: RelayMode;
  customBaseUrl: string;
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
