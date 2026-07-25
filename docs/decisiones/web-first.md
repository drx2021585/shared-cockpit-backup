# Decisión: construir la UI web-first, empaquetar como app de escritorio después

## Contexto

El plan original proponía React + TypeScript + Tauri desde el día 1. Se decidió
posponer Tauri.

## Decisión

1. `apps/desktop-ui` se construye como una web app pura: **Vite + React + TypeScript**,
   corriendo en `npm run dev` como cualquier sitio web, sin dependencias de Tauri.
2. El cliente habla con `apps/simulator-bridge` (C#/SimConnect) por WebSocket local
   (`ws://localhost:7620`), exactamente el mismo protocolo que usaría empacado en
   Tauri. Un navegador normal SÍ puede abrir un WebSocket a `localhost` sin
   restricciones especiales (no confundir con llamadas HTTPS a orígenes externos).
3. Mientras el bridge real no esté disponible (fuera de Windows/MSFS), la app corre
   contra un **mock del bridge** (`src/lib/bridgeClient.ts`, modo `mock`) para poder
   diseñar y probar todas las pantallas sin depender del simulador.
4. Cuando el producto esté funcionalmente completo (pantallas + lógica + conexión
   real al bridge validada), se envuelve con **Tauri** para producir el instalable
   de escritorio. Ese paso es mecánico: Tauri sirve el mismo build de Vite dentro de
   un webview nativo — no debería requerir rediseñar pantallas.

## Por qué no Electron en su lugar

Tauri sigue siendo la opción por defecto (binarios más livianos, menor superficie de
ataque) — la decisión web-first no cambia esa preferencia, solo pospone cuándo se
integra. Se reevaluará Electron únicamente si Tauri presenta una limitación bloqueante
al momento de empacar.

## Qué NO hacer mientras tanto

- No importar `@tauri-apps/api` ni ningún módulo exclusivo de Tauri todavía.
- No asumir acceso a filesystem nativo, notificaciones nativas, etc. — si una
  pantalla lo necesita, usar un stub web-safe y dejar un TODO.

## Actualización 2026-07-24: empaquetado adelantado con Electron

A pedido explícito de Darwin se generó un `.exe` de Windows antes de que el
bridge esté validado (fuera del orden que describe este documento), usando
**Electron + electron-builder** en vez de Tauri — no por una limitación de
Tauri, sino porque Rust/MSVC Build Tools no estaban instalados y Electron no
los requiere para empaquetar una app sin módulos nativos. Ver
`apps/desktop-ui/electron/main.cjs` y el campo `build` en
`apps/desktop-ui/package.json` (`npm run dist` / `npm run dist:publish`).

Esto es una excepción puntual, no un cambio de la decisión de arriba: Tauri
sigue siendo la opción por defecto para el empaquetado real cuando el
producto esté funcionalmente completo. Si se necesita seguir iterando el
`.exe` antes de eso, evaluar si conviene formalizar el cambio a Electron o
volver a Tauri en ese momento.

### Actualización 2026-07-25: el `.exe` habla con el backend compartido en Railway, no con un server local embebido

Se probó embeber `server/api` (Node portátil + código + `aircraft-profiles/`
como `extraResources`) para que el `.exe` no dependiera de Node/npm
instalados. Funcionaba, pero no resolvía el problema real: dos pilotos en
computadoras distintas no pueden verse si cada uno levanta su *propio*
server/api local — el relay de WebSocket solo conecta sockets dentro del
mismo proceso, y cada instancia local tenía su propia base de datos aislada.

Se revirtió ese embebido (`electron/main.cjs` volvió a ser solo el visor de
la ventana) y en su lugar `server/api` se desplegó como **una única
instancia compartida** en Railway, con **Postgres/Supabase** como base de
datos (ver `docs/decisiones/postgres-shared-backend.md`). El cliente
(`apps/desktop-ui/src/lib/apiClient.ts`) apunta por defecto a esa URL
pública en vez de `localhost:8787`; para desarrollo/pruebas solo-locales se
puede sobreescribir con `VITE_API_BASE=http://localhost:8787` en un
`.env.local` (gitignored) y correr `server/api` a mano contra Postgres o,
si hace falta trabajar sin red, adaptarlo de nuevo a un modo local — no es
el caso de uso principal hoy.

Esto simplifica el `.exe` (ya no necesita `vendor/node/node.exe` ni copiar
`server/api`/`aircraft-profiles` al paquete) y elimina la demora de ~30s del
primer arranque por escaneo de Windows Defender sobre un binario de Node sin
firmar.
