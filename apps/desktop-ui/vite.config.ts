import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Content-Security-Policy del build de producción (la que carga Electron
// empaquetado). Solo se inyecta en `vite build`: en dev, @vitejs/plugin-react
// necesita un script inline (preamble de react-refresh) que una CSP estricta
// rompería, y el riesgo que mitiga la CSP (inyección de script remoto) no
// aplica al dev server local.
//
// connect-src enumera los destinos de red legítimos de la app:
// - server/api desplegado (Render) por https/wss,
// - server/api local (npm run dev, puerto 8787) para desarrollo,
// - el bridge local de SimConnect en ws://localhost:7620,
// - el direct host: `http:`/`ws:` sin host fijo.
//
// Por qué `http:`/`ws:` abiertos y no una lista: en modo direct host el relay
// vive en la PC de un jugador y se alcanza por 127.0.0.1 (anfitrión) o por la
// IP LAN/pública del anfitrión (invitado, ver views/Join.tsx). Esas IPs y
// puertos son arbitrarios y la CSP no admite comodines dentro de un host
// (`http://192.168.*.*` es inválido), así que enumerarlos es imposible.
// Antes solo estaba `http://localhost:8787` y el direct host, que se anuncia
// como `http://127.0.0.1:8787`, quedaba bloqueado -> "Failed to fetch" al
// crear la party. El riesgo que la CSP sigue cubriendo (ejecución de script
// remoto) queda intacto: script-src/default-src siguen en 'self'.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' solo para estilos: React usa atributos style= inline por
  // toda la UI; no habilita ejecución de script.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://shared-cockpit-api.onrender.com wss://shared-cockpit-api.onrender.com " +
    "http://localhost:8787 ws://localhost:8787 ws://localhost:7620 ws://127.0.0.1:7620 " +
    "http: ws:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'none'",
].join("; ");

function injectCsp(): Plugin {
  return {
    name: "inject-csp",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), injectCsp()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
