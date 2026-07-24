/**
 * LoopGuard — implementa la regla no negociable #2 del plan maestro:
 * "Todo cambio recibido de red se marca origin: remote y nunca se reenvía
 * como si fuera un cambio local nuevo."
 *
 * También deduplica por número de secuencia: si llega un mensaje con una
 * secuencia igual o menor a la última vista para ese controlId, se descarta
 * (evita procesar mensajes duplicados o fuera de orden en el canal rápido).
 */

export interface IncomingMessage {
  controlId: string;
  sequence: number;
  origin: "local" | "remote";
}

export class LoopGuard {
  private lastSequenceByControl = new Map<string, number>();

  /**
   * Decide si este mensaje debe aplicarse y, si es remoto, si debe
   * reenviarse. Nunca reenvía un mensaje de origen remoto.
   */
  shouldApply(msg: IncomingMessage): boolean {
    const last = this.lastSequenceByControl.get(msg.controlId) ?? -1;
    if (msg.sequence <= last) {
      return false; // duplicado o fuera de orden — descartar
    }
    this.lastSequenceByControl.set(msg.controlId, msg.sequence);
    return true;
  }

  shouldRebroadcast(msg: IncomingMessage): boolean {
    return msg.origin === "local";
  }
}

/**
 * Guard anti-TOGGLE — regla no negociable #1. Rechaza cualquier escritura de
 * control booleano cuyo evento de escritura sea un pulso TOGGLE crudo en vez
 * de SET_ON/SET_OFF/SET_VALUE explícito. Reutiliza la misma heurística que
 * tools/validate_profiles.py aplica a los perfiles, pero en tiempo de
 * ejecución sobre mensajes reales, no solo sobre YAML estático.
 */
export function isDangerousToggleWrite(writeEventName: string, dataType: "boolean" | "number" | "string"): boolean {
  return dataType === "boolean" && writeEventName.toUpperCase().includes("TOGGLE");
}

/**
 * Resuelve un conflicto de interruptor: dos jugadores cambian el mismo
 * control booleano casi simultáneamente. La regla es "último valor explícito
 * con timestamp mayor gana" — nunca se acumulan pulsos TOGGLE que se
 * invertirían entre sí (por eso el protocolo prohíbe TOGGLE en primer lugar).
 */
export interface SwitchChange {
  value: boolean;
  timestamp: number;
  source: string;
}

export function resolveSwitchConflict(a: SwitchChange, b: SwitchChange): SwitchChange {
  return a.timestamp >= b.timestamp ? a : b;
}
