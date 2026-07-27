/**
 * SyncEngine — punto de integración único para mensajes que llegan de red.
 *
 * `applyIncomingMessage` es la función que networking-agent (o quien conecte
 * el WebSocket al motor) debe llamar por cada `control.event`, `control.axis`,
 * `authority.transfer` o `screen.snapshot` recibido de un peer. Combina en un
 * solo lugar:
 *
 *   1. Regla anti-TOGGLE (no negociable #1): rechaza escrituras de booleanos
 *      que serían un TOGGLE crudo antes que nada más — no debe ni consumir
 *      número de secuencia ni tocar el estado de autoridad.
 *   2. AuthorityManager.canWrite (no negociable, Fase 5): solo se aplica si
 *      quien originó el mensaje tenía autoridad sobre ese grupo de control
 *      en el momento de recibirlo.
 *   3. LoopGuard.shouldApply (no negociable #2): deduplica/descarta mensajes
 *      fuera de orden, y garantiza que el mensaje resultante quede marcado
 *      `origin: "remote"` y JAMÁS se reenvíe como si fuera un cambio local
 *      nuevo (shouldRebroadcast siempre da false para estos mensajes).
 *
 * Deliberadamente NO hace I/O: no toca SimConnect, WASM ni WebSocket. Solo
 * decide si un mensaje entrante debe aplicarse al estado local y devuelve la
 * versión ya marcada como remota para que la capa de transporte/estado la
 * use. Nunca hace fetch/send.
 */

import { AuthorityManager, type Seat } from "./authority.ts";
import { LoopGuard, isDangerousToggleWrite, type IncomingMessage } from "./loop-guard.ts";

/** Forma alineada con packages/protocol/types.ts ControlEvent, restringida a
 *  lo que el motor de sincronización necesita para decidir. `source` ya debe
 *  venir resuelto a un Seat (la resolución userId -> seat de la sesión vive
 *  fuera de este paquete). */
export interface IncomingControlEvent {
  type: "control.event";
  controlId: string;
  value: boolean | number | string;
  /** Tipo de dato del control; si se omite se infiere de `typeof value`. */
  dataType?: "boolean" | "number" | "string";
  /** Nombre real del evento de escritura (ej. SimConnect), si se conoce.
   *  Permite detectar un TOGGLE crudo camuflado como control.event. */
  writeEventName?: string;
  source: Seat;
  sequence: number;
  timestamp: number;
}

export interface IncomingControlAxis {
  type: "control.axis";
  controlId: string;
  value: number;
  source: Seat;
  sequence: number;
  timestamp: number;
}

export interface IncomingAuthorityTransfer {
  type: "authority.transfer";
  group: string;
  previousOwner: Seat;
  newOwner: Seat;
  revision: number;
}

/** Forma alineada con packages/protocol/types.ts ScreenSnapshot. Solo lectura
 *  (ej. CDU del PMDG 737 vía Client Data Area): no hay conflicto de autoridad
 *  que arbitrar, el capitán "posee" la pantalla real y el primer oficial solo
 *  la refleja. El único mecanismo que aplica es anti-ciclo + descarte de
 *  snapshots viejos por `revision`, igual que `authority.transfer`. */
export interface IncomingScreenSnapshot {
  type: "screen.snapshot";
  screenId: string;
  rows: number;
  cols: number;
  cells: unknown[];
  powered?: boolean;
  revision: number;
  timestamp?: number;
}

export type IncomingSyncMessage =
  | IncomingControlEvent
  | IncomingControlAxis
  | IncomingAuthorityTransfer
  | IncomingScreenSnapshot;

export type StampedMessage<T extends IncomingSyncMessage> = T & { origin: "remote" };

export type ApplyRejectionReason =
  | "dangerous-toggle-write"
  | "unauthorized"
  | "duplicate-or-out-of-order"
  | "transfer-owner-mismatch";

export type ApplyResult<T extends IncomingSyncMessage = IncomingSyncMessage> =
  | { ok: true; message: StampedMessage<T>; rebroadcast: false }
  | { ok: false; reason: ApplyRejectionReason };

export interface SyncEngineOptions {
  authority: AuthorityManager;
  /** Se crea uno propio por defecto; puede compartirse si el caller ya
   *  gestiona el ciclo de vida del LoopGuard en otro lado. */
  loopGuard?: LoopGuard;
  /** Mapea un controlId (ej. "lights.beacon") al groupId registrado en
   *  AuthorityManager (ej. "lights"). Por defecto usa el controlId tal cual,
   *  útil en pruebas; en producción el perfil de aeronave (profile-schema)
   *  debe proveer esta función. */
  resolveGroup?: (controlId: string) => string;
}

export class SyncEngine {
  readonly authority: AuthorityManager;
  private readonly loopGuard: LoopGuard;
  private readonly resolveGroup: (controlId: string) => string;

  constructor(options: SyncEngineOptions) {
    this.authority = options.authority;
    this.loopGuard = options.loopGuard ?? new LoopGuard();
    this.resolveGroup = options.resolveGroup ?? ((controlId) => controlId);
  }

