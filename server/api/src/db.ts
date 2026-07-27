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
import {
  generateParticipantToken,
  hashPassword,
  hashToken,
  isHashedPassword,
  verifyPassword,
} from "./auth.ts";
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
      sim TEXT NOT NULL DEFAULT 'msfs2020',
      creator_pilot_name TEXT,
      control_owner TEXT,
      control_requested_by TEXT,
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
  await pool.query(
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sim TEXT NOT NULL DEFAULT 'msfs2020'"
  );
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS creator_pilot_name TEXT");
  // control_owner / control_requested_by guardan `seat` ('captain' |
  // 'first_officer'), NO pilotName. Esto es intencional: packages/synchronization-core
  // (AuthorityManager/SyncEngine) es agnóstico de nombre de piloto y razona
  // en términos de seat. server/api (esta base de datos) es la fuente de
  // verdad PERSISTENTE de "quién es el dueño" a nivel de sesión — sobrevive
  // a reconexión — y se siembra hacia synchronization-core al conectar. Ver
  // decisión del orchestrator (2026-07-25).
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS control_owner TEXT");
  await pool.query("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS control_requested_by TEXT");
  await pool.query(
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS control_revision INTEGER NOT NULL DEFAULT 0"
  );
  // token_hash: SHA-256 del token de participante (ver src/auth.ts). El token
  // en claro solo viaja una vez en la respuesta de create/join; la base nunca
  // lo guarda. NULL = participante viejo sin token (deberá volver a unirse).
  await pool.query(
    "ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS token_hash TEXT"
  );
  await pool.query(`
    UPDATE sessions s
    SET creator_pilot_name = (
      SELECT pilot_name FROM session_participants
      WHERE session_id = s.id ORDER BY joined_at ASC LIMIT 1
    )
    WHERE s.creator_pilot_name IS NULL
  `);
  // Migración de datos viejos (de la noche anterior a esta decisión): si
  // control_owner quedó vacío, se siembra con el seat del creador de la
  // sesión en vez de su pilotName.
  await pool.query(`
    UPDATE sessions s
    SET control_owner = (
      SELECT seat FROM session_participants
      WHERE session_id = s.id AND pilot_name = s.creator_pilot_name
      LIMIT 1
    )
    WHERE s.control_owner IS NULL
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
  sim: "msfs2020" | "msfs2024";
}

export async function createSession(input: CreateSessionInput) {
  await dbReady;
  const { rows: profileRows } = await pool.query(
    "SELECT id, msfs2020, msfs2024 FROM aircraft_profiles WHERE id = $1",
    [input.aircraftProfileId]
  );
  if (profileRows.length === 0) {
    throw new Error(`unknown aircraft profile: ${input.aircraftProfileId}`);
  }
  if (!profileRows[0][input.sim]) {
    throw new Error(`aircraft-not-compatible-with-${input.sim}`);
  }

  const id = randomBytes(12).toString("hex");
  let joinCode = generateJoinCode();
  // Reintenta si por casualidad colisiona con un código ya activo (muy improbable, pero real).
  while (
    (await pool.query("SELECT 1 FROM sessions WHERE join_code = $1", [joinCode])).rows.length > 0
  ) {
    joinCode = generateJoinCode();
  }

  // control_owner arranca con el seat del host (no su pilotName) — ver
  // comentario en init() sobre por qué esta columna guarda seat.
  await pool.query(
    `INSERT INTO sessions (
       id, join_code, session_name, aircraft_profile_id, password, status, sim,
       creator_pilot_name, control_owner
     )
     VALUES ($1, $2, $3, $4, $5, 'waiting', $6, $7, $8)`,
    [
      id,
      joinCode,
      input.sessionName,
      input.aircraftProfileId,
      input.password ? hashPassword(input.password) : null,
      input.sim,
      input.hostPilotName,
      input.hostSeat,
    ]
  );

  const participantToken = generateParticipantToken();
  await pool.query(
    `INSERT INTO session_participants (session_id, pilot_name, seat, token_hash) VALUES ($1, $2, $3, $4)`,
    [id, input.hostPilotName, input.hostSeat, hashToken(participantToken)]
  );

  return { session: await getSessionByCode(joinCode), participantToken };
}

export async function getSessionByCode(joinCode: string) {
  await dbReady;
  const { rows } = await pool.query(
    "SELECT * FROM sessions WHERE join_code = $1 AND ended_at IS NULL",
    [joinCode]
  );
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
    sim: session.sim,
    creatorPilotName: session.creator_pilot_name,
    // controlOwner / controlRequestedBy son `seat` ('captain' | 'first_officer'),
    // no pilotName — ver comentario en init(). controlRevision incrementa en
    // cada giveControls exitoso y es lo que se manda como `revision` en el
    // mensaje authority.transfer del protocolo.
    controlOwner: session.control_owner,
    controlRequestedBy: session.control_requested_by,
    controlRevision: Number(session.control_revision ?? 0),
    hasPassword: !!session.password,
    participants,
  };
}

export async function closeSession(joinCode: string, pilotName: string) {
  await dbReady;
  const { rows } = await pool.query(
    `UPDATE sessions
     SET ended_at = now(), status = 'ended'
     WHERE join_code = $1
       AND ended_at IS NULL
       AND creator_pilot_name = $2
     RETURNING id`,
    [joinCode, pilotName]
  );
  return rows.length > 0;
}

export interface JoinSessionInput {
  joinCode: string;
  pilotName: string;
  seat: "captain" | "first_officer" | "observer";
  password?: string;
}

export async function joinSession(input: JoinSessionInput) {
  await dbReady;
  const { rows } = await pool.query(
    "SELECT * FROM sessions WHERE join_code = $1 AND ended_at IS NULL",
    [input.joinCode]
  );
  const session: any = rows[0];
  if (!session) return { ok: false as const, reason: "session-not-found" };
  if (session.password) {
    if (!input.password || !verifyPassword(input.password, session.password)) {
      return { ok: false as const, reason: "invalid-password" };
    }
    // Migración perezosa: si la fila todavía guarda la contraseña en texto
    // plano (creada antes del hashing scrypt), se re-hashea en el primer
    // login exitoso.
    if (!isHashedPassword(session.password)) {
      await pool.query("UPDATE sessions SET password = $2 WHERE id = $1", [
        session.id,
        hashPassword(input.password),
      ]);
    }
  }

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) as n FROM session_participants
     WHERE session_id = $1 AND disconnected_at IS NULL AND seat <> 'observer'`,
    [session.id]
  );
  const activeCount = Number(countRows[0].n);
  if (activeCount >= 2 && input.seat !== "observer") {
    return { ok: false as const, reason: "session-full" };
  }

  // Cada join (incluida la re-unión del mismo pilotName) rota el token de
  // participante: el anterior queda invalidado y el nuevo se devuelve UNA vez.
  const participantToken = generateParticipantToken();
  await pool.query(
    `INSERT INTO session_participants (session_id, pilot_name, seat, token_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT(session_id, pilot_name) DO UPDATE
       SET disconnected_at = NULL, seat = excluded.seat, token_hash = excluded.token_hash`,
    [session.id, input.pilotName, input.seat, hashToken(participantToken)]
  );

  if (input.seat !== "observer" && activeCount + 1 >= 2) {
    await pool.query("UPDATE sessions SET status = 'active' WHERE id = $1", [session.id]);
  }

  return {
    ok: true as const,
    session: await getSessionByCode(input.joinCode),
    participantToken,
  };
}

