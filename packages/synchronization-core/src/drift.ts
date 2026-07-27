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

  // Unión de sistemas de ambos lados: un sistema (ej. "hydraulic") que solo
  // existe en `local` (porque el snapshot remoto aún no lo reporta, algo
  // esperable en una aeronave con muchos más sistemas como el PMDG 737) debe
  // detectarse como divergencia igual que uno que solo existe en `remote`.
  const systems = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const system of systems) {
    const remoteSystem = remote[system] ?? {};
    const localSystem = local[system] ?? {};
    // Misma lógica para las claves dentro de cada sistema: unión, no solo
    // las que trae `remote`.
    const keys = new Set([...Object.keys(localSystem), ...Object.keys(remoteSystem)]);
    for (const key of keys) {
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
