import { useEffect, useState } from "react";

/**
 * Detecta la IP pública del jugador para mostrarla en la pantalla de sesión
 * (necesaria para conexión directa WebRTC / fallback). Réplica del comportamiento
 * del diseño original (fetch a ipify). Si falla, muestra "Unavailable" — nunca
 * bloquea la pantalla.
 */
export function usePublicIp() {
  const [ipv4, setIpv4] = useState("Detecting…");
  const [ipv6, setIpv6] = useState("Detecting…");

  useEffect(() => {
    fetch("https://api.ipify.org?format=json")
      .then((r) => r.json())
      .then((d) => setIpv4(d.ip))
      .catch(() => setIpv4("Unavailable"));

    fetch("https://api64.ipify.org?format=json")
      .then((r) => r.json())
      .then((d) => setIpv6(d.ip && d.ip.includes(":") ? d.ip : "Unavailable"))
      .catch(() => setIpv6("Unavailable"));
  }, []);

  return { ipv4, ipv6 };
}

export function generateSessionCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = (n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${rand(3)}-${rand(2)}9`;
}
