import { useEffect, useState } from "react";
import { fetchAircraftProfiles, type AircraftProfile } from "./apiClient";
import { mergeLocalAircraftProfiles } from "./localAircraftProfiles";

export interface AircraftProfilesState {
  profiles: AircraftProfile[];
  loading: boolean;
  error: string | null;
}

const AIRCRAFT_PROFILES_STORAGE_KEY = "weconnect.aircraftProfiles";

let cachedProfiles: AircraftProfile[] | null = null;
let inFlightProfilesRequest: Promise<AircraftProfile[]> | null = null;

function readStoredProfiles(): AircraftProfile[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AIRCRAFT_PROFILES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? mergeLocalAircraftProfiles(parsed as AircraftProfile[]) : null;
  } catch {
    return null;
  }
}

function storeProfiles(profiles: AircraftProfile[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    AIRCRAFT_PROFILES_STORAGE_KEY,
    JSON.stringify(mergeLocalAircraftProfiles(profiles))
  );
}

function getCachedProfiles(): AircraftProfile[] {
  if (cachedProfiles) return cachedProfiles;
  const storedProfiles = readStoredProfiles();
  if (storedProfiles) {
    cachedProfiles = storedProfiles;
    return storedProfiles;
  }
  return [];
}

function loadAircraftProfiles() {
  if (!inFlightProfilesRequest) {
    inFlightProfilesRequest = fetchAircraftProfiles()
      .then((profiles) => {
        const mergedProfiles = mergeLocalAircraftProfiles(profiles);
        cachedProfiles = mergedProfiles;
        storeProfiles(mergedProfiles);
        return mergedProfiles;
      })
      .finally(() => {
        inFlightProfilesRequest = null;
      });
  }
  return inFlightProfilesRequest;
}

/**
 * Dispara el fetch del catálogo apenas abre la app, sin esperar a que el
 * usuario entre a Aircraft/Party. server/api corre en el plan free de Render
 * (ver render.yaml), que duerme el proceso tras ~15 min sin tráfico: el
 * primer request del día paga 30-60s de arranque en frío. Adelantarlo al
 * arranque hace que ese costo lo pague la pantalla de Home en segundo plano
 * y no una vista con spinner delante del usuario.
 */
export function prefetchAircraftProfiles() {
  loadAircraftProfiles().catch(() => {
    // El error real se muestra en la vista que consuma el hook; aquí solo
    // estamos calentando el servidor, no hay UI que avisar.
  });
}

export function invalidateAircraftProfilesCache() {
  cachedProfiles = null;
  inFlightProfilesRequest = null;
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(AIRCRAFT_PROFILES_STORAGE_KEY);
  }
}

/**
 * Trae el catálogo real de aeronaves desde server/api, que a su vez lo lee
 * de aircraft-profiles (el bloque `capabilities` de manifest.yaml de cada
 * subcarpeta, ver server/api/src/profiles.ts — capabilities.yaml NO se lee
 * todavía, solo es documentación expandida para humanos/QA) en disco. Si el
 * backend no está corriendo, se refleja el error real — no se rellena con
 * datos de ejemplo.
 */
export function useAircraftProfiles(): AircraftProfilesState {
  const initialProfiles = getCachedProfiles();
  const [state, setState] = useState<AircraftProfilesState>({
    profiles: initialProfiles,
    loading: initialProfiles.length === 0,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    loadAircraftProfiles()
      .then((profiles) => {
        if (!cancelled) setState({ profiles, loading: false, error: null });
      })
      .catch(() => {
        if (!cancelled) {
          const fallbackProfiles = mergeLocalAircraftProfiles([]);
          setState({
            profiles: fallbackProfiles,
            loading: false,
            error: fallbackProfiles.length > 0
              ? null
              : "No se pudo cargar el catálogo de aeronaves desde el relay actual.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