  /**
   * Único punto de entrada para mensajes de red. Devuelve el mensaje ya
   * marcado `origin: "remote"` si debe aplicarse, o un motivo de rechazo.
   * `rebroadcast` siempre es `false` en el resultado exitoso: es la garantía
   * estructural de que este mensaje nunca vuelve a salir como si fuera un
   * cambio local nuevo (regla no negociable #2).
   */
  applyIncomingMessage(raw: IncomingSyncMessage): ApplyResult {
    switch (raw.type) {
      case "control.event":
        return this.applyControlEvent(raw);
      case "control.axis":
        return this.applyControlAxis(raw);
      case "authority.transfer":
        return this.applyAuthorityTransfer(raw);
      case "screen.snapshot":
        return this.applyScreenSnapshot(raw);
    }
  }

  private applyControlEvent(raw: IncomingControlEvent): ApplyResult<IncomingControlEvent> {
    const dataType = raw.dataType ?? (typeof raw.value as "boolean" | "number" | "string");

    // 1. Anti-TOGGLE primero: no debe consumir secuencia ni tocar autoridad.
    if (raw.writeEventName && isDangerousToggleWrite(raw.writeEventName, dataType)) {
      return { ok: false, reason: "dangerous-toggle-write" };
    }

    // 2. Autoridad: ¿quien lo originó podía escribir este grupo?
    const groupId = this.resolveGroup(raw.controlId);
    if (!this.authority.canWrite(groupId, raw.source)) {
      return { ok: false, reason: "unauthorized" };
    }

    // 3. Anti-ciclo / dedup por secuencia. Solo se consume secuencia una vez
    // pasadas las validaciones anteriores, para que un mensaje malicioso o
    // no autorizado no pueda bloquear secuencias legítimas futuras.
    const loopMsg: IncomingMessage = { controlId: raw.controlId, sequence: raw.sequence, origin: "remote" };
    if (!this.loopGuard.shouldApply(loopMsg)) {
      return { ok: false, reason: "duplicate-or-out-of-order" };
    }

    return this.finalize(raw, loopMsg);
  }

  private applyControlAxis(raw: IncomingControlAxis): ApplyResult<IncomingControlAxis> {
    const groupId = this.resolveGroup(raw.controlId);
    if (!this.authority.canWrite(groupId, raw.source)) {
      return { ok: false, reason: "unauthorized" };
    }

    const loopMsg: IncomingMessage = { controlId: raw.controlId, sequence: raw.sequence, origin: "remote" };
    if (!this.loopGuard.shouldApply(loopMsg)) {
      return { ok: false, reason: "duplicate-or-out-of-order" };
    }

    return this.finalize(raw, loopMsg);
  }

  private applyAuthorityTransfer(raw: IncomingAuthorityTransfer): ApplyResult<IncomingAuthorityTransfer> {
    // Precondición sin efectos secundarios: si el dueño actual no coincide
    // con previousOwner, rechazamos ANTES de consumir número de secuencia,
    // igual que con el anti-toggle en control.event — un mensaje inválido
    // no debe poder bloquear una transferencia legítima futura con la misma
    // revisión.
    if (this.authority.getOwner(raw.group) !== raw.previousOwner) {
      return { ok: false, reason: "transfer-owner-mismatch" };
    }

    // Las transferencias se deduplican por grupo+revision, no por controlId.
    const loopMsg: IncomingMessage = {
      controlId: `authority.transfer:${raw.group}`,
      sequence: raw.revision,
      origin: "remote",
    };
    if (!this.loopGuard.shouldApply(loopMsg)) {
      return { ok: false, reason: "duplicate-or-out-of-order" };
    }

    const result = this.authority.transfer(raw.group, raw.previousOwner, raw.newOwner);
    if (!result.ok) {
      return { ok: false, reason: "transfer-owner-mismatch" };
    }

    return this.finalize(raw, loopMsg);
  }

  private applyScreenSnapshot(raw: IncomingScreenSnapshot): ApplyResult<IncomingScreenSnapshot> {
    // Solo lectura, sin dueño que arbitrar (regla no negociable #5 no aplica
    // aquí: no hay "forzar estado", solo reflejar lo que el capitán ya ve).
    // Se deduplica por screenId+revision, igual patrón que authority.transfer
    // por group+revision: descarta snapshots viejos o fuera de orden.
    const loopMsg: IncomingMessage = {
      controlId: `screen.snapshot:${raw.screenId}`,
      sequence: raw.revision,
      origin: "remote",
    };
    if (!this.loopGuard.shouldApply(loopMsg)) {
      return { ok: false, reason: "duplicate-or-out-of-order" };
    }

    return this.finalize(raw, loopMsg);
  }

  private finalize<T extends IncomingSyncMessage>(raw: T, loopMsg: IncomingMessage): ApplyResult<T> {
    const stamped = { ...raw, origin: "remote" as const };

    // Invariante estructural: un mensaje marcado remoto nunca se reenvía.
    // Si esto alguna vez diera true habría un bug grave en LoopGuard.
    if (this.loopGuard.shouldRebroadcast(loopMsg)) {
      throw new Error("invariant violated: a remote-origin message was marked for rebroadcast");
    }

    return { ok: true, message: stamped, rebroadcast: false };
  }
}
