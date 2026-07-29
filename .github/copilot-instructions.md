# Shared Cockpit repository instructions

## Build, test, and lint commands

This repo has **no root workspace/package.json**. Run commands from the package you are changing.

### Desktop UI (`apps/desktop-ui`)

```bash
cd apps/desktop-ui
npm install
npm run dev
npm run build
npm run dist
```

There is currently **no UI test script** and **no lint script** in this package.

### Backend API (`server/api`)

`server/api` requires a real `DATABASE_URL`; it does not fall back to SQLite or an in-memory mode at runtime.

```bash
cd server/api
npm install
npm run dev
npm test
```

Run a single backend test file:

```bash
cd server/api
node --experimental-strip-types --experimental-test-module-mocks --test test/authority.test.ts
```

### Synchronization engine (`packages/synchronization-core`)

```bash
cd packages/synchronization-core
npm test
```

Run a single sync-engine test file:

```bash
cd packages/synchronization-core
node --experimental-strip-types --test test/engine.test.ts
```

### Simulator bridge (`apps/simulator-bridge`)

```bash
cd apps/simulator-bridge
dotnet build SimulatorBridge.sln
dotnet test tests/SimulatorBridge.Tests/SimulatorBridge.Tests.csproj
```

Run a single .NET test:

```bash
cd apps/simulator-bridge
dotnet test tests/SimulatorBridge.Tests/SimulatorBridge.Tests.csproj --filter "FullyQualifiedName~ProfileMatcherTests.ExactSubstringMatch_PicksCorrectProfile"
```

### Cross-package tests in `tests/`

Run the integration relay test:

```bash
node --experimental-strip-types --experimental-test-module-mocks --test tests/integration/authority_relay.test.ts
```

Run the network loop-guard test:

```bash
node --experimental-strip-types --test tests/network/screen_snapshot_loop_guard.test.ts
```

Run profile validation and a single Python validator test:

```bash
python tools/validate_profiles.py
python -m unittest tests.profiles.test_anti_toggle_validator.AntiToggleValidatorTests.test_accepts_clientDataEvent_with_valid_descriptive_semantics
```

There is currently **no repository lint command** in package scripts or workflows. Do not invent one in changes or instructions.

## High-level architecture

Shared Cockpit is a multi-runtime monorepo. The core runtime flow is:

```text
MSFS <-> apps/simulator-bridge (local WS :7620) <-> apps/desktop-ui
     <-> server/api (HTTP + WS, shared Postgres) <-> other pilot
```

- `apps/desktop-ui` is the user-facing React + Vite app, packaged with Electron. It talks to two different backends:
  - `src/lib/bridgeClient.ts` connects to the **local** simulator bridge at `ws://localhost:7620`.
  - `src/lib/apiClient.ts` and `src/lib/useSessionSocket.ts` talk to the **shared** `server/api` over HTTP + WebSocket for sessions, participants, authority transfer, and peer relay.
- `apps/desktop-ui/electron/main.cjs` does **not** embed `server/api` anymore. It bundles and launches the local simulator bridge, exposes bridge auth to the renderer, and copies both `simulator/wasm-bridge/PackageSources` and `aircraft-profiles/` into packaged app resources.
- `server/api` is the authoritative multiplayer backend. On startup it scans `aircraft-profiles/`, computes aircraft coverage from real manifests/controls, and syncs that catalog into PostgreSQL. Session state, participants, passwords, participant tokens, and control ownership live here.
- `server/api/src/authority.ts` adapts `packages/synchronization-core` into the live relay path. Authority and loop prevention are kept **per session**, not globally.
- `packages/synchronization-core` is pure TypeScript logic with no I/O. It owns authority decisions, loop prevention, drift detection, and the incoming-message sync engine.
- `packages/protocol` and `packages/profile-schema` are shared contracts used across frontend, backend, bridge, profiles, and tests. Changes here have cross-runtime impact.
- `aircraft-profiles/*` are not just content files: they drive backend aircraft catalog data, bridge matching/mappings, authority enforcement, and profile validation.

## Key conventions

- **Read `docs/plan-maestro.md` first** to understand the current phase/sprint before making architectural changes.
- **Do not casually edit `packages/protocol/` or `packages/profile-schema/`.** They are shared contracts; changes ripple into multiple runtimes and should be coordinated.
- **Boolean synchronized controls must never use raw TOGGLE semantics.** Use explicit set semantics (`SET_ON`/`SET_OFF`/`SET_VALUE`) or a documented deterministic event with non-trivial `semantics`. This is enforced both by `tools/validate_profiles.py` and runtime loop/validation logic.
- **Network-originated flight messages must be treated as `origin: "remote"` and never rebroadcast as local changes.** This rule exists in `LoopGuard`, `SyncEngine`, the server relay path, and the desktop UI echo-suppression logic in `src/views/Cockpit.tsx`.
- **Authority is seat-based, not pilot-name-based.** `controlOwner`, `controlRequestedBy`, and authority transfer payloads use `"captain"` / `"first_officer"` seats. The current transferable exclusive group is `"flight_controls"`.
- **This repo runs TypeScript directly with `node --experimental-strip-types`.** Because there is no root workspace linking packages together, cross-package imports often point directly at `.../src/*.ts` files instead of built artifacts.
- **`server/api` runtime uses real Postgres only.** Tests fake `pg` with `node:test` module mocking; production code should not add silent fallbacks to local storage.
- **Real mode should fail honestly instead of showing fake data.** The desktop UI has an explicit bridge `mock` mode, but "real" mode is expected to surface missing bridge/server connectivity instead of fabricating session or telemetry state.
- **Aircraft profile YAML files use explicit schema conventions.** `controls/*.yaml` and `screens/*.yaml` are lists, not single objects. `readOnly` and `writeOnly` are explicit schema states, not inferred defaults.

## Relevant MCP server

- **Playwright MCP is the most relevant MCP server for this repo.** Use it against the Vite/React renderer in `apps/desktop-ui`, especially flows in `src/views/Home.tsx`, `Join.tsx`, `Party.tsx`, `Aircraft.tsx`, `Profile.tsx`, and `Cockpit.tsx`.
- Best-fit checks are renderer-level session flows, API error states, join/create-party UX, and visual regressions in the web UI.
- For cockpit UI work, prefer browser runs that keep the simulator side mocked or explicit (`VITE_BRIDGE_MODE=mock` when appropriate). Do not treat Playwright as a replacement for `apps/simulator-bridge`, SimConnect verification, or backend/session authority tests.
