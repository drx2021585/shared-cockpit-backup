import { useEffect, useState } from "react";
import { fetchAircraftProfiles, type AircraftProfile } from "./apiClient";

export interface AircraftProfilesState {
  profiles: AircraftProfile[];
  loading: boolean;
  error: string | null;
}

/**
 * Trae el catálogo real de aeronaves desde server/api, que a su vez lo lee
 * de aircraft-profiles (manifest.yaml y capabilities.yaml de cada subcarpeta)
 * en disco. Si el backend no está corriendo, se refleja el error real — no
 * se rellena con datos de ejemplo.
 */
export function useAircraftProfiles(): AircraftProfilesState {
  const [state, setState] = useState<AircraftProfilesState>({
    profiles: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetchAircraftProfiles()
      .then((profiles) => {
        if (!cancelled) setState({ profiles, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            profiles: [],
            loading: false,
            error: "No se pudo conectar con el servidor. ¿Está corriendo `npm run dev` en server/api?",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
