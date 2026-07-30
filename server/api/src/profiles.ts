/**
 * Escanea el directorio aircraft-profiles (uno por subcarpeta) y calcula una
 * cobertura real a partir del bloque `capabilities` de manifest.yaml — nada
 * de porcentajes inventados. Este es el mismo directorio que valida
 * tools/validate_profiles.py.
 *
 * Nota: cada perfil también puede tener un capabilities.yaml con detalle
 * expandido (controles concretos por sistema, qué falta) para uso humano/QA,
 * pero ese archivo NO se lee aquí — la cobertura mostrada en la UI sale
 * únicamente de manifest.yaml. Si capabilities.yaml y manifest.yaml
 * divergen (ej. se agrega un sistema en uno y no en el otro), la UI no lo
 * reflejará. Mantenerlos sincronizados es responsabilidad de
 * aircraft-profiles-agent hasta que exista una única fuente de verdad.
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

/**
 * Los controles no declaran a qué sistema pertenecen: se deduce del prefijo de
 * su id ("hydraulics.annun_low_press_eng_1" -> "hydraulics"). Esta tabla mapea
 * esos prefijos reales a las claves de `capabilities` del manifest, que son las
 * que declaran el techo de cobertura por sistema. Un prefijo que no esté aquí
 * no se ignora: cae al techo promedio del perfil (ver computeCoverage), porque
 * descartarlo inflaría el número al dejar fuera justo los sistemas que nadie
 * clasificó todavía.
 */
const SYSTEM_PREFIX_TO_CAPABILITY: Record<string, string> = {
  flight: "flightControls",
  flight_controls: "flightControls",
  gear: "flightControls",
  autopilot: "autopilot",
  autoflight: "autopilot",
  efis: "autopilot",
  fms: "autopilot",
  electrical: "electrical",
  apu: "electrical",
  hydraulics: "hydraulics",
  radios: "radios",
  comm: "radios",
  communications: "radios",
  mcdu: "mcdu",
  navigation: "mcdu",
  air: "air",
  anti_ice: "antiIce",
  engine: "engine",
  fuel: "fuel",
  fire_protection: "fireProtection",
  instruments: "instruments",
  warnings: "warnings",
  efb: "efb",
  misc: "cabinMisc",
  doors: "cabinMisc",
};

interface ProfileControl {
  id: string;
  read?: unknown;
  write?: unknown;
}

function readProfileControls(profileDir: string): ProfileControl[] {
  const controlsDir = join(profileDir, "controls");
  if (!existsSync(controlsDir)) return [];

  const controls: ProfileControl[] = [];
  for (const file of readdirSync(controlsDir)) {
    if (!file.endsWith(".yaml")) continue;
    const parsed = parseYaml(readFileSync(join(controlsDir, file), "utf-8"));
    if (Array.isArray(parsed)) controls.push(...parsed);
  }
  return controls;
}

export interface ScannedProfile {
  id: string;
  name: string;
  developer: string;
  schemaVersion: number;
  version: string;
  coverage: number; // 0-100, calculado, no inventado
  capabilities: Record<string, string>;
  compatibility: { msfs2020: boolean; msfs2024: boolean };
  /**
   * Modelos concretos que cubre el perfil, tal como se llaman en
   * SimObjects/Airplanes/ del paquete instalado (ej. "iFly 737-MAX8200").
   * Sale de `variants` en manifest.yaml. Es informativo para el jugador: un
   * solo perfil puede cubrir varias variantes cuando comparten cabina, y sin
   * esto no hay forma de saber desde la app cuales son.
   */
  variants: string[];
  /**
   * ¿Se probó este perfil contra MSFS de verdad, o solo se generó/escribió sin
   * volarlo? Sale de `verification: live-tested | untested` en manifest.yaml;
   * si el manifest no lo declara se asume NO verificado, que es el lado seguro.
   * Deliberadamente NO entra en `coverage`: un perfil generado a máquina puede
   * ser mecánicamente completo y aun así no funcionar en el sim.
   */
  verified: boolean;
}

