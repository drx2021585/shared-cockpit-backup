/**
 * Primitivas de autenticación del backend (sin dependencia de pg ni de
 * Express, para poder testearlas aisladas — ver test/security.test.ts):
 *
 * - Hash de contraseñas de sesión con scrypt (node:crypto, sin dependencias
 *   nativas externas). Formato almacenado: `scrypt:N:r:p:salt:hash` (base64).
 *   Se acepta también el formato legado en texto plano (filas creadas antes
 *   de este cambio) y joinSession lo re-hashea al primer login exitoso.
 * - Tokens de participante: 256 bits aleatorios entregados una sola vez al
 *   crear/unirse a una sesión. En la base solo se guarda su SHA-256, así un
 *   dump de la tabla no sirve para suplantar a nadie.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const HASH_PREFIX = "scrypt";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    HASH_PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join(":");
}

export function isHashedPassword(stored: string): boolean {
  return stored.startsWith(`${HASH_PREFIX}:`);
}

/**
 * Compara en tiempo constante. Soporta el formato scrypt nuevo y el texto
 * plano legado (sesiones creadas antes de que existiera el hashing).
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (isHashedPassword(stored)) {
    const parts = stored.split(":");
    if (parts.length !== 6) return false;
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const expected = Buffer.from(hashB64, "base64");
    let derived: Buffer;
    try {
      derived = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N, r, p });
    } catch {
      return false;
    }
    return expected.length > 0 && timingSafeEqual(derived, expected);
  }
  // Formato legado: texto plano. Comparación en tiempo constante vía hash
  // (los buffers deben medir lo mismo para timingSafeEqual).
  const a = createHash("sha256").update(password).digest();
  const b = createHash("sha256").update(stored).digest();
  return timingSafeEqual(a, b);
}

/** Token de participante: 256 bits, hex. Se entrega UNA vez, nunca se persiste en claro. */
export function generateParticipantToken(): string {
  return randomBytes(32).toString("hex");
}

/** Lo único que se guarda en session_participants.token_hash. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
