import type { AircraftProfile } from "./apiClient";

const LOCAL_AIRCRAFT_PROFILES: AircraftProfile[] = [];

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