/**
 * Cobertura real por perfil, medida sobre los controles que el perfil declara
 * de verdad — no sobre el enum `capabilities` a secas.
 *
 * Por qué cambió (2026-07-28): el cálculo anterior era el promedio del enum, y
 * el enum solo tiene tres valores (full/partial/none) para siete sistemas. Dos
 * perfiles que declaraban lo mismo daban idéntico número aunque uno tuviera
 * 646 controles y el otro 1053: PMDG e iFly empataban en 51%, que no le decía
 * nada al usuario.
 *
 * Ahora, por cada sistema real (deducido del prefijo del id del control):
 *   - se mide qué fracción de sus controles es BIDIRECCIONAL (tiene read y
 *     write). Solo esos sincronizan del todo: uno readOnly se puede observar
 *     pero no accionar desde el otro asiento, y uno writeOnly se puede
 *     accionar pero no reconciliar.
 *   - ese valor se limita por el techo que declara `capabilities` para el
 *     sistema (partial nunca puede mostrarse como 100%), y
 *   - se promedia ponderando por cantidad de controles, así un sistema con 200
 *     controles pesa más que uno con 5.
 *
 * IMPORTANTE: este número mide completitud MECÁNICA, no que el perfil se haya
 * probado en el simulador. Un perfil generado automáticamente puede salir alto
 * sin haberse volado nunca. Ese eje se reporta aparte (ver `verified`), a
 * propósito: mezclarlo acá haría que un perfil sin probar aparente estar listo.
 */
function computeCoverage(
  capabilities: Record<string, string>,
  controls: ProfileControl[]
): number {
  const declaredLevels = Object.values(capabilities);
  if (declaredLevels.length === 0) return 0;

  const meanDeclaredCap =
    declaredLevels.reduce((sum, level) => sum + (LEVEL_SCORE[level] ?? 0), 0) /
    declaredLevels.length;

  // Sin controles declarados no hay nada que medir: se cae al enum, que es la
  // única información disponible (perfiles nuevos o fixtures mínimos).
  if (controls.length === 0) return Math.round(meanDeclaredCap);

  const bySystem = new Map<string, { total: number; bidirectional: number }>();
  for (const control of controls) {
    const prefix = String(control.id ?? "").split(".")[0];
    const bucket = bySystem.get(prefix) ?? { total: 0, bidirectional: 0 };
    bucket.total += 1;
    if (control.read && control.write) bucket.bidirectional += 1;
    bySystem.set(prefix, bucket);
  }

  let weightedScore = 0;
  let totalWeight = 0;
  for (const [prefix, bucket] of bySystem) {
    const capabilityKey = SYSTEM_PREFIX_TO_CAPABILITY[prefix];
    const cap =
      capabilityKey && capabilities[capabilityKey] !== undefined
        ? LEVEL_SCORE[capabilities[capabilityKey]] ?? 0
        : meanDeclaredCap;
    const measured = (100 * bucket.bidirectional) / bucket.total;
    weightedScore += Math.min(measured, cap) * bucket.total;
    totalWeight += bucket.total;
  }

  return Math.round(weightedScore / totalWeight);
}

export function scanAircraftProfiles(): ScannedProfile[] {
  if (!existsSync(PROFILES_DIR)) return [];

  const profiles: ScannedProfile[] = [];
  for (const entry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(PROFILES_DIR, entry.name, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;

    const manifest = parseYaml(readFileSync(manifestPath, "utf-8"));
    const controls = readProfileControls(join(PROFILES_DIR, entry.name));
    profiles.push({
      id: manifest.aircraft.id,
      name: manifest.aircraft.name,
      developer: manifest.aircraft.developer,
      schemaVersion: manifest.schemaVersion,
      version: manifest.versions?.tested?.[manifest.versions.tested.length - 1] ?? "unknown",
      coverage: computeCoverage(manifest.capabilities ?? {}, controls),
      capabilities: manifest.capabilities ?? {},
      compatibility: manifest.compatibility ?? { msfs2020: false, msfs2024: false },
      variants: Array.isArray(manifest.variants)
        ? manifest.variants.filter((v: unknown): v is string => typeof v === "string")
        : [],
      verified: manifest.verification === "live-tested",
    });
  }
  return profiles;
}
