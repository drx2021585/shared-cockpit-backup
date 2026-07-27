/**
 * Fake in-memory implementation del subconjunto de `pg` que usa server/api/src/db.ts.
 *
 * server/api/src/db.ts exige DATABASE_URL real (lanza si no está definida) y usa
 * un `pg.Pool` real — no hay fallback local. Este entorno de test NO tiene un
 * Postgres real disponible, así que en vez de correr contra una base de datos
 * de verdad, interceptamos el módulo "pg" con `t.mock.module()` (node:test,
 * --experimental-test-module-mocks) y sustituimos `Pool` por esta clase, que
 * reconoce cada consulta SQL literal de db.ts por subcadenas únicas y aplica
 * la misma semántica sobre estructuras en memoria.
 *
 * Esto es deliberadamente frágil frente a cambios de redacción del SQL en
 * db.ts (no es un motor SQL genérico) — si alguien reescribe una query en
 * db.ts sin tocar este archivo, estos tests empezarán a fallar (o a devolver
 * filas vacías) y hay que actualizar el `handleQuery` de aquí también. Ver
 * test/db.test.ts para el uso.
 */

export interface FakeDbState {
  profiles: Map<string, any>;
  sessions: Map<string, any>;
  participants: any[];
}

export function createFakeState(): FakeDbState {
  return { profiles: new Map(), sessions: new Map(), participants: [] };
}

function activeParticipants(state: FakeDbState, sessionId: string) {
  return state.participants.filter((p) => p.session_id === sessionId);
}

