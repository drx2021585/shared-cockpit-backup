import type { AircraftProfile } from "./apiClient";

const LOCAL_AIRCRAFT_PROFILES: AircraftProfile[] = [
  {
    id: "lvfr-a330-200",
    name: "LVFR A330-200",
    developer: "LatinVFR",
    version: "1.2.3",
    availability: "released",
    coverage: 32,
    capabilities: {
      flightControls: "none",
      autopilot: "partial",
      electrical: "partial",
      hydraulics: "none",
      radios: "none",
      mcdu: "none",
      failures: "none",
      air: "none",
      antiIce: "none",
      engine: "none",
      fuel: "partial",
      fireProtection: "none",
      instruments: "partial",
      warnings: "none",
      efb: "none",
      cabinMisc: "none",
    },
    compatibility: { msfs2020: true, msfs2024: false },
    verified: false,
    variants: ["LVFR A330-200GE", "LVFR A330-200PW", "LVFR A330-200RR"],
  },
  {
    id: "lvfr-a330-300",
    name: "LVFR A330-300",
    developer: "LatinVFR",
    version: "preview",
    availability: "soon",
    coverage: 0,
    capabilities: {
      flightControls: "none",
      autopilot: "none",
      electrical: "none",
      hydraulics: "none",
      radios: "none",
      mcdu: "none",
      failures: "none",
      air: "none",
      antiIce: "none",
      engine: "none",
      fuel: "none",
      fireProtection: "none",
      instruments: "none",
      warnings: "none",
      efb: "none",
      cabinMisc: "none",
    },
    compatibility: { msfs2020: false, msfs2024: false },
    verified: false,
    variants: ["LVFR A330-300"],
  },
];

export function mergeLocalAircraftProfiles(profiles: AircraftProfile[]): AircraftProfile[] {
  const byId = new Map<string, AircraftProfile>();
  for (const profile of profiles) {
    byId.set(profile.id, profile);
  }
  for (const localProfile of LOCAL_AIRCRAFT_PROFILES) {
    byId.set(localProfile.id, {
      ...byId.get(localProfile.id),
      ...localProfile,
    });
  }
  return [...byId.values()].sort((left, right) => right.coverage - left.coverage);
}
