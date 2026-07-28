/**
 * Adaptador fino sobre packages/synchronization-core (AuthorityManager +
 * LoopGuard) para conectar el motor de autoridad/anti-ciclo real al relay de
 * mensajes de vuelo de server.ts. Ver packages/protocol/README.md, sección
 * "MVP de autoridad: grupo único flight_controls" — es la fuente de verdad
 * de este diseño; no reinventar reglas aquí, solo cablear.
 *
 * server/api no tiene todavía un workspace de npm formal (no hay
 * package.json raíz, ver CLAUDE.md), así que se importa el motor por ruta
 * relativa a su código fuente TS (mismo patrón que ya usa este repo: correr
 * TS directo vía --experimental-strip-types, sin paso de build), en vez de
 * depender de un symlink de node_modules que no existe hoy.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  AuthorityManager,
  LoopGuard,
  type Seat,
} from "../../../packages/synchronization-core/src/index.ts";

/** Único grupo de autoridad del MVP (ver README de protocol, punto 1). */
export const FLIGHT_CONTROLS_GROUP_ID = "flight_controls";

// Grupos "sombrilla" (sin dueño, sin transferencia) para enforzar en el
// servidor los controles `authority: captain-only`/`first-officer-only` de
// los manifests reales (ver packages/protocol/README.md, punto 3: "Cambio de
// comportamiento esperado (no bug)"). A diferencia de `flight_controls`, esto
// NO usa AuthorityManager.transfer ni owner por sesión -- captain-only/
// first-officer-only son fijos al seat, nunca cambian de dueño -- pero sí
// reutilizan AuthorityManager.canWrite (que ya sabe estas dos reglas, ver
// packages/synchronization-core/src/authority.ts) para no reimplementar el
// chequeo de seat en dos sitios.
const CAPTAIN_ONLY_GROUP_ID = "__captain_only__";
const FIRST_OFFICER_ONLY_GROUP_ID = "__first_officer_only__";

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/api/src -> repo root: ../../../
const REPO_ROOT = resolve(__dirname, "../../..");
const PROFILES_DIR = join(REPO_ROOT, "aircraft-profiles");

/**
 * Mapa controlId -> authority ("captain-only" | "first-officer-only"),
 * construido escaneando aircraft-profiles/*\/controls/*.yaml una sola vez al
 * cargar este módulo (mismo patrón/directorio que ./profiles.ts). Solo nos
 * interesan estos dos valores de authority aquí -- "shared"/"exclusive" no
 * pasan por este mapa ("exclusive" ya tiene su lista estática arriba,
 * "shared" no tiene gate). Si el mismo controlId aparece en más de un perfil
 * (ej. "autopilot.master" en pmdg-737-900 e ifly-737-max8) se asume que declara
 * la misma authority en todos -- hoy es cierto (ver capabilities de ambos
 * perfiles); si algún día diverge, gana la última carpeta escaneada, que no
 * es un comportamiento intencional, solo el límite de un mapa global sin
 * perfil activo por sesión (deuda, igual naturaleza que la del punto 5 del
 * README de protocol).
 */
function scanSeatRestrictedControls(): ReadonlyMap<string, "captain-only" | "first-officer-only"> {
  const map = new Map<string, "captain-only" | "first-officer-only">();
  if (!existsSync(PROFILES_DIR)) return map;

  for (const profileEntry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
    if (!profileEntry.isDirectory()) continue;
    const controlsDir = join(PROFILES_DIR, profileEntry.name, "controls");
    if (!existsSync(controlsDir)) continue;

    for (const controlFile of readdirSync(controlsDir, { withFileTypes: true })) {
      if (!controlFile.isFile() || !controlFile.name.endsWith(".yaml")) continue;
      const filePath = join(controlsDir, controlFile.name);
      let parsed: unknown;
      try {
        parsed = parseYaml(readFileSync(filePath, "utf-8"));
      } catch {
        continue; // archivo mal formado -- no es responsabilidad de este gate
      }
      if (!Array.isArray(parsed)) continue;
      for (const control of parsed) {
        if (!control || typeof control !== "object") continue;
        const id = (control as any).id;
        const authority = (control as any).authority;
        if (typeof id !== "string") continue;
        if (authority === "captain-only" || authority === "first-officer-only") {
          map.set(id, authority);
        }
      }
    }
  }
  return map;
}

const SEAT_RESTRICTED_CONTROLS = scanSeatRestrictedControls();

/**
 * Los únicos 6 controles `authority: exclusive` que existen hoy en los
 * manifests reales (`aircraft-profiles/pmdg-737-900/controls/
 * flight-controls.yaml`). Lista estática a propósito: con un solo grupo no
 * hace falta leer YAML de perfiles en tiempo real (ver packages/protocol/
 * README.md, punto 1). Si algún día aparece un control `exclusive` fuera de
 * este set, hay que actualizar esta lista Y agregar el campo `group` al
 * schema de perfiles (deuda documentada en ese mismo README, punto 5).
 */
