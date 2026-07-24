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
