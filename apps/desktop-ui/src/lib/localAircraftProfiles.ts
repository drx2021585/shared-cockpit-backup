import type { AircraftProfile } from "./apiClient";

function coverageFromCapabilities(capabilities: Record<string, string>) {
  const levelScore: Record<string, number> = {
    full: 100,
    partial: 60,
    none: 0,
  };
  const values = Object.values(capabilities);
  if (values.length === 0) return 0;
  return Math.round(
    values.reduce((sum, level) => sum + (levelScore[level] ?? 0), 0) / values.length
  );
}

const LOCAL_AIRCRAFT_PROFILES: AircraftProfile[] = [
  {
    id: "ifly-737-max8",
    name: "iFly B737 MAX 8",
    developer: "iFly Development Team",
    version: "1.1.0.0",
    availability: "released" as const,
    capabilities: {
      flightControls: "full",
      autopilot: "full",
      electrical: "full",
      hydraulics: "full",
      radios: "partial",
      mcdu: "full",
      failures: "none",
      air: "full",
      antiIce: "full",
      engine: "full",
      fuel: "full",
      fireProtection: "full",
      instruments: "full",
      warnings: "full",
      efb: "partial",
      cabinMisc: "full",
    } as Record<string, string>,
    compatibility: { msfs2020: true, msfs2024: true },
    verified: false,
    variants: [
      "iFly 737-MAX8",
      "iFly 737-MAX8-166Seats",
      "iFly 737-MAX8-189Seats",
      "iFly 737-MAX8200",
    ],
    coverage: 0,
  },
  {
    id: "lvfr-a330-200",
    name: "LVFR A330-200",
    developer: "LatinVFR",
    version: "1.2.3",
    availability: "released" as const,
    capabilities: {
      flightControls: "full",
      autopilot: "full",
      electrical: "full",
      hydraulics: "full",
      radios: "full",
      mcdu: "full",
      failures: "partial",
      air: "partial",
      antiIce: "full",
      engine: "full",
      fuel: "full",
      fireProtection: "partial",
      instruments: "full",
      warnings: "partial",
      efb: "none",
      cabinMisc: "partial",
    } as Record<string, string>,
    compatibility: { msfs2020: true, msfs2024: false },
    verified: true,
    variants: ["LVFR A330-200GE", "LVFR A330-200PW", "LVFR A330-200RR"],
    coverage: 0,
  },
  {
    id: "lvfr-a330-300",
    name: "LVFR A330-300",
    developer: "LatinVFR",
    version: "1.0.0-beta",
    availability: "released" as const,
    capabilities: {
      flightControls: "full",
      autopilot: "full",
      electrical: "full",
      hydraulics: "full",
      radios: "full",
      mcdu: "full",
      failures: "partial",
      air: "partial",
      antiIce: "full",
      engine: "full",
      fuel: "full",
      fireProtection: "partial",
      instruments: "full",
      warnings: "partial",
      efb: "none",
      cabinMisc: "partial",
    } as Record<string, string>,
    compatibility: { msfs2020: true, msfs2024: false },
    verified: false,
    variants: ["LVFR A330-300", "LVFR A330-300F"],
    coverage: 0,
  },
  {
    id: "pmdg-737-900",
    name: "PMDG B737 NG",
    developer: "PMDG",
    version: "1.0.0",
    availability: "released" as const,
    capabilities: {
      flightControls: "partial",
      autopilot: "partial",
      electrical: "partial",
      hydraulics: "partial",
      radios: "partial",
      mcdu: "partial",
      failures: "none",
    } as Record<string, string>,
    compatibility: { msfs2020: true, msfs2024: false },
    verified: true,
    variants: [
      "PMDG 737-600",
      "PMDG 737-700",
      "PMDG 737-800",
      "PMDG 737-900",
      "PMDG 737 BBJ2",
      "PMDG 737 900ER",
      "PMDG 737 800 BDSF",
      "PMDG 737 800 BCF",
    ],
    coverage: 0,
  },
].map((profile) => ({
  ...profile,
  coverage: coverageFromCapabilities(profile.capabilities),
}));

export function mergeLocalAircraftProfiles(profiles: AircraftProfile[]): AircraftProfile[] {
  const byId = new Map<string, AircraftProfile>();
  for (const profile of profiles) {
    byId.set(profile.id, profile);
  }
  for (const localProfile of LOCAL_AIRCRAFT_PROFILES) {
    if (!byId.has(localProfile.id)) {
      byId.set(localProfile.id, localProfile);
    }
  }
  return [...byId.values()].sort((left, right) => right.coverage - left.coverage);
}
