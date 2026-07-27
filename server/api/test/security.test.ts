/**
 * Tests de las primitivas de seguridad del backend (src/auth.ts +
 * src/security.ts). Corren sin base de datos ni red — por eso auth.ts y
 * security.ts no importan pg ni Express-app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  isHashedPassword,
  generateParticipantToken,
  hashToken,
} from "../src/auth.ts";
import {
  checkRateLimit,
  resetRateLimits,
  isOriginAllowed,
  cleanText,
  JOIN_CODE_RE,
} from "../src/security.ts";

test("hashPassword produce scrypt verificable y no reversible", () => {
  const stored = hashPassword("secreta123");
  assert.ok(isHashedPassword(stored));
  assert.ok(!stored.includes("secreta123"));
  assert.equal(verifyPassword("secreta123", stored), true);
  assert.equal(verifyPassword("otra", stored), false);
  assert.equal(verifyPassword("", stored), false);
});

test("dos hashes de la misma contraseña difieren (salt aleatorio)", () => {
  assert.notEqual(hashPassword("x"), hashPassword("x"));
});

test("verifyPassword soporta el formato legado en texto plano", () => {
  assert.equal(verifyPassword("legacy-pass", "legacy-pass"), true);
  assert.equal(verifyPassword("wrong", "legacy-pass"), false);
  assert.equal(isHashedPassword("legacy-pass"), false);
});

test("verifyPassword rechaza hashes corruptos sin lanzar", () => {
  assert.equal(verifyPassword("x", "scrypt:garbage"), false);
  assert.equal(verifyPassword("x", "scrypt:a:b:c:d:e"), false);
});

test("tokens de participante: 256 bits hex, hash determinista", () => {
  const token = generateParticipantToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, generateParticipantToken());
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), token);
});

test("checkRateLimit permite hasta max y bloquea el exceso por ventana", () => {
  resetRateLimits();
  for (let i = 0; i < 5; i++) {
    assert.equal(checkRateLimit("t", "1.2.3.4", 5, 60_000), true, `intento ${i + 1}`);
  }
  assert.equal(checkRateLimit("t", "1.2.3.4", 5, 60_000), false);
  // Otra clave (otra IP) no se ve afectada.
  assert.equal(checkRateLimit("t", "5.6.7.8", 5, 60_000), true);
  // Otro nombre de bucket tampoco.
  assert.equal(checkRateLimit("otro", "1.2.3.4", 5, 60_000), true);
  resetRateLimits();
});

test("isOriginAllowed: app de escritorio y dev sí, web arbitraria no", () => {
  assert.equal(isOriginAllowed(undefined), true); // sin Origin (no navegador)
  assert.equal(isOriginAllowed("null"), true); // Electron file://
  assert.equal(isOriginAllowed("file://"), true);
  assert.equal(isOriginAllowed("http://localhost:5173"), true);
  assert.equal(isOriginAllowed("https://evil.example.com"), false);
});

test("cleanText: recorta, limita largo y rechaza caracteres de control", () => {
  assert.equal(cleanText("  Darwin  ", 40), "Darwin");
  assert.equal(cleanText("", 40), null);
  assert.equal(cleanText("   ", 40), null);
  assert.equal(cleanText("x".repeat(41), 40), null);
  assert.equal(cleanText("linea1\nlinea2", 40), null);
  assert.equal(cleanText("nul\x00o", 40), null);
  assert.equal(cleanText(123, 40), null);
  assert.equal(cleanText(null, 40), null);
});

test("JOIN_CODE_RE: solo el formato XXX-XXX generado por el servidor", () => {
  assert.equal(JOIN_CODE_RE.test("ABC-234"), true);
  assert.equal(JOIN_CODE_RE.test("abc-234"), false);
  assert.equal(JOIN_CODE_RE.test("ABC234"), false);
  assert.equal(JOIN_CODE_RE.test("ABC-2345"), false);
  assert.equal(JOIN_CODE_RE.test("'; DROP TABLE sessions; --"), false);
});
