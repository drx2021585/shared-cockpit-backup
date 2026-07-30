import { useEffect, useState } from "react";

/**
 * En desktop muestra las direcciones REALES de la máquina vía Electron
 * (os.networkInterfaces en main.cjs). Solo en build web puro hace fallback a
 * ipify para no romper la vista fuera de Electron.
 */
export function usePublicIp() {
  const [ipv4, setIpv4] = useState("Detecting…");
  const [ipv6, setIpv6] = useState("Detecting…");

  useEffect(() => {
    const localNetwork = window.weconnectNetwork;
    if (localNetwork) {
      localNetwork.getLocalAddresses()
        .then((info) => {
          setIpv4(info.ipv4 ?? "Unavailable");
          setIpv6(info.ipv6 ?? "Unavailable");
        })
        .catch(() => {
          setIpv4("Unavailable");
          setIpv6("Unavailable");
        });
      return;
    }

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
