export interface DirectInviteTarget {
  host: string;
  port: number;
  joinCode: string;
}

const DIRECT_INVITE_PREFIX = "LAN1-";

function encodeHex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function decodeHex(hex: string): string | null {
  if (!/^[0-9A-F]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function buildDirectInviteCode(target: DirectInviteTarget): string {
  const payload = `${target.host}|${target.port}|${target.joinCode.toUpperCase()}`;
  return `${DIRECT_INVITE_PREFIX}${encodeHex(payload)}`;
}

export function parseDirectInviteCode(raw: string): DirectInviteTarget | null {
  const trimmed = raw.trim();
  if (!trimmed.toUpperCase().startsWith(DIRECT_INVITE_PREFIX)) return null;
  const decoded = decodeHex(trimmed.slice(DIRECT_INVITE_PREFIX.length));
  if (!decoded) return null;
  const [host, portRaw, joinCode] = decoded.split("|");
  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}$/i.test(joinCode ?? "")) return null;
  return { host, port, joinCode: joinCode.toUpperCase() };
}
