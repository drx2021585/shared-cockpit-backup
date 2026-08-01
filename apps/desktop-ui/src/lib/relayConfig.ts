const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE ?? "https://shared-cockpit-api.onrender.com";
const STORAGE_KEY = "weconnect.relayConfig";

export type RelayMode = "hosted" | "custom";
export const DEFAULT_DIRECT_PORT = 25071;

export interface RelayConfig {
  mode: RelayMode;
  customUrl: string | null;
  directPort: number;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_DIRECT_PORT;
}

function readStoredConfig(): RelayConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      mode: parsed?.mode === "custom" ? "custom" : "hosted",
      customUrl: typeof parsed?.customUrl === "string" && parsed.customUrl.trim()
        ? normalizeUrl(parsed.customUrl)
        : null,
      directPort: normalizePort(parsed?.directPort),
    };
  } catch {
    return null;
  }
}

export function getRelayConfig(): RelayConfig {
  return readStoredConfig() ?? { mode: "hosted", customUrl: null, directPort: DEFAULT_DIRECT_PORT };
}

export function setRelayConfig(config: RelayConfig) {
  if (typeof window === "undefined") return;
  const next: RelayConfig = {
    mode: config.mode === "custom" ? "custom" : "hosted",
    customUrl: config.customUrl ? normalizeUrl(config.customUrl) : null,
    directPort: normalizePort(config.directPort),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("weconnect-relay-changed"));
}

export function getRelayApiBaseUrl() {
  const config = getRelayConfig();
  if (config.mode === "custom" && config.customUrl) {
    return config.customUrl;
  }
  return DEFAULT_API_BASE;
}

export function getDefaultRelayApiBaseUrl() {
  return DEFAULT_API_BASE;
}
