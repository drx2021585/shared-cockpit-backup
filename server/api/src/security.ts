/**
 * Middleware y utilidades de seguridad HTTP/WS (sin dependencia de pg, para
 * poder testearlas aisladas — ver test/security.test.ts):
 *
 * - Rate limiting en memoria por IP (y por clave arbitraria, ej. joinCode).
 *   Sin dependencia externa: este proceso corre como instancia única en
 *   Render, así que un limitador en memoria alcanza; si algún día hay varias
 *   réplicas, migrar a un contador compartido (Redis) es territorio del
 *   orchestrator.
 * - Allowlist de CORS (reemplaza el `Access-Control-Allow-Origin: *` viejo).
 * - Cabeceras de seguridad tipo helmet, sin agregar helmet como dependencia.
 * - Log de auditoría estructurado (JSON por línea a stdout — Render los
 *   conserva; no se loguean contraseñas ni tokens jamás).
 */
import type { IncomingMessage } from "node:http";
import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Poda periódica para que el Map no crezca sin límite con IPs que nunca
// vuelven. unref() para no mantener vivo el proceso por esto.
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
pruneTimer.unref?.();

/**
 * Ventana fija por clave. Devuelve true si la petición está dentro del
 * límite, false si hay que rechazarla. Usable tanto desde middleware Express
 * como desde el handshake WebSocket (que no pasa por Express).
 */
export function checkRateLimit(name: string, key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucketKey = `${name}:${key}`;
  const bucket = buckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

/** Solo para tests: resetea el estado del limitador. */
export function resetRateLimits() {
  buckets.clear();
}

/**
 * IP real del cliente. Render/Railway ponen la IP original en
 * X-Forwarded-For; el server también setea app.set("trust proxy", 1) para
 * que req.ip haga lo mismo en rutas Express — este helper existe para el
 * handshake WebSocket, que recibe el IncomingMessage crudo.
 */
export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Middleware Express de rate limit por IP. */
export function rateLimit(name: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? clientIp(req);
    if (!checkRateLimit(name, ip, max, windowMs)) {
      audit("rate-limited", { route: name, ip });
      res.status(429).json({ error: "too-many-requests" });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// CORS con allowlist
// ---------------------------------------------------------------------------

// La app de escritorio (Electron empaquetado) carga desde file://, así que su
// fetch llega con Origin "null" (o sin Origin) — hay que aceptarlo para que
// la app funcione. Lo que se elimina con esta allowlist es que CUALQUIER
// página web (origen https arbitrario) pueda disparar requests autenticadas
// desde el navegador de un piloto, como pasaba con el "*" anterior.
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .concat(DEFAULT_ALLOWED_ORIGINS)
);

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin || origin === "null" || origin.startsWith("file://")) return true;
  return allowedOrigins.has(origin);
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    // Sin cabeceras CORS el navegador bloquea la respuesta; para preflight se
    // responde 403 explícito para no ejecutar nada más.
    if (req.method === "OPTIONS") {
      res.status(403).end();
      return;
    }
    audit("cors-denied", { origin, path: req.path, ip: req.ip });
    res.status(403).json({ error: "origin-not-allowed" });
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin && origin !== "null" ? origin : "null");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Cabeceras de seguridad (helmet-lite)
// ---------------------------------------------------------------------------

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Render termina TLS delante del proceso; solo tiene sentido anunciar HSTS
  // cuando la petición llegó por https real.
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
}

// ---------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------

/**
 * Log estructurado de eventos de seguridad (intentos fallidos, cierres de
 * sesión, transferencias de control). Nunca pasar contraseñas ni tokens acá.
 */
export function audit(event: string, details: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ audit: event, at: new Date().toISOString(), ...details }));
}

// ---------------------------------------------------------------------------
// Validación de entrada
// ---------------------------------------------------------------------------

export const JOIN_CODE_RE = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;

/**
 * Normaliza un campo de texto de usuario: debe ser string, se recorta, se
 * exige 1..max caracteres y se rechazan caracteres de control (evita
 * inyección de saltos de línea en logs y nombres "invisibles").
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}
