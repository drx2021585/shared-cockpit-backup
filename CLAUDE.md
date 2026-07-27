# Instrucciones para Claude Code en este repo

Este es el repo de **Shared Cockpit**. Antes de tocar código:

1. Lee `docs/plan-maestro.md` para saber en qué fase/sprint está el proyecto.
2. Si tu tarea cae dentro de la carpeta de un subagente (ver tabla en README.md),
   invoca ese subagente en vez de editar directamente tú mismo.
3. Nunca modifiques `packages/protocol/` o `packages/profile-schema/` sin pasar por
   el `orchestrator` — son contratos compartidos por múltiples agentes.
4. Antes de agregar un control sincronizable a un perfil de aeronave, corre
   `python3 tools/validate_profiles.py` para confirmar que pasa el esquema y la
   regla anti-TOGGLE.
5. Reglas técnicas no negociables (repetidas aquí porque son fáciles de romper por
   accidente):
   - Interruptores: SET_ON/SET_OFF/SET_VALUE explícito, nunca TOGGLE crudo.
   - Todo mensaje recibido de red se marca `origin: remote` y nunca se reenvía como
     si fuera un cambio local.
   - Canal confiable (interruptores, snapshots, roles) vs canal rápido (ejes
     continuos) — ver `packages/protocol/README.md`.

## Arquitectura (actualizado 2026-07-25 vía /init)

Monorepo sin herramienta de workspace única (no hay `package.json` raíz); cada
pieza se instala/corre por separado. Flujo de datos end-to-end:

```
MSFS + PMDG 737 ⇄ apps/simulator-bridge (C#/.NET 8, SimConnect)
        ⇄ WebSocket local ⇄ apps/desktop-ui (Electron + React/Vite)
        ⇄ server/api (Express + WS + Postgres) ⇄ otro jugador
```

- `packages/synchronization-core` (TS): motor de autoridad, anti-ciclo,
  anti-TOGGLE, divergencia. Es el corazón puro (sin IO) del que dependen
  `apps/desktop-ui` y `apps/simulator-bridge` conceptualmente — cualquier
  aeronave nueva (incluido el 737) pasa por esta lógica sin cambios.
- `packages/protocol` (contrato): `messages.schema.json` + `types.ts` a mano;
  tipos de mensaje: `control.event` (confiable), `control.axis` (rápido,
  20-60Hz), `aircraft.snapshot`, `authority.transfer`, `session.*`.
- `packages/profile-schema` + `aircraft-profiles/<id>/manifest.yaml`: define
  qué controles existen por aeronave y su `capabilities` (none/partial/full
  por sistema). `tools/validate_profiles.py` valida esquema + regla anti-TOGGLE.
- `apps/simulator-bridge` (C#/.NET 8): único punto que habla SimConnect de
  verdad. `Bridge/BridgeService.cs` orquesta; `SimConnectInterop/` es el P/Invoke
  nativo; `Protocol/Messages.cs` espeja `packages/protocol`; `Profiles/` carga
  y matchea `aircraft-profiles/*/manifest.yaml` contra el título ATC del avión
  cargado; `Ws/BridgeWebSocketServer.cs` expone todo por WebSocket local al
  frontend. Hoy usa SimConnect estándar (simvars/eventos `K:`); NO usa todavía
  la Client Data Area / SDK oficial de PMDG.
- `server/api` (Express + `ws` + Postgres, deploy en Railway): sesiones,
  join codes, catálogo de aeronaves (calculado leyendo `capabilities` de los
  manifests reales, no inventado), señalización básica entre jugadores (hoy
  WebSocket simple, sin WebRTC/TURN directo todavía).
- `apps/desktop-ui` (React + TS + Vite, empacado con Electron vía
  `electron-builder`): UI web-first. `lib/apiClient.ts` habla con `server/api`,
  `lib/bridgeClient.ts`/`lib/useSessionSocket.ts` hablan con el bridge local y
  con la sesión remota. `electron/main.cjs`/`preload.cjs` embeben `server/api`
  y agregan auto-actualización (`electron-updater`).
- `tests/` (qa-agent): `tests/network/*.test.ts` son tests de integración que
  importan (solo lectura) de `packages/synchronization-core` para verificar
  invariantes cross-paquete (p.ej. que mensajes nuevos como `screen.snapshot`
  respeten la regla `origin: remote`) sin que ese paquete lo sepa de antemano;
  `tests/profiles/*.py` son tests pytest sobre los validadores de
  `tools/validate_profiles.py`. `tests/integration/` y `tests/simulator/`
  existen como carpetas pero están vacías todavía.
- `simulator/wasm-bridge` (C/C++, planeado) sigue sin código — ver huecos
  reales más abajo.

### Comandos comunes

```bash
# Backend (Express + WS + Postgres)
cd server/api && npm install && npm run dev        # requiere DATABASE_URL (Postgres/Railway)
npm test                                            # node --test, hoy sin archivos test/*.test.ts

# Frontend (Electron + React + Vite)
cd apps/desktop-ui && npm install && npm run dev    # vite dev server
npm run build                                       # tsc -b && vite build
npm run dist                                        # empaqueta .exe (electron-builder)

# Motor de sincronización
cd packages/synchronization-core && npm test        # node --test, 18/18 tests (test/*.test.ts)

# Bridge SimConnect (requiere Windows + MSFS abierto + .NET 8 SDK)
cd apps/simulator-bridge && dotnet build SimulatorBridge.sln
dotnet test tests/SimulatorBridge.Tests           # xUnit

# Validación de perfiles de aeronave
python3 tools/validate_profiles.py                 # requiere pyyaml, jsonschema

# Tests de integración cross-paquete (qa-agent) y de validadores de perfiles
node --experimental-strip-types --test tests/network/*.test.ts
pytest tests/profiles/                              # requiere pyyaml, jsonschema
```

### Huecos reales conocidos (no asumir que existen)

- `simulator/wasm-bridge`, `apps/desktop-shell`, `apps/profile-editor`,
  `apps/updater`, `server/realtime`, `server/signaling`, `server/telemetry`,
  `server/profile-registry`: sin código todavía. `tests/` sí tiene código real
  (ver arriba), pero `tests/integration/` y `tests/simulator/` están vacías.
- WebRTC P2P directo entre jugadores: no implementado (hoy la señalización es
  WebSocket simple al servidor central).
- `aircraft-profiles/pmdg-737-900/manifest.yaml`: capabilities en
  partial/none — usa solo SimConnect estándar, no la Client Data Area /
  SDK oficial de PMDG (ver `docs/plan-737-fullsync-*.md` para el estado más
  reciente de esa integración).