export const FLIGHT_CONTROLS_EXCLUSIVE_IDS: ReadonlySet<string> = new Set([
  "flight.yoke.pitch",
  "flight.yoke.roll",
  "flight.rudder",
]);

export function isFlightControlsExclusive(controlId: string): boolean {
  return FLIGHT_CONTROLS_EXCLUSIVE_IDS.has(controlId);
}

function isKnownSeat(value: unknown): value is Seat {
  return value === "captain" || value === "first_officer" || value === "observer";
}

/** Estado de sincronización en memoria de UNA sesión activa. */
export interface SessionAuthorityState {
  authorityManager: AuthorityManager;
  loopGuard: LoopGuard;
}

// Un AuthorityManager/LoopGuard POR sesión activa, nunca global al proceso
// (ver README de protocol, punto 4): compartir el LoopGuard entre sesiones
// arriesga descartar mensajes legítimos de una sesión por coincidencia de
// secuencia/controlId con otra sesión completamente distinta.
const sessionsAuthority = new Map<string, SessionAuthorityState>();

/**
 * Obtiene (creando si hace falta) el estado de autoridad/anti-ciclo en
 * memoria de una sesión, sembrando el grupo `flight_controls` con el
 * `control_owner` persistido en Postgres (nunca `null`: ver
 * packages/synchronization-core/test/authority.test.ts, caso "exclusive
 * authority registered WITHOUT an initial owner blocks every seat until a
 * transfer assigns one" — un grupo exclusive sin owner bloquea a los DOS
 * asientos para siempre).
 *
 * Seguro de llamar en cada conexión WS (creación o reconexión): si la
 * sesión ya tiene estado en memoria, se devuelve tal cual, sin resembrar
 * (no queremos pisar el owner actual en memoria, que puede haber cambiado
 * por un `authority.transfer` desde que se creó la sesión, con el valor de
 * `control_owner` de una consulta vieja).
 */
export function ensureSessionAuthority(
  joinCode: string,
  controlOwnerSeat: string | null | undefined
): SessionAuthorityState {
  const existing = sessionsAuthority.get(joinCode);
  if (existing) return existing;

  const authorityManager = new AuthorityManager();
  // db.ts garantiza que control_owner arranca sembrado al seat del creador
  // (ver init()/createSession en db.ts) y por lo tanto nunca debería ser
  // null/observer aquí. Si por algún motivo llegara vacío igual, caemos a
  // "captain" en vez de dejar el grupo sin dueño (que bloquearía a ambos
  // asientos para siempre, el bug documentado arriba).
  const initialOwner: Seat =
    isKnownSeat(controlOwnerSeat) && controlOwnerSeat !== "observer" ? controlOwnerSeat : "captain";

  authorityManager.registerGroup(
    { groupId: FLIGHT_CONTROLS_GROUP_ID, authority: "exclusive" },
    initialOwner
  );
  // Grupos sombrilla captain-only/first-officer-only (ver comentario en la
  // declaración de estas constantes): sin owner, canWrite depende solo del
  // seat del que escribe, nunca cambia con la sesión.
  authorityManager.registerGroup({ groupId: CAPTAIN_ONLY_GROUP_ID, authority: "captain-only" });
  authorityManager.registerGroup({
    groupId: FIRST_OFFICER_ONLY_GROUP_ID,
    authority: "first-officer-only",
  });

  const state: SessionAuthorityState = { authorityManager, loopGuard: new LoopGuard() };
  sessionsAuthority.set(joinCode, state);
  return state;
}

/** Libera el estado en memoria de una sesión cerrada (evita fuga de memoria). */
export function clearSessionAuthority(joinCode: string): void {
  sessionsAuthority.delete(joinCode);
}

