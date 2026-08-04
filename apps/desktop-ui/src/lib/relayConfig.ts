const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE ?? "https://shared-cockpit-api.onrender.com";
const STORAGE_KEY = "weconnect.relayConfig";

export type RelayMode = "hosted" | "custom";
export const DEFAULT_DIRECT_PORT = 25071;

export interface RelayConfig {
  mode: RelayMode;
  customHost: string | null;
  customUrl: string | null;
  directPort: number;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    return parsed.hostname || null;
  } catch {
    return trimmed
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .trim() || null;
  }
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_DIRECT_PORT;
}

export function buildCustomRelayApiBaseUrl(config: Pick<RelayConfig, "customHost" | "customUrl" | "directPort">) {
  const host = normalizeHost(config.customHost ?? "");
  if (host) {
    return `http://${host}:${normalizePort(config.directPort)}`;
  }
  return config.customUrl ? normalizeUrl(config.customUrl) : null;
}

function readStoredConfig(): RelayConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const directPort = normalizePort(parsed?.directPort);
    const customUrl = typeof parsed?.customUrl === "string" && parsed.customUrl.trim()
      ? normalizeUrl(parsed.customUrl)
      : null;
    const customHost =
      typeof parsed?.customHost === "string" && parsed.customHost.trim()
        ? normalizeHost(parsed.customHost)
        : normalizeHost(customUrl ?? "");
    return {
      mode: parsed?.mode === "custom" ? "custom" : "hosted",
      customHost,
      customUrl,
      directPort,
    };
  } catch {
    return null;
  }
}

export function getRelayConfig(): RelayConfig {
  return readStoredConfig() ?? {
    mode: "hosted",
    customHost: null,
    customUrl: null,
    directPort: DEFAULT_DIRECT_PORT,
  };
}

export function setRelayConfig(config: RelayConfig) {
  if (typeof window === "undefined") return;
  const directPort = normalizePort(config.directPort);
  const customHost = normalizeHost(config.customHost ?? "");
  const customUrl = buildCustomRelayApiBaseUrl({
    customHost,
    customUrl: config.customUrl,
    directPort,
  });
  const next: RelayConfig = {
    mode: config.mode === "custom" ? "custom" : "hosted",
    customHost,
    customUrl,
    directPort,
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("weconnect-relay-changed"));
}

export function getRelayApiBaseUrl() {
  const config = getRelayConfig();
  if (config.mode === "custom") {
    const customBase = buildCustomRelayApiBaseUrl(config);
    if (customBase) return customBase;
  }
  return DEFAULT_API_BASE;
}

export function getDefaultRelayApiBaseUrl() {
  return DEFAULT_API_BASE;
}