async function handleQuery(state: FakeDbState, text: string, params: any[]) {
  // --- init(): creación de esquema / migraciones, todos no-op sobre un estado en memoria ---
  if (text.includes("CREATE TABLE IF NOT EXISTS aircraft_profiles")) {
    return { rows: [] };
  }
  if (text.includes("ALTER TABLE sessions ADD COLUMN")) {
    return { rows: [] };
  }
  if (text.includes("SET creator_pilot_name = (")) {
    return { rows: [] };
  }
  if (text.includes("SET control_owner = (")) {
    return { rows: [] };
  }

  // --- syncAircraftProfiles / listAircraftProfiles ---
  if (text.includes("INSERT INTO aircraft_profiles (id, name, developer")) {
    const [id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024] = params;
    state.profiles.set(id, { id, name, developer, version, coverage, capabilities_json, msfs2020, msfs2024 });
    return { rows: [] };
  }
  if (text.includes("SELECT * FROM aircraft_profiles ORDER BY coverage DESC")) {
    const rows = [...state.profiles.values()].sort((a, b) => b.coverage - a.coverage);
    return { rows };
  }

  // --- generateJoinCode collision check ---
  if (text.includes("SELECT 1 FROM sessions WHERE join_code = $1")) {
    const [joinCode] = params;
    const exists = [...state.sessions.values()].some((s) => s.join_code === joinCode);
    return { rows: exists ? [{ "?column?": 1 }] : [] };
  }

  // --- createSession: lookup del perfil ---
  if (text.includes("SELECT id, msfs2020, msfs2024 FROM aircraft_profiles WHERE id = $1")) {
    const [id] = params;
    const p = state.profiles.get(id);
    return { rows: p ? [{ id: p.id, msfs2020: p.msfs2020, msfs2024: p.msfs2024 }] : [] };
  }

  // --- createSession: insert de la sesión ---
  if (text.includes("INSERT INTO sessions (")) {
    const [id, joinCode, sessionName, aircraftProfileId, password, sim, hostPilotName, hostSeat] = params;
    state.sessions.set(id, {
      id,
      join_code: joinCode,
      session_name: sessionName,
      aircraft_profile_id: aircraftProfileId,
      password: password ?? null,
      status: "waiting",
      sim,
      creator_pilot_name: hostPilotName,
      control_owner: hostSeat,
      control_requested_by: null,
      control_revision: 0,
      created_at: new Date(),
      ended_at: null,
    });
    return { rows: [] };
  }

  // --- INSERT INTO session_participants: dos formas distintas (plain vs upsert) ---
  if (text.includes("INSERT INTO session_participants (session_id, pilot_name, seat) VALUES ($1, $2, $3)")) {
    const [sessionId, pilotName, seat] = params;
    if (text.includes("ON CONFLICT")) {
      const existing = state.participants.find(
        (p) => p.session_id === sessionId && p.pilot_name === pilotName
      );
      if (existing) {
        existing.disconnected_at = null;
        existing.seat = seat;
      } else {
        state.participants.push({
          session_id: sessionId,
          pilot_name: pilotName,
          seat,
          joined_at: new Date(),
          disconnected_at: null,
        });
      }
    } else {
      state.participants.push({
        session_id: sessionId,
        pilot_name: pilotName,
        seat,
        joined_at: new Date(),
        disconnected_at: null,
      });
    }
    return { rows: [] };
  }

  // --- getSessionByCode / joinSession: SELECT * FROM sessions WHERE join_code = $1 AND ended_at IS NULL ---
  if (text.includes("SELECT * FROM sessions WHERE join_code = $1 AND ended_at IS NULL")) {
    const [joinCode] = params;
    const session = [...state.sessions.values()].find((s) => s.join_code === joinCode && s.ended_at === null);
    return { rows: session ? [session] : [] };
  }

  // --- getSessionByCode: participantes activos ---
  if (
    text.includes(
      "SELECT pilot_name, seat, joined_at FROM session_participants WHERE session_id = $1 AND disconnected_at IS NULL"
    )
  ) {
    const [sessionId] = params;
    const rows = activeParticipants(state, sessionId)
      .filter((p) => p.disconnected_at === null)
      .map((p) => ({ pilot_name: p.pilot_name, seat: p.seat, joined_at: p.joined_at }));
    return { rows };
  }

  // --- closeSession ---
  if (text.includes("SET ended_at = now(), status = 'ended'")) {
    const [joinCode, pilotName] = params;
    const session = [...state.sessions.values()].find(
      (s) => s.join_code === joinCode && s.ended_at === null && s.creator_pilot_name === pilotName
    );
    if (!session) return { rows: [] };
    session.ended_at = new Date();
    session.status = "ended";
    return { rows: [{ id: session.id }] };
  }

  // --- joinSession: conteo de participantes activos no-observadores ---
  if (text.includes("SELECT COUNT(*) as n FROM session_participants")) {
    const [sessionId] = params;
    const n = activeParticipants(state, sessionId).filter(
      (p) => p.disconnected_at === null && p.seat !== "observer"
    ).length;
    return { rows: [{ n: String(n) }] };
  }

  // --- joinSession: marca la sesión como activa ---
  if (text.includes("SET status = 'active' WHERE id = $1")) {
    const [sessionId] = params;
    const session = state.sessions.get(sessionId);
    if (session) session.status = "active";
    return { rows: [] };
  }

  // --- markDisconnected: lookup de sesión por join_code (SIN filtro ended_at) ---
  if (text.trim() === "SELECT id FROM sessions WHERE join_code = $1") {
    const [joinCode] = params;
    const session = [...state.sessions.values()].find((s) => s.join_code === joinCode);
    return { rows: session ? [{ id: session.id }] : [] };
  }

  // --- markDisconnected: marca disconnected_at ---
  if (text.includes("UPDATE session_participants SET disconnected_at = now()")) {
    const [sessionId, pilotName] = params;
    const p = state.participants.find((x) => x.session_id === sessionId && x.pilot_name === pilotName);
    if (p) p.disconnected_at = new Date();
    return { rows: [] };
  }

  // --- leaveSession: resolución pilotName -> seat ---
  if (text.includes("SELECT seat FROM session_participants WHERE session_id = $1 AND pilot_name = $2")) {
    const [sessionId, pilotName] = params;
    const p = state.participants.find((x) => x.session_id === sessionId && x.pilot_name === pilotName);
    return { rows: p ? [{ seat: p.seat }] : [] };
  }

  // --- leaveSession: reasigna control_owner ---
  if (text.includes("SET control_owner = $2, control_requested_by = NULL WHERE id = $1")) {
    const [sessionId, nextSeat] = params;
    const session = state.sessions.get(sessionId);
    if (session) {
      session.control_owner = nextSeat;
      session.control_requested_by = null;
    }
    return { rows: [] };
  }

  // --- requestControls ---
  if (text.includes("SET control_requested_by = sp.seat")) {
    const [joinCode, pilotName] = params;
    const session = [...state.sessions.values()].find((s) => s.join_code === joinCode && s.ended_at === null);
    if (!session) return { rows: [] };
    const participant = state.participants.find(
      (p) =>
        p.session_id === session.id &&
        p.pilot_name === pilotName &&
        p.disconnected_at === null &&
        p.seat !== "observer"
    );
    if (!participant) return { rows: [] };
    if (session.control_owner === participant.seat) return { rows: [] };
    session.control_requested_by = participant.seat;
    return { rows: [{ id: session.id }] };
  }

  // --- giveControls ---
  if (text.includes("control_revision = s.control_revision + 1")) {
    const [joinCode, pilotName] = params;
    const session = [...state.sessions.values()].find((s) => s.join_code === joinCode && s.ended_at === null);
    if (!session) return { rows: [] };
    const participant = state.participants.find(
      (p) => p.session_id === session.id && p.pilot_name === pilotName && p.disconnected_at === null
    );
    if (!participant) return { rows: [] };
    if (session.control_owner !== participant.seat) return { rows: [] };
    if (session.control_requested_by === null) return { rows: [] };

    const previousOwner = session.control_owner;
    const newOwner = session.control_requested_by;
    session.control_owner = newOwner;
    session.control_requested_by = null;
    session.control_revision += 1;
    return {
      rows: [
        {
          id: session.id,
          previous_owner: previousOwner,
          new_owner: newOwner,
          revision: session.control_revision,
        },
      ],
    };
  }

  throw new Error(`FakePool: consulta no reconocida por el fake (actualizar fakePg.ts): ${text}`);
}

export function makeFakePgModule() {
  const state = createFakeState();
  class FakePool {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_opts?: any) {}
    async query(text: string, params: any[] = []) {
      return handleQuery(state, text, params);
    }
  }
  return { exportsDefault: { Pool: FakePool }, state };
}
