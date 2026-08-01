/**
 * Dónde vive el servidor de sesiones. Antes esto era una eleccion del usuario
 * (relay propio / LAN / host directo con UPnP); todo eso se elimino: la unica
 * forma de conectarse es el codigo de 6 caracteres contra el backend
 * compartido, que es la que funciona en cualquier red — incluidas las moviles
 * con CGNAT y NAT simetrico, donde la conexion directa es inalcanzable por
 * definicion (ver docs/plan-direct-p2p-rendezvous.md para la medicion).
 *
 * Para desarrollo local se sobreescribe con VITE_API_BASE en un .env.local.
 */
const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE ?? "https://shared-cockpit-api.onrender.com";

export function getRelayApiBaseUrl() {
  return DEFAULT_API_BASE;
}

export function getDefaultRelayApiBaseUrl() {
  return DEFAULT_API_BASE;
}
