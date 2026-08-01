import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Content-Security-Policy del build de producción (la que carga Electron
// empaquetado). Solo se inyecta en `vite build`: en dev, @vitejs/plugin-react
// necesita un script inline (preamble de react-refresh) que una CSP estricta
// rompería, y el riesgo que mitiga la CSP (inyección de script remoto) no
// aplica al dev server local.
//
// connect-src: el server/api desplegado, más `http:`/`ws:` abiertos para el
// direct host y el bridge local. La IP y el puerto del anfitrión son
// arbitrarios y la CSP no admite comodines dentro de un host, así que
// enumerarlos es imposible. script-src/default-src siguen en 'self'.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' solo para estilos: React usa atributos style= inline por
  // toda la UI; no habilita ejecución de script.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://shared-cockpit-api.onrender.com wss://shared-cockpit-api.onrender.com http: ws:",
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
