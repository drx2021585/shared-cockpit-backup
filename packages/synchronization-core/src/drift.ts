/**
 * Detección de divergencia entre dos snapshots del mismo avión. Regla no
 * negociable #4: la posición del avión NO es el método principal de
 * sincronización, solo sirve para detectar divergencia y corregir
 * controladamente. Esta función compara estado por sistema, no posición.
 */

export interface SystemDivergence {
  system: string;
  key: string;
  localValue: unknown;
  remoteValue: unknown;
}

export function detectDrift(
  local: Record<string, Record<string, unknown>>,
  remote: Record<string, Record<string, unknown>>
): SystemDivergence[] {
  const divergences: SystemDivergence[] = [];

  for (const system of Object.keys(remote)) {
    const remoteSystem = remote[system] ?? {};
    const localSystem = local[system] ?? {};
    for (const key of Object.keys(remoteSystem)) {
      if (localSystem[key] !== remoteSystem[key]) {
        divergences.push({
          system,
          key,
          localValue: localSystem[key],
          remoteValue: remoteSystem[key],
        });
      }
    }
  }

  return divergences;
}