/**
 * Resuelve un token de participante (Authorization: Bearer ... en HTTP, o
 * ?token= en el handshake WebSocket) a la identidad real de ese participante
 * dentro de la sesión indicada. Es la ÚNICA fuente de identidad del backend:
 * el pilotName que el cliente pueda mandar en el body ya no se usa para
 * autorizar nada. Devuelve null si el token no corresponde a un participante
 * de esa sesión activa.
 */
export async function authenticateParticipant(joinCode: string, token: string | null) {
  await dbReady;
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT sp.pilot_name, sp.seat
     FROM sessions s
     JOIN session_participants sp ON sp.session_id = s.id
     WHERE s.join_code = $1 AND s.ended_at IS NULL AND sp.token_hash = $2`,
    [joinCode, hashToken(token)]
  );
  if (rows.length === 0) return null;
  return { pilotName: rows[0].pilot_name as string, seat: rows[0].seat as string };
}

/** Reconexión WebSocket autenticada: vuelve a marcar presente al participante. */
export async function markReconnected(joinCode: string, pilotName: string) {
  await dbReady;
  await pool.query(
    `UPDATE session_participants sp SET disconnected_at = NULL
     FROM sessions s
     WHERE s.id = sp.session_id AND s.join_code = $1 AND s.ended_at IS NULL
       AND sp.pilot_name = $2`,
    [joinCode, pilotName]
  );
}

export async function leaveSession(joinCode: string, pilotName: string) {
  await markDisconnected(joinCode, pilotName);
  const session = await getSessionByCode(joinCode);
  if (!session) return false;
  // Resolución nombre->seat: quien se va se identifica por pilotName (así lo
  // manda el cliente HTTP), pero control_owner se guarda como seat. Hay que
  // buscar el seat de este pilotName entre los participantes (todavía
  // presentes en la fila, aunque ya se marcó disconnected_at arriba) antes
  // de comparar contra control_owner.
  const { rows: selfRows } = await pool.query(
    "SELECT seat FROM session_participants WHERE session_id = $1 AND pilot_name = $2",
    [session.id, pilotName]
  );
  const selfSeat: string | undefined = selfRows[0]?.seat;
  if (selfSeat && session.controlOwner === selfSeat) {
    // session.participants ya viene filtrado por getSessionByCode a solo
    // disconnected_at IS NULL (y markDisconnected ya corrió arriba, así que
    // pilotName ya no aparece ahí) — el filtro por pilot_name es defensivo,
    // no hace daño.
    const nextPilot = session.participants.find(
      (p: any) => p.pilot_name !== pilotName && p.seat !== "observer"
    );
    let nextSeat: string | null = nextPilot?.seat ?? null;
    // Fallback al seat del creador SOLO si el creador no es quien se está
    // yendo — de lo contrario el creador sigue teniendo una fila en
    // session_participants (solo se marca disconnected_at, nunca se borra) y
    // el fallback encontraría su propio seat, dejando control_owner
    // apuntando a un asiento sin nadie conectado.
    if (!nextSeat && session.creatorPilotName && session.creatorPilotName !== pilotName) {
      const { rows: creatorRows } = await pool.query(
        "SELECT seat FROM session_participants WHERE session_id = $1 AND pilot_name = $2 AND disconnected_at IS NULL",
        [session.id, session.creatorPilotName]
      );
      nextSeat = creatorRows[0]?.seat ?? null;
    }
    await pool.query(
      "UPDATE sessions SET control_owner = $2, control_requested_by = NULL WHERE id = $1",
      [session.id, nextSeat]
    );
  }
  // Salida explícita = fin de esa identidad: el token deja de valer. Para
  // volver a entrar hay que pasar de nuevo por join (con contraseña si la hay).
  await pool.query(
    "UPDATE session_participants SET token_hash = NULL WHERE session_id = $1 AND pilot_name = $2",
    [session.id, pilotName]
  );
  return true;
}

/**
 * `pilotName` sigue llegando desde el cliente HTTP como una persona (así lo
 * manda la UI), pero control_owner/control_requested_by en la base de datos
 * se guardan como `seat` ('captain' | 'first_officer'), no pilotName — ver
 * comentario en init(). Por eso, antes de comparar o guardar, resolvemos
 * nombre->seat consultando session_participants. Si el pilotName no está
 * sentado en un asiento activo no-observador, la solicitud se rechaza (el
 * EXISTS de abajo ya lo garantiza, igual que antes).
 */
export async function requestControls(joinCode: string, pilotName: string) {
  await dbReady;
  const { rows } = await pool.query(
    `UPDATE sessions s SET control_requested_by = sp.seat
     FROM session_participants sp
     WHERE s.join_code = $1 AND s.ended_at IS NULL
       AND sp.session_id = s.id AND sp.pilot_name = $2
       AND sp.disconnected_at IS NULL AND sp.seat <> 'observer'
       AND s.control_owner <> sp.seat
     RETURNING s.id`,
    [joinCode, pilotName]
  );
  return rows.length > 0;
}

/**
 * Igual que requestControls: `pilotName` es quien hace la llamada HTTP (debe
 * ser el dueño actual de los controles para poder cederlos), pero se resuelve
 * a seat antes de comparar contra control_owner. control_revision se
 * incrementa atómicamente en el mismo UPDATE — esa revisión es la que se
 * manda en el mensaje authority.transfer del protocolo para que
 * synchronization-core pueda descartar transferencias fuera de orden.
 */
export async function giveControls(joinCode: string, pilotName: string) {
  await dbReady;
  const { rows } = await pool.query(
    `UPDATE sessions s SET
       control_owner = s.control_requested_by,
       control_requested_by = NULL,
       control_revision = s.control_revision + 1
     FROM session_participants sp
     WHERE s.join_code = $1 AND s.ended_at IS NULL
       AND sp.session_id = s.id AND sp.pilot_name = $2
       AND sp.disconnected_at IS NULL
       AND s.control_owner = sp.seat AND s.control_requested_by IS NOT NULL
     RETURNING s.id, sp.seat AS previous_owner, s.control_owner AS new_owner,
       s.control_revision AS revision`,
    [joinCode, pilotName]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  // `sp.seat` en el WHERE se evalúa contra la fila de `sessions` ANTES del
  // UPDATE (comportamiento estándar de Postgres en UPDATE ... FROM), así que
  // sigue siendo el owner previo aunque aparezca en la misma sentencia.
  // `s.control_owner` y `s.control_revision` en el RETURNING sí reflejan la
  // fila ya actualizada: nuevo dueño y revisión post-incremento.
  return {
    previousOwner: row.previous_owner as string,
    newOwner: row.new_owner as string,
    revision: Number(row.revision),
  };
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
