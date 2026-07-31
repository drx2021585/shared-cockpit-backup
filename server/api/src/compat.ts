export const SERVER_API_VERSION = 1;
export const MIN_CLIENT_VERSION = "0.1.41";
export const LATEST_CLIENT_VERSION = "0.1.41";

function parseVersion(version: string): number[] | null {
  const normalized = version.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+){0,2}$/.test(normalized)) return null;
  return normalized.split(".").map((part) => Number(part));
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isClientVersionSupported(clientVersion: string | null | undefined): boolean {
  if (!clientVersion) return false;
  return compareVersions(clientVersion, MIN_CLIENT_VERSION) >= 0;
}

export function buildHealthPayload() {
  return {
    status: "ok" as const,
    uptimeSeconds: process.uptime(),
    apiVersion: SERVER_API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    latestClientVersion: LATEST_CLIENT_VERSION,
  };
}
