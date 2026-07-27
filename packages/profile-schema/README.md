# @shared-cockpit/profile-schema

Esquema formal de los perfiles de aeronave en `aircraft-profiles/*/`.
Dueño: aircraft-profiles-agent (cambios requieren aprobación del orquestador,
porque los consumen wasm-agent y simconnect-bridge-agent).

## Estructura de un perfil

```
aircraft-profiles/<id>/
├── manifest.yaml       # metadata, compatibilidad, versiones probadas
├── detection.yaml       # cómo detectar esta aeronave por título
├── capabilities.yaml    # qué sistemas cubre este perfil y con qué nivel
├── controls/
│   ├── flight-controls.yaml
│   ├── electrical.yaml
│   ├── overhead.yaml
│   ├── autopilot.yaml
│   ├── radios.yaml
│   └── mcdu.yaml
├── mappings/
│   ├── msfs2020.yaml
│   └── msfs2024.yaml
├── scripts/
└── tests/
```

## Regla de oro: read/write separados

Un control declara `read` y `write` por separado porque algunas variables se leen
pero no se escriben igual (o no se pueden escribir directo). Ejemplo:

```yaml
read:
  type: lvar
  name: "L:EXAMPLE_BEACON_STATE"
write:
  type: inputEvent
  name: "EXAMPLE_BEACON_SET"
```

## Regla de oro: nunca TOGGLE

`write.type` nunca debe ser un evento de tipo TOGGLE puro para interruptores
sincronizables — usar SET_ON/SET_OFF/SET_VALUE y confirmar el estado real después
(`synchronization.confirmAfterWrite: true`).

Ver `profile.schema.json` para la validación formal.

## Controles solo-lectura (`write` opcional + `readOnly: true`)

`write` es **opcional** en el schema. Muchos indicadores/anunciadores del
simulador o de un SDK de terceros (ej. la mayoría de `ELEC_annun*`/`HYD_*` del
PMDG NG3 SDK) son legítimamente de solo lectura: no tiene sentido "escribir" una
luz de aviso, y el SDK no expone ningún Event ID para ellos.

Cuando un control no declara `write`, el schema **exige** que declare
`readOnly: true` de forma explícita (no basta con omitir `write` en silencio).
Se eligió explícito-y-obligatorio en vez de inferido-de-la-ausencia por una
razón concreta: si `readOnly` se infiriera solo de que falta `write`, un perfil
incompleto por accidente (alguien olvidó agregar el `write` de un control que sí
debería ser escribible) pasaría la validación igual, disfrazado de "solo
lectura" legítimo. Exigir `readOnly: true` explícito obliga a declarar la
intención, y `tools/validate_profiles.py` (vía JSON Schema `if`/`then`) falla la
validación si:

- un control no tiene `write` y tampoco declara `readOnly: true` (perfil
  incompleto, no un solo-lectura real), o
- un control sí tiene `write` pero además declara `readOnly: true`
  (contradicción: no puede ser escribible y de solo lectura a la vez).

**`authority` en controles solo-lectura**: el campo sigue siendo `required` por
consistencia estructural del schema, pero es semánticamente irrelevante — no hay
ninguna escritura cuya autoridad arbitrar entre pilotos, el valor simplemente
refleja lo que reporta el simulador/addon igual para todos. Convención del
proyecto: usar `authority: shared` en estos casos salvo razón documentada en
contrario.

**Regla anti-TOGGLE y controles solo-lectura**: no aplica. La regla anti-TOGGLE
existe para prevenir que una escritura sincronizable dispare un pulso crudo
ambiguo; un control sin `write` no escribe nada, así que no hay ningún riesgo de
TOGGLE que evaluar. `tools/validate_profiles.py` ya maneja esto de forma segura
(su heurística anti-TOGGLE opera sobre `control.get("write") or {}`, que
resuelve a un diccionario vacío cuando no hay `write` y por lo tanto no dispara
ningún falso positivo).

### Ejemplo YAML — anunciador solo-lectura (PMDG 737 NG3, Client Data Area)

Campo real transcrito en
`apps/simulator-bridge/src/SimulatorBridge/SimConnectInterop/PmdgNg3DataLayout.cs`
(`ELEC_annunBAT_DISCHARGE`, sin Event ID de escritura en el SDK — es un
anunciador puro):

