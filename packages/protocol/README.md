# @shared-cockpit/protocol

Contrato de mensajes usado por TODOS los agentes/apps del proyecto. Cambiar la forma
de un mensaje aquí requiere aprobación del orquestador porque rompe a:
simconnect-bridge-agent, wasm-agent, sync-engine-agent, networking-agent, frontend-agent.

## Mensajes

| type | canal | frecuencia | descripción |
|---|---|---|---|
| `control.event` | confiable | on-change | interruptor/valor discreto (SET_ON/SET_OFF/SET_VALUE, nunca TOGGLE) |
| `control.axis` | rápido | 20-60Hz | eje continuo (yoke, rudder, throttle, spoilers) |
| `aircraft.snapshot` | confiable | baja frecuencia / on-demand | estado persistente completo por sistema |
| `authority.transfer` | confiable | on-demand | cambio de dueño de un grupo de controles |
| `session.*` | confiable | on-demand | ciclo de vida de sesión (join, leave, roles) |
| `screen.snapshot` | confiable | baja frecuencia / on-demand (on-change) | contenido completo de una pantalla de solo lectura de un addon de terceros (ej. CDU/MCDU del PMDG NG3 SDK vía Client Data Area `PMDG_NG3_CDU_0`/`PMDG_NG3_CDU_1`); grilla de celdas carácter+color+flags, **estrictamente solo lectura** en esta versión (sin escritura de botones, ver `docs/plan-737-fullsync-2026-07-25.md`) |

Ver `messages.schema.json` para el esquema formal (JSON Schema, agnóstico de lenguaje)
y `types.ts` para los tipos TypeScript generados a mano a partir del schema.

## Regla de oro anti-ciclos

Todo mensaje recibido de la red se marca internamente como `origin: "remote"` antes de
aplicarse. El motor de sincronización JAMÁS reenvía un cambio marcado como remoto como
si fuera un cambio local nuevo. Ver `sync-engine-agent.md`.

## Regla de oro anti-toggle

`control.event` para interruptores SIEMPRE usa `value: true|false` explícito
(equivalente a SET_ON/SET_OFF), nunca un pulso de tipo TOGGLE. Esto evita que dos
jugadores que cambian el mismo interruptor casi simultáneamente terminen con estados
invertidos entre sí.

## `screen.snapshot` — pantallas de solo lectura (ej. CDU/MCDU)

Algunos addons de terceros (confirmado: PMDG NG3, `apps/desktop-ui/Documentation/SDK/PMDG_NG3_SDK.h`)
exponen una pantalla completa como una grilla de celdas (carácter + color + flags) en vez
de un valor escalar — no encaja en `control.event` (no es un valor discreto simple) ni en
`control.axis` (no es un eje continuo de alta frecuencia). `screen.snapshot` cubre este caso:

- Canal confiable, se envía on-demand o cuando la pantalla cambia (el CDU del PMDG NG3
  no refresca a 20-60Hz como un eje; refrescar solo on-change es suficiente y barato).
- `screenId` identifica la pantalla (ej. `cdu_captain`/`cdu_fo`, mapeadas 1:1 a
  `PMDG_NG3_CDU_0`/`PMDG_NG3_CDU_1`), `rows`/`cols` declaran la dimensión real de la
  grilla (14x24 confirmado para el CDU del PMDG NG3 leyendo `CDU_ROWS`/`CDU_COLUMNS` del
  header), `cells` es un arreglo row-major de `{ char, colorId (0-5), flags (bitmask) }`
  que espeja `PMDG_NG3_CDU_Cell` (`Symbol`/`Color`/`Flags`), y `powered` espeja
  `PMDG_NG3_CDU_Screen.Powered`.
- **Estrictamente solo lectura en esta versión.** No representa botones/escritura del
  CDU — ver `packages/profile-schema/screen.schema.json` (`readOnly: true` obligatorio)
  y `docs/plan-737-fullsync-2026-07-25.md` para la justificación (eventos de botón del
  CDU no completamente documentados por PMDG/la comunidad; alto riesgo de romper el FMC
  en vuelo si se escribe sin Event IDs confirmados).
- `revision` funciona igual que en `aircraft.snapshot`: se incrementa en cada envío para
  que el receptor descarte snapshots viejos/fuera de orden.
