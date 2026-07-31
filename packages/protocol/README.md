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
| `flight.pose` | rápido | 8-15Hz | pose física autoritativa de la aeronave, con corrección suave en el receptor |
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

## `flight.pose` — posicionamiento físico autoritativo

`flight.pose` existe para la parte de física/pose que no cabe en `control.axis` ni en
`aircraft.snapshot`:

- `aircraft.snapshot` sigue reservado a **sistemas persistentes** de cabina.
- `flight.pose` solo describe **lat/lon/alt + actitud + velocidades**, y solo debe
  ser emitido por el asiento que hoy posee `flight_controls`.
- El receptor no debe aplicar cada muestra como snap inmediato. La arquitectura
  esperada es: buffer de objetivo remoto + corrección gradual + snap solo para
  errores grandes o resincronización inicial.

Este mensaje existe para que la posición del avión sea una señal explícita del
protocolo, no un side-effect implícito de otra sincronización.

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

## MVP de autoridad: grupo único `flight_controls` (decisión orquestador, 2026-07-27)

Para esta fase del roadmap, `AuthorityManager` (`packages/synchronization-core`)
corre embebido en `server/api` (no en cada cliente) y expone **un único grupo
válido de `AuthorityTransfer.group` en el MVP: `"flight_controls"`**. Este es el
único valor que `networking-agent` debe aceptar/emitir en `group` por ahora.

### 1. Qué cubre `flight_controls`

Los 6 controles `authority: exclusive` que existen hoy en los manifests reales
(`tools/validate_profiles.py` ya obliga a que todo `exclusive` sea polled/eje
continuo, nunca un switch discreto):

| Perfil | Controles `exclusive` |
|---|---|
| `pmdg-737-900` | `flight.yoke.pitch`, `flight.yoke.roll`, `flight.rudder` |
| `cessna-172` | `flight.yoke.pitch`, `flight.yoke.roll`, `flight.rudder` |

No existe hoy ningún control `exclusive` fuera de este set. Mientras eso sea
cierto, un solo grupo alcanza y evita inventar un mecanismo de agrupación que
todavía no hace falta (ver punto 5, deuda documentada).

### 2. Cómo se siembra el dueño inicial del grupo — SIN mensaje WS nuevo

`server/api` ya persiste el dueño de los controles por sesión en
`sessions.control_owner` (Postgres, ver `server/api/src/db.ts`) y ya lo difunde
por WebSocket en un mensaje `{ type: "session.state", session }` cada vez que
alguien se conecta o cambia el estado de la sesión
(`server/api/src/server.ts`, función `broadcastSessionState`; el cliente lo
consume en `apps/desktop-ui/src/lib/useSessionSocket.ts:126` y expone
`session.controlOwner`/`session.controlRevision` vía
`apps/desktop-ui/src/lib/apiClient.ts`).

**Decisión: no se agrega ningún mensaje nuevo tipo "estado inicial de
autoridad".** El seeding del `AuthorityManager` en memoria es un detalle interno
del proceso `server/api`, no algo que viaje por la red:

- Al crear o al reconectar una sesión, `server/api` debe llamar
  `authorityManager.registerGroup("flight_controls", session.control_owner)`
  (con `initialOwner = session.control_owner`, que **nunca es `null`** porque
  `db.ts` ya garantiza que toda sesión arranca con un `control_owner` sembrado
  al seat del creador — ver comentario en `init()`/`db.ts:107`).
- El mensaje `session.state` que YA se difunde por WS sigue siendo, desde el
  punto de vista del protocolo de red, la única fuente que un cliente nuevo (o
  que se reconecta) necesita para saber quién tiene los controles ahora mismo
  (`session.controlOwner`). Un `authority.transfer` real solo se emite cuando
  la autoridad efectivamente CAMBIA (`give-controls` exitoso, ver
  `broadcastAuthorityTransfer` en `server.ts`), no como confirmación de estado
  inicial — eso ya lo cubre `session.state`.
- Nota de alcance del contrato: `session.state` es un mensaje real que ya
  circula en producción pero **no está descrito en `messages.schema.json` ni
  en `types.ts`** (el `SessionMessage` formal solo cubre
  `session.join|leave|role_change|ping`). Es deuda preexistente del contrato,
  no introducida por este cambio; no se resuelve aquí porque no bloquea a
  `networking-agent` para implementar el seeding (que es 100% server-side) ni
  cambia la forma de `AuthorityTransfer`. Si otro agente necesita consumir
  `session.state` tipado formalmente, debe pedir al orquestador que lo
  incorpore al schema en un cambio aparte.

### 3. Enforcement de `canWrite` en el servidor

`server/api` debe aplicar el gate de autoridad de `AuthorityManager.canWrite`
a todo `control.event`/`control.axis` entrante cuyo `controlId` sea uno de los
6 listados en el punto 1, usando el grupo `"flight_controls"`. Mensajes para
esos `controlId` que no pasen `canWrite` (porque el remitente no es el dueño
actual del grupo) se descartan en el servidor y no se reenvían al resto de la
sesión.

Para el resto de controles (`authority: shared`, `captain-only`,
`first-officer-only`, `instructor-only`, `local-only`) el comportamiento del
gate de grupo no cambia — no pertenecen a `flight_controls` y no pasan por
`AuthorityManager`. **Cambio de comportamiento esperado (no bug):** a partir de
este cambio, `captain-only`/`first-officer-only` pasan a enforzarse realmente
en el servidor (antes no había gate activo); un participante con el seat
equivocado que intente escribir un control `captain-only`/`first-officer-only`
verá su mensaje descartado igual que si violara `flight_controls`. Este es el
comportamiento correcto y deseado, `networking-agent` no debe "arreglarlo" como
regresión.

### 4. `LoopGuard` por sesión, no por proceso

`server/api` debe instanciar un `LoopGuard` **por sesión activa** (mismo scope
que el `AuthorityManager` de esa sesión), nunca un único `LoopGuard` global
compartido entre todas las sesiones del proceso. Un `LoopGuard` global
arriesga deduplicar/descartar mensajes legítimos de una sesión por
coincidencia de secuencia/contenido con otra sesión completamente distinta.

### 5. Deuda documentada (no bloqueante para este sprint)

Hoy `packages/profile-schema/control.schema.json` no tiene un campo `group`
por control — todos los `exclusive` caen implícitamente en el único grupo
`"flight_controls"`. Si en el futuro se necesitan grupos `exclusive`
independientes (ej. controles de un sistema distinto a vuelo que también deban
ser mutuamente excluyentes pero con su propio dueño, separado de
`flight_controls`), habrá que:

1. Agregar un campo `group` opcional a `control.schema.json` (default
   `"flight_controls"` para no romper manifests existentes).
2. Que `server/api` registre un `AuthorityManager.registerGroup` por cada
   `group` distinto encontrado en los manifests activos de la sesión, en vez
   de asumir uno solo.

No implementar esto ahora — es trabajo de `aircraft-profiles-agent` +
`networking-agent` coordinado por el orquestador cuando exista un caso real
que lo requiera.
