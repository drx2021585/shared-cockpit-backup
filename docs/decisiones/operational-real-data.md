# Decisión: eliminar todos los datos falsos/genéricos, hacer real cada área

## Contexto

Tras implementar el diseño WeConnect, todo era visualmente correcto pero
funcionalmente hueco: código de sesión generado localmente sin backend real,
ping fijo en "32ms", "All in sync" siempre en verde, cobertura de aeronaves
inventada (98%, 95%, 90% para aviones que ni siquiera tenían perfil YAML),
"Download for Windows" apuntando a un instalador que no existe.

## Qué se hizo real

1. **`packages/synchronization-core`** — motor de autoridad, anti-ciclo,
   anti-TOGGLE y detección de divergencia. 18 tests reales (`node:test`),
   verificados corriendo, no solo escritos.
2. **`server/api`** — backend real: Express + WebSocket + SQLite
   (`node:sqlite`, sin dependencias nativas problemáticas). El catálogo de
   aeronaves se calcula leyendo `aircraft-profiles/*/capabilities.yaml` en
   disco — la cobertura ya no es un número de diseño, es aritmética real
   sobre datos reales (Cessna 172 = 40%, no 98%).
3. **Frontend reconectado**: `apiClient.ts`, `useAircraftProfiles.ts`,
   `useSessionSocket.ts` reemplazan toda generación de datos en el cliente.
   `Party.tsx` crea sesiones reales contra el backend; `Join.tsx` se une a
   sesiones reales con manejo de errores reales (`session-not-found`,
   `invalid-password`, `session-full`); `Cockpit.tsx` mide el ping de verdad
   por WebSocket y muestra los participantes reales de la sesión.
4. **Código muerto eliminado**: `bridgeClient.ts`/`useBridge.ts` del diseño
   anterior (prometían `ws://localhost:7620` con fallback a mock) se
   borraron — no los usaba nadie y dejarlos habría sido una fuente de
   confusión futura sobre qué es real.
5. **`Download.tsx` ahora es honesto**: no hay instalador, el botón está
   deshabilitado y dice por qué, en vez de simular una descarga que no existe.

## Qué sigue sin poder verificarse aquí (y por qué)

`apps/simulator-bridge` (C#/SimConnect) y `simulator/wasm-bridge` (C++)
requieren Windows + el SDK de MSFS + el simulador abierto. Este entorno de
desarrollo es Linux sin `dotnet` instalado y sin acceso de red al SDK de
Microsoft. El código que se escriba ahí puede ser correcto, pero solo se
puede verificar ejecutándolo en la máquina Windows real del usuario — por
eso no se reporta como "operativo" aunque se escriba.

## Verificación end-to-end realizada

Smoke test completo en una sola sesión de shell: backend real arrancado,
build de producción del frontend servido con `vite preview`, sesión creada
vía API real, segundo piloto unido vía API real, estado verificado con GET,
y confirmación de que la cobertura de aeronaves viene de aritmética real
sobre `capabilities.yaml`, no de un valor fijo.
