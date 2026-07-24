/**
 * AuthorityManager — decide quién puede escribir cada grupo de controles y
 * gestiona la transferencia entre asientos. Implementación real de la Fase 5
 * del plan maestro (docs/plan-maestro.md), no un stub.
 */

export type Authority =
  | "exclusive"
  | "shared"
  | "captain-only"
  | "first-officer-only"
  | "instructor-only"
  | "local-only";

export type Seat = "captain" | "first_officer" | "observer";

export interface ControlGroupConfig {
  groupId: string;
  authority: Authority;
}

export interface TransferResult {
  ok: boolean;
  reason?: string;
  revision?: number;
}

interface GroupState {
  authority: Authority;
  owner: Seat | null; // solo relevante para "exclusive"
  revision: number;
}

export class AuthorityManager {
  private groups = new Map<string, GroupState>();

  registerGroup(config: ControlGroupConfig, initialOwner: Seat | null = null) {
    this.groups.set(config.groupId, {
      authority: config.authority,
      owner: initialOwner,
      revision: 0,
    });
  }

  /** ¿Puede este asiento escribir ahora mismo en este grupo? */
  canWrite(groupId: string, seat: Seat): boolean {
    const g = this.groups.get(groupId);
    if (!g) return false;

    switch (g.authority) {
      case "shared":
        return true;
      case "captain-only":
        return seat === "captain";
      case "first-officer-only":
        return seat === "first_officer";
      case "instructor-only":
        return false; // no hay rol instructor en el MVP (fuera de alcance)
      case "local-only":
        return false; // nunca se sincroniza, cada cliente lo maneja localmente
      case "exclusive":
        return g.owner === seat;
      default:
        return false;
    }
  }

  /**
   * Solicita transferir un grupo "exclusive" de un asiento a otro. Sigue la
   * secuencia documentada en el plan maestro: solicitud → aceptación →
   * transferencia. Aquí modelamos el paso final (una vez aceptado por la UI/
   * protocolo de sesión) — la aceptación en sí vive en el flujo de sesión,
   * no en el motor de autoridad.
   */
  transfer(groupId: string, fromSeat: Seat, toSeat: Seat): TransferResult {
    const g = this.groups.get(groupId);
    if (!g) return { ok: false, reason: "unknown-group" };
    if (g.authority !== "exclusive") {
      return { ok: false, reason: "group-not-transferable" };
    }
    if (g.owner !== fromSeat) {
      return { ok: false, reason: "not-current-owner" };
    }
    g.owner = toSeat;
    g.revision += 1;
    return { ok: true, revision: g.revision };
  }

  getOwner(groupId: string): Seat | null {
    return this.groups.get(groupId)?.owner ?? null;
  }

  getRevision(groupId: string): number {
    return this.groups.get(groupId)?.revision ?? 0;
  }
}
