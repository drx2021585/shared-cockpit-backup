import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Content-Security-Policy del build de producción (la que carga Electron
// empaquetado). Solo se inyecta en `vite build`: en dev, @vitejs/plugin-react
// necesita un script inline (preamble de react-refresh) que una CSP estricta
// rompería, y el riesgo que mitiga la CSP (inyección de script remoto) no
// aplica al dev server local.
//
// connect-src: solo el server/api desplegado y el bridge local de SimConnect.
// Los esquemas http:/ws: abiertos que necesitaba el host directo se pudieron
// quitar al eliminar ese modo: ya no hay que alcanzar IPs arbitrarias.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' solo para estilos: React usa atributos style= inline por
  // toda la UI; no habilita ejecución de script.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://shared-cockpit-api.onrender.com wss://shared-cockpit-api.onrender.com " +
    "ws://localhost:17481 ws://127.0.0.1:17481",
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
    open: true,
  },
});
