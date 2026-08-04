import type { AircraftProfile } from "./apiClient";

type LocalAircraftProfile = AircraftProfile & {
  coverageOverride?: number;
};

const PROFILE_ID_ALIASES: Record<string, string> = {
  "lvfr-a330-300": "lvfr-a330-200",
};

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

const LOCAL_AIRCRAFT_PROFILES: LocalAircraftProfile[] = [
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
    name: "LVFR A330-200/300",
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
    verified: false,
    variants: [
      "LVFR A330-200GE",
      "LVFR A330-200PW",
      "LVFR A330-200RR",
      "LVFR A330-300",
      "LVFR A330-300F",
    ],
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
      air: "partial",
      antiIce: "partial",
      engine: "partial",
      fuel: "partial",
      fireProtection: "partial",
      instruments: "partial",
      warnings: "partial",
      efb: "none",
      cabinMisc: "partial",
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
    coverageOverride: 31,
    coverage: 0,
  },
].map((profile) => ({
  ...profile,
  coverage: profile.coverageOverride ?? coverageFromCapabilities(profile.capabilities),
}));

export function mergeLocalAircraftProfiles(profiles: AircraftProfile[]): AircraftProfile[] {
  const canonicalizeId = (id: string) => PROFILE_ID_ALIASES[id] ?? id;
  const mergeVariants = (left?: string[], right?: string[]) =>
    [...new Set([...(left ?? []), ...(right ?? [])])];
  const mergeProfile = (
    current: AircraftProfile | undefined,
    incoming: AircraftProfile
  ): AircraftProfile => {
    if (!current) {
      return {
        ...incoming,
        id: canonicalizeId(incoming.id),
        variants: mergeVariants(incoming.variants),
      };
    }

    return {
      ...incoming,
      ...current,
      id: canonicalizeId(incoming.id),
      name: incoming.id === canonicalizeId(incoming.id) ? incoming.name : current.name,
      developer: incoming.id === canonicalizeId(incoming.id) ? incoming.developer : current.developer,
      version:
        incoming.id === canonicalizeId(incoming.id) && incoming.version !== "unknown"
          ? incoming.version
          : current.version,
      availability:
        incoming.id === canonicalizeId(incoming.id)
          ? (incoming.availability ?? current.availability)
          : (current.availability ?? incoming.availability),
      coverage: Math.max(current.coverage, incoming.coverage),
      capabilities: {
        ...current.capabilities,
        ...incoming.capabilities,
      },
      compatibility: {
        msfs2020: current.compatibility.msfs2020 || incoming.compatibility.msfs2020,
        msfs2024: current.compatibility.msfs2024 || incoming.compatibility.msfs2024,
      },
      verified: current.verified || incoming.verified,
      variants: mergeVariants(current.variants, incoming.variants),
    };
  };

  const byId = new Map<string, AircraftProfile>();
  for (const profile of profiles) {
    const canonicalId = canonicalizeId(profile.id);
    byId.set(canonicalId, mergeProfile(byId.get(canonicalId), profile));
  }
  for (const localProfile of LOCAL_AIRCRAFT_PROFILES) {
    const canonicalId = canonicalizeId(localProfile.id);
    byId.set(canonicalId, mergeProfile(byId.get(canonicalId), localProfile));
  }
  return [...byId.values()].sort((left, right) => right.coverage - left.coverage);
}
