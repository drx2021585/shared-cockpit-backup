# Shared Cockpit

App de cabina compartida para Microsoft Flight Simulator 2020/2024. Ver el plan
completo en `docs/plan-maestro.md`.

## Estado actual — qué es real y qué no

Esta sección distingue tres niveles honestamente, no todo lo que existe está
verificado igual:

**✅ Real y verificado en este entorno** (corrí los comandos, no solo escribí el código):

- `packages/synchronization-core` — motor de autoridad, anti-ciclo, anti-TOGGLE
  y detección de divergencia. **18/18 tests pasan** (`npm test`, usa `node:test`).
- `server/api` — backend real: Express + WebSocket + SQLite (`node:sqlite`).
  Probado end-to-end con curl y un cliente WebSocket real: crear sesión, unirse,
  cambio de estado `waiting→active`, ping/pong medido. El catálogo de aeronaves
  se calcula leyendo `aircraft-profiles/*/capabilities.yaml` — el Cessna 172 da
  **40%** real (no el 98% inventado del diseño original).
- `apps/desktop-ui` — conectado al backend real vía `apiClient.ts` y
  `useSessionSocket.ts`. Sin datos de relleno: si el servidor no corre, la UI
  muestra el error real, no rellena con ejemplos. `tsc -b` y `vite build`
  pasan limpios. Probé el frontend compilado sirviendo contra el backend real
  en un smoke test conjunto.
- `tools/validate_profiles.py` — valida perfiles YAML contra el esquema y la
  regla anti-TOGGLE.

**⏳ No iniciado** (auditoría 2026-07-20 — confirmado con `find -type f`, cero
archivos, no es un problema de entorno):

- `apps/simulator-bridge` (C#/SimConnect), `simulator/wasm-bridge` (C++),
  `packages/shared-types`, `packages/aircraft-model`, `apps/desktop-shell`,
  `apps/profile-editor`, `apps/updater`, `server/realtime`, `server/signaling`,
  `server/telemetry`, `server/profile-registry`, `simulator/packages`,
  `simulator/simconnect` — estas 13 carpetas existen en la estructura del
  repo pero no contienen ningún archivo. Corregido: la versión anterior de
  este README decía que `apps/simulator-bridge` estaba "construido pero no
  verificable en este sandbox", lo cual era engañoso — no hay código
  esperando compilar, simplemente no se ha escrito todavía. Requerirán
  Windows, el SDK de MSFS y (para el bridge) el .NET 8 SDK para desarrollarse.
- `tests/` (dueño: qa-agent) también está completamente vacía: sin tests de
  integración, red, perfiles ni simulador — solo existen tests unitarios
  dentro de `packages/synchronization-core`.
- `server/api` no tiene ninguna carpeta de tests automatizados (`npm test`
  corre pero no encuentra archivos que ejecutar).

**❌ No construido todavía**:

- Empaquetado Tauri para escritorio (ver `docs/decisiones/web-first.md`).
- WebRTC directo entre jugadores (hoy la señalización es WebSocket simple al
  servidor central, sin P2P ni relay TURN).
- Telemetría real de la aeronave en el frontend (`Cockpit.tsx` lo dice
  explícitamente: aparecerá cuando el bridge de SimConnect exista).

### Correr el stack completo de verdad

```bash
# Terminal 1 — backend real
cd server/api && npm install && npm run dev

# Terminal 2 — frontend real, conectado al backend de arriba
cd apps/desktop-ui && npm install && npm run dev

# Terminal 3 (opcional) — tests del motor de sincronización
cd packages/synchronization-core && npm test
```

## Cómo trabajar con los subagentes (Claude Code)

Este repo incluye 8 subagentes en `.claude/agents/`, cada uno con propiedad exclusiva
de una carpeta (ver tabla en `.claude/agents/orchestrator.md`):

| Agente | Carpeta | Sprint de arranque |
|---|---|---|
| orchestrator | `packages/protocol`, `packages/shared-types` | siempre activo |
| simconnect-bridge-agent | `apps/simulator-bridge` | 1 |
| wasm-agent | `simulator/wasm-bridge` | 1 |
| sync-engine-agent | `packages/synchronization-core` | 2 |
| networking-agent | `server/` | 3 |
| aircraft-profiles-agent | `aircraft-profiles/`, `packages/profile-schema` | 1 y 4 |
| frontend-agent | `apps/desktop-ui` | 4-5 |
| qa-agent | `tests/` | fin de cada sprint |

Invócalos con `@nombre-del-agente` dentro de una sesión de Claude Code apuntando a
este repo. El orquestador se invoca primero en cada sprint para planificar.

## Validar perfiles de aeronave

```bash
pip install pyyaml jsonschema --break-system-packages
python3 tools/validate_profiles.py
```

## Requisitos para desarrollo real (Windows)

Ver sección 14 del plan maestro: SDK de MSFS, Visual Studio 2022, .NET 8 SDK,
Node.js LTS, Rust + Tauri CLI, Docker Desktop, PostgreSQL, Redis. La compilación y
prueba de `apps/simulator-bridge` y `simulator/wasm-bridge` requiere MSFS abierto.
