/**
 * Base de datos real (PostgreSQL vía `pg`, sin mocks). Esquema basado en
 * docs/database-schema.md, simplificado para el MVP (sin tabla users todavía
 * — las sesiones se identifican por nombre de piloto, no por cuenta).
 *
 * Antes este módulo usaba SQLite local (node:sqlite) con un archivo por
 * máquina. Eso rompía el flujo multijugador real: cada piloto corría su
 * propio servidor con su propio archivo, así que un amigo uniéndose con un
 * código de sesión nunca veía la sesión creada en la máquina del host. Ahora
 * se conecta a una instancia de PostgreSQL compartida (Supabase u otra) vía
 * DATABASE_URL, para que un único proceso de servidor desplegado sea la
 * fuente de verdad para todos los pilotos. Ver docs/database-schema.md.
 */
import pg from "pg";
import { randomBytes } from "node:crypto";
import type { ScannedProfile } from "./profiles.ts";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL no está definida. Este servidor requiere una base de datos " +
      "PostgreSQL real y compartida (por ejemplo, Supabase) — no hay fallback " +
      "a SQLite ni a un mock en memoria. Define DATABASE_URL en el entorno " +
      "(ver docs/database-schema.md) y vuelve a arrancar."
  );
}

export const pool = new Pool({ connectionString: DATABASE_URL });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS aircraft_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      developer TEXT NOT NULL,
      version TEXT NOT NULL,
      coverage INTEGER NOT NULL,
      capabilities_json TEXT NOT NULL,
      msfs2020 BOOLEAN NOT NULL,
      msfs2024 BOOLEAN NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      join_code TEXT UNIQUE NOT NULL,
      session_name TEXT NOT NULL,
      aircraft_profile_id TEXT NOT NULL REFERENCES aircraft_profiles(id),
      password TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS session_participants (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      pilot_name TEXT NOT NULL,
      seat TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      disconnected_at TIMESTAMPTZ,
      PRIMARY KEY (session_id, pilot_name)
    );
  `);
}

// Se dispara al importar el módulo; server.ts espera a que termine antes de
// aceptar tráfico (ver initDb export usado en server.ts).
export const dbReady = init().catch((err) => {
  console.error("[db] fallo al inicializar el esquema de PostgreSQL:", err.message);
  throw err;
});

/** Reemplaza el catálogo de perfiles con lo escaneado realmente de disco. */
export async function syncAircraftProfiles(profiles: ScannedProfile[]) {
  await dbReady;
  for (const p of profiles) {
    await pool.query(
      `INSERT INTO aircraft_profiles (id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, developer=excluded.developer, version=excluded.version,
         coverage=excluded.coverage, capabilities_json=excluded.capabilities_json,
         msfs2020=excluded.msfs2020, msfs2024=excluded.msfs2024`,
      [
        p.id,
        p.name,
        p.developer,
        p.version,
        p.coverage,
        JSON.stringify(p.capabilities),
        p.compatibility.msfs2020,
        p.compatibility.msfs2024,
      ]
    );
  }
}

export async function listAircraftProfiles() {
  await dbReady;
  const { rows } = await pool.query("SELECT * FROM aircraft_profiles ORDER BY coverage DESC");
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

export async function createSession(input: CreateSessionInput) {
  await dbReady;
  const { rows: profileRows } = await pool.query(
    "SELECT id FROM aircraft_profiles WHERE id = $1",
    [input.aircraftProfileId]
  );
  if (profileRows.length === 0) {
    throw new Error(`unknown aircraft profile: ${input.aircraftProfileId}`);
  }

  const id = randomBytes(12).toString("hex");
  let joinCode = generateJoinCode();
  // Reintenta si por casualidad colisiona con un código ya activo (muy improbable, pero real).
  while (
    (await pool.query("SELECT 1 FROM sessions WHERE join_code = $1", [joinCode])).rows.length > 0
  ) {
    joinCode = generateJoinCode();
  }

  await pool.query(
    `INSERT INTO sessions (id, join_code, session_name, aircraft_profile_id, password, status)
     VALUES ($1, $2, $3, $4, $5, 'waiting')`,
    [id, joinCode, input.sessionName, input.aircraftProfileId, input.password ?? null]
  );

  await pool.query(
    `INSERT INTO session_participants (session_id, pilot_name, seat) VALUES ($1, $2, $3)`,
    [id, input.hostPilotName, input.hostSeat]
  );

  return getSessionByCode(joinCode);
}

export async function getSessionByCode(joinCode: string) {
  await dbReady;
  const { rows } = await pool.query("SELECT * FROM sessions WHERE join_code = $1", [joinCode]);
  const session: any = rows[0];
  if (!session) return null;
  const { rows: participants } = await pool.query(
    "SELECT pilot_name, seat, joined_at FROM session_participants WHERE session_id = $1 AND disconnected_at IS NULL",
    [session.id]
  );
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

export async function joinSession(input: JoinSessionInput) {
  await dbReady;
  const { rows } = await pool.query("SELECT * FROM sessions WHERE join_code = $1", [input.joinCode]);
  const session: any = rows[0];
  if (!session) return { ok: false as const, reason: "session-not-found" };
  if (session.password && session.password !== input.password) {
    return { ok: false as const, reason: "invalid-password" };
  }

  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*) as n FROM session_participants WHERE session_id = $1 AND disconnected_at IS NULL",
    [session.id]
  );
  const activeCount = Number(countRows[0].n);
  if (activeCount >= 2 && input.seat !== "observer") {
    return { ok: false as const, reason: "session-full" };
  }

  await pool.query(
    `INSERT INTO session_participants (session_id, pilot_name, seat) VALUES ($1, $2, $3)
     ON CONFLICT(session_id, pilot_name) DO UPDATE SET disconnected_at = NULL, seat = excluded.seat`,
    [session.id, input.pilotName, input.seat]
  );

  if (activeCount + 1 >= 2) {
    await pool.query("UPDATE sessions SET status = 'active' WHERE id = $1", [session.id]);
  }

  return { ok: true as const, session: await getSessionByCode(input.joinCode) };
}

export async function markDisconnected(joinCode: string, pilotName: string) {
  await dbReady;
  const { rows } = await pool.query("SELECT id FROM sessions WHERE join_code = $1", [joinCode]);
  const session: any = rows[0];
  if (!session) return;
  await pool.query(
    `UPDATE session_participants SET disconnected_at = now()
     WHERE session_id = $1 AND pilot_name = $2`,
    [session.id, pilotName]
  );
}