/**
 * Sincroniza el owner EN MEMORIA de `flight_controls` tras un `give-controls`
 * exitoso en Postgres (ver server.ts, ruta POST /api/sessions/:code/give-
 * controls). Sin esto, el `AuthorityManager` en memoria se queda con el
 * owner viejo para siempre (`ensureSessionAuthority` NUNCA resiembra una
 * sesión ya presente en memoria -- a propósito, para no pisar transferencias
 * ya aplicadas) y el nuevo dueño real (según Postgres, la fuente de verdad
 * persistente) seguiría siendo rechazado por `canRelayControlMessage` al
 * intentar escribir `flight.yoke.pitch`/`flight.yoke.roll`/`flight.rudder` --
 * una regresión real introducida por activar el gate de autoridad exclusive,
 * no un caso ya cubierto por el resto de este archivo.
 *
 * `giveControls` (db.ts) ya validó en la base que quien pidió el cambio era
 * el dueño anterior, así que aquí no repetimos esa validación -- solo
 * reflejamos el resultado ya autoritativo. Si por algún motivo el owner en
 * memoria no coincidiera con el `previousOwner` esperado (proceso reiniciado
 * a mitad de un flujo, sesión no seedeada todavía), `AuthorityManager.
 * transfer` fallaría silenciosamente por "not-current-owner" -- para ese
 * caso forzamos el owner directamente re-registrando el grupo, porque
 * Postgres manda y no queremos dejar el grupo con un owner desactualizado.
 */
export function syncFlightControlsOwner(joinCode: string, newOwnerSeat: string | null | undefined): void {
  if (!isKnownSeat(newOwnerSeat) || newOwnerSeat === "observer") return;
  const state = sessionsAuthority.get(joinCode);
  if (!state) return; // sin estado en memoria todavía: la próxima conexión lo siembra ya correcto desde Postgres

  const currentOwner = state.authorityManager.getOwner(FLIGHT_CONTROLS_GROUP_ID);
  if (currentOwner === newOwnerSeat) return;

  const result = currentOwner
    ? state.authorityManager.transfer(FLIGHT_CONTROLS_GROUP_ID, currentOwner, newOwnerSeat)
    : { ok: false as const };
  if (!result.ok) {
    // Desincronizado con Postgres (no debería pasar en operación normal) --
    // forzamos el valor correcto en vez de dejar el gate bloqueando al dueño
    // legítimo indefinidamente.
    state.authorityManager.registerGroup(
      { groupId: FLIGHT_CONTROLS_GROUP_ID, authority: "exclusive" },
      newOwnerSeat
    );
  }
}

/** Solo para tests/diagnóstico: no usar desde el flujo normal de relay. */
export function getSessionAuthorityForTest(joinCode: string): SessionAuthorityState | undefined {
  return sessionsAuthority.get(joinCode);
}

export type RelayDecision = { ok: true } | { ok: false; reason: string };

/**
 * Decide si un `control.event`/`control.axis` entrante debe reenviarse:
 *
 * 1. Si el controlId pertenece a `flight_controls` (los 6 exclusive),
 *    exige `AuthorityManager.canWrite` para el asiento del remitente.
 * 2. Para todo controlId (pertenezca o no a `flight_controls`), aplica el
 *    anti-ciclo/dedupe por secuencia de `LoopGuard`.
 *
 * Para controles `shared` (la gran mayoría) el paso 1 no aplica — el
 * comportamiento no cambia respecto al relay puro anterior, solo pasan por
 * el dedupe de secuencia.
 *
 * No lanza: describe la razón de rechazo para logging, sin cerrar la
 * conexión (mismo criterio que el resto de validaciones en server.ts).
 */
export function canRelayControlMessage(
  state: SessionAuthorityState,
  seat: string | null | undefined,
  controlId: string,
  sequence: number
): RelayDecision {
  if (isFlightControlsExclusive(controlId)) {
    if (!isKnownSeat(seat) || !state.authorityManager.canWrite(FLIGHT_CONTROLS_GROUP_ID, seat)) {
      return { ok: false, reason: "no-authority" };
    }
  } else {
    // Controles captain-only/first-officer-only fuera de flight_controls
    // (ej. controls/autopilot.yaml del PMDG). Cambio de comportamiento
    // esperado (ver packages/protocol/README.md, punto 3): antes de este
    // cambio no había gate activo para estos, ahora sí.
    const seatRestriction = SEAT_RESTRICTED_CONTROLS.get(controlId);
    if (seatRestriction) {
      const groupId = seatRestriction === "captain-only" ? CAPTAIN_ONLY_GROUP_ID : FIRST_OFFICER_ONLY_GROUP_ID;
      if (!isKnownSeat(seat) || !state.authorityManager.canWrite(groupId, seat)) {
        return { ok: false, reason: "no-authority" };
      }
    }
  }

  const applied = state.loopGuard.shouldApply({
    controlId,
    sequence,
    // Estos mensajes llegan directo de un cliente de ESTA sesión (no son un
    // reenvío ya marcado remote entre servidores) — por eso "local" aquí,
    // que es lo que activa el dedupe por secuencia en LoopGuard.shouldApply.
    // El campo origin:"remote" que ve el RESTO de participantes se asigna
    // en server.ts al reenviar (relayFlightMessage), no aquí.
    origin: "local",
  });
  if (!applied) {
    return { ok: false, reason: "loop-guard-duplicate" };
  }

  return { ok: true };
}
