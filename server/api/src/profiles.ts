/**
 * Escanea el directorio aircraft-profiles (uno por subcarpeta) y calcula una
 * cobertura real a partir de capabilities.yaml — nada de porcentajes
 * inventados. Este es el mismo directorio que valida tools/validate_profiles.py.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/api/src -> repo root: ../../../
const REPO_ROOT = resolve(__dirname, "../../..");
const PROFILES_DIR = join(REPO_ROOT, "aircraft-profiles");

const LEVEL_SCORE: Record<string, number> = {
  full: 100,
  partial: 60,
  none: 0,
};

export interface ScannedProfile {
  id: string;
  name: string;
  developer: string;
  schemaVersion: number;
  version: string;
  coverage: number; // 0-100, calculado, no inventado
  capabilities: Record<string, string>;
  compatibility: { msfs2020: boolean; msfs2024: boolean };
}

function computeCoverage(capabilities: Record<string, string>): number {
  const levels = Object.values(capabilities);
  if (levels.length === 0) return 0;
  const total = levels.reduce((sum, level) => sum + (LEVEL_SCORE[level] ?? 0), 0);
  return Math.round(total / levels.length);
}

export function scanAircraftProfiles(): ScannedProfile[] {
  if (!existsSync(PROFILES_DIR)) return [];

  const profiles: ScannedProfile[] = [];
  for (const entry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(PROFILES_DIR, entry.name, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;

    const manifest = parseYaml(readFileSync(manifestPath, "utf-8"));
    profiles.push({
      id: manifest.aircraft.id,
      name: manifest.aircraft.name,
      developer: manifest.aircraft.developer,
      schemaVersion: manifest.schemaVersion,
      version: manifest.versions?.tested?.[manifest.versions.tested.length - 1] ?? "unknown",
      coverage: computeCoverage(manifest.capabilities ?? {}),
      capabilities: manifest.capabilities ?? {},
      compatibility: manifest.compatibility ?? { msfs2020: false, msfs2024: false },
    });
  }
  return profiles;
}
