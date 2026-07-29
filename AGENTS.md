# Repository Guidelines

## Project Structure & Module Organization
This repository is split by runtime and responsibility:

- `apps/desktop-ui/`: React + Vite + Electron desktop client.
- `server/api/`: Express + WebSocket backend API.
- `packages/synchronization-core/`: shared synchronization logic and Node-based tests.
- `apps/simulator-bridge/`: .NET 8 Windows bridge for SimConnect/FSUIPC integration.
- `simulator/wasm-bridge/`: MSFS WASM bridge module.
- `aircraft-profiles/`: aircraft definitions, control mappings, screens, and capabilities in YAML.
- `tests/`: cross-cutting integration and profile validation tests.
- `tools/`: utility scripts such as profile generation and validation.
- `docs/`: plans, architecture notes, and design decisions.

## Build, Test, and Development Commands
- `cd apps/desktop-ui && npm install && npm run dev`: run the UI locally with Vite.
- `cd apps/desktop-ui && npm run build`: type-check and build the UI.
- `cd server/api && npm install && npm run dev`: start the backend with Node strip-types enabled.
- `cd server/api && npm test`: run API tests with `node:test`.
- `cd packages/synchronization-core && npm test`: run synchronization engine tests.
- `cd apps/simulator-bridge && dotnet test`: run bridge unit tests.
- `python tools/validate_profiles.py`: validate aircraft profile YAML files.

## Coding Style & Naming Conventions
Use 2-space indentation in TypeScript, JSON, and YAML. Follow existing C# conventions in `apps/simulator-bridge/`: `PascalCase` for types and methods, `camelCase` for locals and parameters. Keep filenames descriptive and aligned to domain terms, for example `authority.ts`, `BridgeService.cs`, or `flight-controls.yaml`. Prefer small modules and avoid mixing frontend, backend, and profile concerns in one change.

## Testing Guidelines
Add or update tests with every behavior change. TypeScript tests live beside their package in `test/` and typically use `*.test.ts`. C# tests live in `apps/simulator-bridge/tests/SimulatorBridge.Tests/` and use `*Tests.cs`. When editing YAML profiles, run `python tools/validate_profiles.py` before submitting.

## Commit & Pull Request Guidelines
Recent commits use concise, imperative Spanish messages such as `Arregla...`, `Agrega...`, or `Permite...`. Keep that style and scope each commit to one logical change. Pull requests should include a short description, affected areas, test evidence, and screenshots for UI changes. Link any related issue or planning document in `docs/` when relevant.

## Security & Configuration Tips
Do not commit secrets, simulator credentials, or local machine paths. Bridge and WASM work target Windows and MSFS-specific tooling; document environment assumptions in the PR when touching those areas.