```yaml
- id: electrical.annun_bat_discharge
  dataType: boolean
  authority: shared
  readOnly: true
  sdkTier: clientDataArea
  read:
    type: clientDataArea
    areaName: "PMDG_NG3_Data"
    field: "ELEC_annunBAT_DISCHARGE"
    nativeType: bool
  synchronization:
    mode: polled
    confirmAfterWrite: false
```

Nota: no hay bloque `write`. `synchronization.confirmAfterWrite` no tiene
sentido para un control que nunca se escribe localmente, así que se declara
`false` explícitamente (el valor sigue leyéndose/sincronizándose vía `read`
normalmente para que el copiloto lo VEA, solo que ninguna de las dos cabinas
puede tocarlo).

## Controles vía SDK de terceros (Client Data Area, ej. PMDG_NG3_SDK.h)

Además de la forma estándar (`simvar`/`lvar`/`hvar` para `read`, `inputEvent`/
`hvar`/`calculatorCode` para `write`), un control puede declarar lectura/escritura
contra un Client Data Area de un addon de terceros que expone su propio SDK
(confirmado para PMDG NG3: `PMDG_NG3_Data` de lectura, `PMDG_NG3_Control` de
escritura, ver `apps/desktop-ui/Documentation/SDK/PMDG_NG3_SDK.h`).

- `read.type: clientDataArea` — requiere `areaName` (nombre del área, ej.
  `"PMDG_NG3_Data"`), `field` (nombre del campo C del struct, ej.
  `"IRS_ModeSelector"`), `nativeType` (`bool` | `uchar` | `uint` | `char_array`, para
  que el bridge calcule offset/tamaño dentro del struct binario) y opcionalmente
  `arrayIndex` (si `field` es un array C, ej. `IRS_ModeSelector[2]`).
- `write.type: clientDataEvent` — requiere `areaName` (ej. `"PMDG_NG3_Control"`),
  `event` (valor numérico o nombre simbólico del campo `Event` del struct de
  control) y **`semantics` obligatorio**: una descripción libre y auditable de qué
  hace exactamente ese Event (ej. `"sets IRS mode selector to NAV"`). `parameter`
  es opcional (campo `Parameter` del struct). `write` completo (y por lo tanto
  este bloque) es opcional: si el campo no tiene Event ID de escritura real,
  omite `write` y declara `readOnly: true` (ver sección anterior) en vez de
  inventar un Event ID.
- `sdkTier: standardSimConnect | clientDataArea` (opcional en el control completo,
  default `standardSimConnect`) — declara si el control necesita el SDK oficial del
  addon con `EnableDataBroadcast=1` activo, para que el bridge pueda hacer fallback
  si el usuario no lo tiene habilitado.

### Regla anti-TOGGLE también aplica a clientDataEvent

Aunque cada Event ID del SDK de PMDG ya tiene efecto determinístico (no es un
TOGGLE genérico como los eventos crudos de SimConnect), la regla de auditabilidad
del proyecto sigue aplicando: `semantics` es obligatorio y NO puede ser un valor
trivial como `"toggle"` — debe describir el estado explícito que fija el Event,
igual que documentaríamos un SET_ON/SET_OFF. `tools/validate_profiles.py` valida
esto tanto por JSON Schema (`required`) como por una heurística adicional que
rechaza `semantics` vacías o triviales y nombres de `event` que contengan
"TOGGLE" en controles `boolean`.

### Ejemplo YAML — IRS Mode Selector (PMDG 737 NG3)

```yaml
- id: fms.irs_l_mode_selector
  dataType: number
  authority: captain-only
  sdkTier: clientDataArea
  read:
    type: clientDataArea
    areaName: "PMDG_NG3_Data"
    field: "IRS_ModeSelector"
    arrayIndex: 0
    nativeType: uchar
  write:
    type: clientDataEvent
    areaName: "PMDG_NG3_Control"
    event: "IRS_L_ModeSelector_Set"
    parameter: 2
    semantics: "sets IRS mode selector to NAV"
  synchronization:
    mode: event
    confirmAfterWrite: true
```

Nota: este control usa la forma estándar (`read.type: simvar|lvar|hvar` +
`write.type: inputEvent|hvar|calculatorCode`) para todo lo que MSFS ya expone de
forma nativa. Reserva `clientDataArea`/`clientDataEvent` para lo que solo el SDK
del addon expone (como el IRS mode selector de PMDG, que no tiene simvar propio).

