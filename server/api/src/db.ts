/**
 * Base de datos real (SQLite vía node:sqlite, sin mocks). Esquema basado en
 * docs/database-schema.md, simplificado para el MVP (sin tabla users todavía
 * — las sesiones se identifican por nombre de piloto, no por cuenta).
 */
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ScannedProfile } from "./profiles.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, "shared-cockpit.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS aircraft_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    developer TEXT NOT NULL,
    version TEXT NOT NULL,
    coverage INTEGER NOT NULL,
    capabilities_json TEXT NOT NULL,
    msfs2020 INTEGER NOT NULL,
    msfs2024 INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    join_code TEXT UNIQUE NOT NULL,
    session_name TEXT NOT NULL,
    aircraft_profile_id TEXT NOT NULL REFERENCES aircraft_profiles(id),
    password TEXT,
    status TEXT NOT NULL DEFAULT 'waiting',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS session_participants (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    pilot_name TEXT NOT NULL,
    seat TEXT NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    disconnected_at TEXT,
    PRIMARY KEY (session_id, pilot_name)
  );
`);

/** Reemplaza el catálogo de perfiles con lo escaneado realmente de disco. */
export function syncAircraftProfiles(profiles: ScannedProfile[]) {
  const upsert = db.prepare(`
    INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, developer=excluded.developer, version=excluded.version,
      coverage=excluded.coverage, capabilities_json=excluded.capabilities_json,
      msfs2020=excluded.msfs2020, msfs2024=excluded.msfs2024
  `);
  for (const p of profiles) {
    upsert.run(
      p.id,
      p.name,
      p.developer,
      p.version,
      p.coverage,
      JSON.stringify(p.capabilities),
      p.compatibility.msfs2020 ? 1 : 0,
      p.compatibility.msfs2024 ? 1 : 0
    );
  }
}

export function listAircraftProfiles() {
  const rows = db.prepare("SELECT * FROM aircraft_profiles ORDER BY coverage DESC").all();
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    developer: r.developer,
    version: r.version,
    coverage: r.coverage,
    capabilities: JSON.parse(r.capabilities_json),
    compatibility: { msfs2020: !!r.msfs2020, msfs2024: !!r.msfs2024 },
  }));
}

function generateJoinCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  const rand = (n: number, offset: number) =>
    Array.from({ length: n }, (_, i) => chars[bytes[offset + i] % chars.length]).join("");
  return `${rand(3, 0)}-${rand(3, 3)}`;
}

export interface CreateSessionInput {
  sessionName: string;
  aircraftProfileId: string;
  password?: string;
  hostPilotName: string;
  hostSeat: "captain" | "first_officer";
}

export function createSession(input: CreateSessionInput) {
  const profile = db.prepare("SELECT id FROM aircraft_profiles WHERE id = ?").get(input.aircraftProfileId);
  if (!profile) {
    throw new Error(`unknown aircraft profile: ${input.aircraftProfileId}`);
  }

  const id = randomBytes(12).toString("hex");
  let joinCode = generateJoinCode();
  // Reintenta si por casualidad colisiona con un código ya activo (muy improbable, pero real).
  while (db.prepare("SELECT 1 FROM sessions WHERE join_code = ?").get(joinCode)) {
    joinCode = generateJoinCode();
  }

  db.prepare(
    `INSERT INTO sessions (id, join_code, session_name, aircraft_profile_id, password, status)
     VALUES (?, ?, ?, ?, ?, 'waiting')`
  ).run(id, joinCode, input.sessionName, input.aircraftProfileId, input.password ?? null);

  db.prepare(
    `INSERT INTO session_participants (session_id, pilot_name, seat) VALUES (?, ?, ?)`
  ).run(id, input.hostPilotName, input.hostSeat);

  return getSessionByCode(joinCode);
}

export function getSessionByCode(joinCode: string) {
  const session: any = db.prepare("SELECT * FROM sessions WHERE join_code = ?").get(joinCode);
  if (!session) return null;
  const participants = db
    .prepare("SELECT pilot_name, seat, joined_at FROM session_participants WHERE session_id = ? AND disconnected_at IS NULL")
    .all(session.id);
  return {
    id: session.id,
    joinCode: session.join_code,
    sessionName: session.session_name,
    aircraftProfileId: session.aircraft_profile_id,
    status: session.status,
    hasPassword: !!session.password,
    participants,
  };
}

export interface JoinSessionInput {
  joinCode: string;
  pilotName: string;
  seat: "captain" | "first_officer" | "observer";
  password?: string;
}

export function joinSession(input: JoinSessionInput) {
  const session: any = db.prepare("SELECT * FROM sessions WHERE join_code = ?").get(input.joinCode);
  if (!session) return { ok: false as const, reason: "session-not-found" };
  if (session.password && session.password !== input.password) {
    return { ok: false as const, reason: "invalid-password" };
  }

  const activeCount: any = db
    .prepare("SELECT COUNT(*) as n FROM session_participants WHERE session_id = ? AND disconnected_at IS NULL")
    .get(session.id);
  if (activeCount.n >= 2 && input.seat !== "observer") {
    return { ok: false as const, reason: "session-full" };
  }

  db.prepare(
    `INSERT INTO session_participants (session_id, pilot_name, seat) VALUES (?, ?, ?)
     ON CONFLICT(session_id, pilot_name) DO UPDATE SET disconnected_at = NULL, seat = excluded.seat`
  ).run(session.id, input.pilotName, input.seat);

  if (activeCount.n + 1 >= 2) {
    db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(session.id);
  }

  return { ok: true as const, session: getSessionByCode(input.joinCode) };
}

export function markDisconnected(joinCode: string, pilotName: string) {
  const session: any = db.prepare("SELECT id FROM sessions WHERE join_code = ?").get(joinCode);
  if (!session) return;
  db.prepare(
    `UPDATE session_participants SET disconnected_at = datetime('now')
     WHERE session_id = ? AND pilot_name = ?`
  ).run(session.id, pilotName);
}