## Botones momentáneos (ej. teclado del CDU/MCDU, `EVT_CDU_*`)

El SDK del PMDG NG3 expone 140 Event IDs con prefijo `EVT_CDU_L_*`/`EVT_CDU_R_*`
(una tecla física del teclado del FMC/CDU cada uno: `L1`..`L6`, `R1`..`R6`,
`EXEC`, `LSK`, dígitos, letras, etc. — ver
`apps/desktop-ui/Documentation/SDK/EVT_EVENT_IDS_FULL.txt`). Conceptualmente
son un **press** (acción momentánea, sin estado persistente que recordar), no
un interruptor con posición ON/OFF.

Decision: no hizo falta interactionType ni cambio de protocolo, pero SI hizo falta un ajuste chico y aditivo al schema (packages/profile-schema/control.schema.json): read era obligatorio SIEMPRE antes de este cambio, incluso para controles sin ningun estado persistente que leer (un press no deja una posicion que releer). Se agrego writeOnly (booleano), simetrico al readOnly que ya existia: obligatorio y explicito cuando el control no declara read, exige ademas que el control declare write, y es incompatible con declarar read. Retrocompatible: verificado con tools/validate_profiles.py sobre cessna-172 y pmdg-737-900 sin tocarlos (ninguno usa writeOnly, todos siguen declarando read como antes).

Con eso, write.type: clientDataEvent ya alcanza para modelar un press:

- event: el Event ID de la tecla (ej. "EVT_CDU_L_EXEC").
- parameter: 1: valor fijo, el SDK no necesita otra cosa para una tecla, no hay "posicion" que fijar como en un selector de varios valores.
- semantics: describe la accion como press, no como estado (ej. "presses CDU L EXEC key"), para que la heuristica anti-TOGGLE y cualquier lector humano entiendan que esto NO es un switch invertible.
- dataType: boolean + value: true en el control.event de red (packages/protocol, ControlEvent.value) representa el press; no hay value: false significativo porque el boton no tiene estado "soltado" que sincronizar, el bridge no debe emitir un segundo evento al soltar la tecla en el simulador.
- synchronization.confirmAfterWrite: false (importante, a diferencia de un switch normal): un press no deja un valor persistente en el Client Data Area con sentido de releer y comparar (el struct de control se limpia o vuelve a un valor neutro despues de procesarse); pedir confirmacion causaria falsos positivos de "divergencia" contra un estado que ya cambio de vuelta. Si necesitas reflejar "tecla presionada" en la UI remota hazlo via el propio control.event recibido (origin: remote), no via polling de un read.
- La regla anti-TOGGLE sigue aplicando igual que a cualquier clientDataEvent: semantics no puede ser trivial ni decir literalmente "toggle". Un press con parameter fijo y semantica de "presses X key" ya es, por construccion, un SET explicito y deterministico (siempre la misma accion, nunca "invierte" nada), asi que pasa la heuristica sin cambios.

No se necesita un campo interactionType: momentary | set porque el riesgo que la regla anti-TOGGLE previene (dos jugadores dejando un switch en estados opuestos sin que ninguno sepa el estado real del otro) no existe para un boton sin estado persistente, cada press es un evento independiente y deterministico, ya cubierto por la semantica de "on-change discreto" que control.event siempre tuvo. writeOnly si hacia falta, pero por una razon distinta y mas basica: el schema no tenia ninguna forma de declarar "este control no tiene read" antes de este cambio.

### Ejemplo YAML -- tecla EXEC del CDU izquierdo (PMDG 737 NG3)

```yaml
- id: mcdu.captain.key_exec
  dataType: boolean
  authority: shared
  sdkTier: clientDataArea
  writeOnly: true
  write:
    type: clientDataEvent
    areaName: "PMDG_NG3_Control"
    event: "EVT_CDU_L_EXEC"
    parameter: 1
    semantics: "presses CDU L EXEC key"
  synchronization:
    mode: event
    confirmAfterWrite: false
    debounceMs: 150
```

Nota: no hay bloque read, writeOnly: true lo declara explicito, igual que readOnly: true declara la ausencia de write en los anunciadores solo-lectura de la seccion anterior. debounceMs: 150 es una recomendacion defensiva contra doble-envio por rebote de UI (no es parte del contrato, ajustable por aircraft-profiles-agent segun pruebas reales en el CDU).
