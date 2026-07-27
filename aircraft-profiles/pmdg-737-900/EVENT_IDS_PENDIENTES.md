# Event IDs pendientes — PMDG 737-900/900ER (Client Data Area, SDK oficial)

## ACTUALIZACIÓN 2026-07-26 (sesión posterior) — EVT_EVENT_IDS_FULL.txt: cruce sistemático completo, ~100 Event IDs confirmados por escrito

Darwin extrajo el PDF completo del SDK con poppler y ahora existe
`apps/desktop-ui/Documentation/SDK/EVT_EVENT_IDS_FULL.txt` (los 842 `#define
EVT_*` del header **con su comentario original**, no solo el offset
numérico). Esto es una fuente más fuerte que los "candidatos calculados"
documentados más abajo en este archivo (esos solo tenían el offset, no el
comentario que confirma qué switch físico es cada uno). Se cruzó
sistemáticamente contra todos los campos ya leídos (`readOnly: true`) en
`controls/electrical.yaml`, `hydraulics.yaml`, `fuel.yaml`, `lights.yaml`,
`fms.yaml`, `engine.yaml`, `cabin-misc.yaml`, `air.yaml`. Resultado: **96
controles se convirtieron de readOnly a read+write real** (electrical 14,
hydraulics 4, fuel 14, lights 12, fms 7, engine 2, cabin-misc 6, air 25) más
**7 controles nuevos writeOnly en autopilot.yaml** (`EVT_MCP_*_SET`: course
L/R, IAS, Mach, heading, altitude, VS — offset 14500+, comentario original
documenta explícitamente parámetro absoluto, ej. "Sets new heading, commands
the shortest turn") y **140 controles nuevos writeOnly en `controls/mcdu.yaml`**
(teclado completo del CDU L/R, `EVT_CDU_L_*`/`EVT_CDU_R_*`, patrón
`writeOnly: true` ya aprobado). Ver `capabilities.yaml`/`manifest.yaml` para
el detalle honesto por sistema. **NADA de esto fue confirmado EN VIVO contra
MSFS+PMDG real** — sigue pendiente el mismo checklist de "Cómo cerrar cada
fila" al final de este archivo, ahora aplicado a ~100 controles en vez de 2.

### Pendiente real que queda tras este cruce (NO resuelto, documentado explícitamente)

- **Radios (`controls/radios.yaml`)**: se revisaron los ~130 Event IDs
  `EVT_ACP_*`/`EVT_COM1-3_*`/`EVT_NAV1-2_*`/`EVT_ADF_*`/`EVT_SELCAL_*`. Ninguno
  tiene semántica de SET absoluto documentada (los únicos con pista de
  "rotación" dicen literalmente "1000 added for volume rotation event", es
  decir relativo/incremental, no absoluto — mismo riesgo anti-TOGGLE que los
  selectores de mouse ya descartados). Tampoco hay offset de lectura
  transcrito en `PmdgNg3DataLayout.cs` para los structs ACP_/COM_/NAV_/ADF_/
  SELCAL_ (solo `ADF_StandbyFrequency` existe hoy, sin Event ID de escritura
  seguro). Sin candidato seguro esta ronda.
- **`lights.circuit_breaker_knob` / `lights.overhead_panel_knob`**: candidatos
  `EVT_OH_CB_LIGHT_CONTROL`/`EVT_OH_PANEL_LIGHT_CONTROL` existen y el campo C
  es "Position 0...150" (numérico, no boolean), pero el comentario original de
  `EVT_OH_PANEL_LIGHT_CONTROL` dice literalmente "PANEL Light Control
  **Decrease**" — sugiere un pulso relativo de decremento, no un `SET_VALUE`
  absoluto pese a que el campo tiene rango numérico. Descartado por
  prudencia, no confirmado que sea seguro.
- **`engine.start_valve_1/2`, `engine.start_selector_1/2`,
  `engine.ignition_selector`, todos los campos `apu.*` (`APU_Selector`,
  anunciadores)**: existe un grupo de 4 Event IDs consecutivos en el header
  (`EVT_OH_LIGHTS_APU_START`=69750, `EVT_OH_LIGHTS_L_ENGINE_START`=69751,
  `EVT_OH_LIGHTS_IGN_SEL`=69752, `EVT_OH_LIGHTS_R_ENGINE_START`=69753) cuyo
  ORDEN y nombres (`APU_START`, `L_ENGINE_START`, `IGN_SEL`,
  `R_ENGINE_START`) coinciden sospechosamente bien con
  `APU_Selector`/`ENG_StartSelector[2]`/`ENG_IgnitionSelector`, pero están
  prefijados `EVT_OH_LIGHTS_*` (no `EVT_OH_ENG_*`/`EVT_OH_APU_*`) y sin
  comentario que lo confirme. Coincidencia de orden/posición en el header NO
  es evidencia suficiente ("nada inventado") — se dejó explícitamente sin
  usar. Si alguien confirma en vivo que estos SÍ son los switches de
  arranque reales (probablemente el header los agrupa bajo "LIGHTS" porque
  esa sección también controla la luz integral del switch de arranque),
  mover aquí a "Confirmados".
- **`electrical.dc_meter_selector`/`ac_meter_selector`/`standby_power_selector`,
  `air.pack_switch_1/2`, `air.isolation_valve_switch`**: convertidos a
  escribibles con Event ID confirmado por NOMBRE, pero el valor de
  `Parameter` a transmitir para cada posición del selector no está fijado en
  el perfil (el bridge hoy no soporta sustituir `parameter` dinámicamente
  según el valor que se está escribiendo, mismo gap ya documentado para
  `lights.taxi` desde 2026-07-25 — ver `controls/lights.yaml`). Bloqueado en
  `apps/simulator-bridge/.../ProfileModels.cs`/`ProfileRepository.cs`, no en
  este perfil — coordinar con simconnect-bridge-agent.
- **`autopilot.mcp_*_set` (7 controles nuevos)**: son `writeOnly: true`
  porque `MCP_Course[2]`/`MCP_IASMach`/`MCP_Heading`/`MCP_Altitude`/
  `MCP_VertSpeed` SÍ existen en `PMDG_NG3_SDK.h` pero su offset NO está
  transcrito en `PmdgNg3DataLayout.cs` (que hoy cubre "IRS_DisplaySelector
  hasta LTS_WheelWellSw" + AFS_* al inicio, no el tramo MCP_*). Ampliar la
  transcripción del struct para incluir ese tramo (y así poder emparejar
  `read` con estos 7 controles) le corresponde a wasm-agent/
  simconnect-bridge-agent, no a este perfil.

## ACTUALIZACIÓN 2026-07-26 — segundo Event ID confirmado (EVT_OH_LIGHTS_LOGO) + revisión completa de campos con offset real

Se releyó `PmdgNg3DataLayout.cs` completo (tramo transcrito, desde
`IRS_DisplaySelector` hasta `LTS_WheelWellSw`) y se agregaron TODOS los
campos restantes con offset real que aún no tenían control YAML, salvo los
bloqueados por esquema (ver abajo). Nuevos archivos: `controls/fms.yaml`
(IRS_*/NAVDIS_*, 22 controles), `controls/engine.yaml` (ENG_*/APU_*, 16
controles), `controls/fuel.yaml` (FUEL_*, 27 controles), `controls/air.yaml`
(AIR_*/ICE_*, 67 controles), `controls/cabin-misc.yaml` (WARN_/COMM_/OXY_/
GEAR_annun/FLTREC_/CVR_/OH_Wiper/DOOR_annun, 29 controles). Se ampliaron
`controls/flight-controls.yaml` (+15 FCTL_*), `controls/autopilot.yaml` (+3
AFS_*), `controls/radios.yaml` (+1 ADF_StandbyFrequency), `controls/
lights.yaml` (+16 LTS_* adicionales + lights.logo escribible). Todos readOnly
salvo lights.logo (ver hallazgo de abajo).

**Se releyeron con cuidado los dos .cpp de ejemplo** buscando literalmente
cualquier `#define EVT_` o valor numérico usado en las llamadas de ejemplo
(no solo asumir que EVT_OH_LIGHTS_TAXI era el único). Resultado en
`PMDG_NG3_ConnectionTest.cpp`:

| Símbolo | Valor | Mecanismo | ¿Usable como `write` hoy? |
|---|---|---|---|
| `EVT_OH_LIGHTS_TAXI` | `69749` | `SimConnect_SetClientData` contra `PMDG_NG3_CONTROL_ID` (área de control), `Control.Parameter=0/1` explícito | SÍ -- ya en `controls/lights.yaml` (`lights.taxi`, `write.type: clientDataEvent`) |
| `EVT_OH_LIGHTS_LOGO` | `69754` | `SimConnect_MapClientEventToSimEvent(EVENT_LOGO_LIGHT_SWITCH, "#69754")` + `SimConnect_TransmitClientEvent(..., parameter)`, `parameter=New_LogoLightSwitch?1:0` explícito | **SÍ -- NUEVO**, agregado a `controls/lights.yaml` (`lights.logo`, `write.type: inputEvent`, `name: "#69754"`). Mecanismo distinto (SimConnect estándar de MapClientEventToSimEvent, no el área de control PMDG_NG3_Control) pero representable con el `write.type: inputEvent` existente del esquema porque el bridge (`SimConnectNativeClient.TransmitSetEvent`/`GetOrMapEvent`) ya mapea `control.Write.Name` vía `MapClientEventToSimEvent` y transmite `dwData=0/1` explícito para booleans -- coincide exactamente con el patrón del `.cpp` oficial. No requiere cambio de esquema ni de bridge. |
| `EVT_MCP_FD_SWITCH_L` | `70010` | `SimConnect_MapClientEventToSimEvent(EVENT_FLIGHT_DIRECTOR_SWITCH, "#70010")` + `TransmitClientEvent(..., MOUSE_FLAG_LEFTSINGLE)` luego `TransmitClientEvent(..., MOUSE_FLAG_LEFTRELEASE)` (simulación de click de mouse) | **NO** -- no fija un estado explícito (no hay `Parameter=0/1`), es una simulación de click que alterna el switch como lo haría un click real -- viola la regla anti-TOGGLE del proyecto (SET_ON/SET_OFF/SET_VALUE explícito, nunca TOGGLE/pulso). Descartado como candidato de `write` hasta que se confirme un mecanismo con estado explícito para el FD switch. |
| `EVT_MCP_HEADING_SELECTOR` | `70022` | `TransmitClientEvent(..., MOUSE_FLAG_WHEEL_UP)` (simulación de scroll de mouse sobre el knob) | **NO** -- es un incremento relativo (scroll), no un `SET_VALUE` explícito del valor final del heading bug -- mismo problema, no hay forma de fijar un valor determinístico con este Event tal como se usa en el ejemplo. Descartado. Nota: `autopilot.heading_bug` ya existe en el perfil vía simvar/evento SimConnect estándar (`AUTOPILOT HEADING LOCK DIR` / `HEADING_BUG_SET`), que sí es un SET explícito -- ese sigue siendo el mecanismo preferido para este control. |

`PMDG_NG3_SDK_CDU_Test.cpp` (248 líneas) se revisó completo: no contiene
ningún `#define EVT_` ni llamada a `SimConnect_TransmitClientEvent`/
`SimConnect_SetClientData` para el área de control -- es exclusivamente
código de renderizado del CDU (texto/celdas), sin Event IDs nuevos.

**Conclusión de esta pasada**: el único Event ID *nuevo* confirmado en vivo-
por-header es `EVT_OH_LIGHTS_LOGO=69754`. Sigue habiendo exactamente DOS
controles escribibles con evidencia real en todo el perfil: `lights.taxi` y
`lights.logo`.

## Bloqueado por esquema (nativeType no soporta float/int) -- coordinar con orchestrator

`PmdgNg3DataLayout.cs` (`LayoutFieldKind`) SÍ modela campos `Float` e `Int`
del struct real (necesarios para que el offset acumulado de los campos
siguientes sea correcto), pero
`packages/profile-schema/control.schema.json` → `read.nativeType` solo
admite el enum `["bool", "uchar", "uint", "char_array"]` -- no hay forma
honesta de declarar un control readOnly para estos campos sin inventar un
nativeType no soportado. Quedaron **sin control YAML**, documentados aquí
para que no se pierda el hallazgo:

- `FUEL_FuelTempNeedle`, `FUEL_QtyCenter`, `FUEL_QtyLeft`, `FUEL_QtyRight` (float)
- `APU_EGTNeedle` (float)
- `AIR_DuctPress[2]`, `AIR_DuctPressNeedle[2]`, `AIR_CabinAltNeedle`,
  `AIR_CabinDPNeedle`, `AIR_CabinVSNeedle`, `AIR_CabinValveNeedle`,
  `AIR_TemperatureNeedle` (float)
- `ICE_WindowHeatTestSw` (int)

Para exponerlos: ampliar el enum `nativeType` en
`packages/profile-schema/control.schema.json` con `"float"` e `"int"` (y el
manejo correspondiente de tamaño/parsing en el bridge, `PmdgClientDataClient.cs`)
-- esto es un contrato compartido (`packages/profile-schema`) y **debe pasar
por el orchestrator**, no se tocó en esta sesión.

## ACTUALIZACIÓN 2026-07-25 — controles readOnly reales agregados (ya NO pendientes de Event ID)

`packages/profile-schema/control.schema.json` ahora soporta controles
`readOnly: true` (write opcional). Como consecuencia, TODOS los campos
`ELEC_*` con offset confirmado en `PmdgNg3DataLayout.cs` (electrical.yaml) y
TODOS los campos `HYD_*` con offset confirmado (hydraulics.yaml) ya se
agregaron como controles reales de solo lectura al perfil — **ya no están
"pendientes"** en el sentido de "no se puede hacer nada con ellos todavía".
Esto incluye explícitamente los switches (`ELEC_GenSw`, `ELEC_APUGenSw`,
`ELEC_GrdPwrSw`, `ELEC_BusTransSw_AUTO`, `ELEC_StandbyPowerSelector`,
`ELEC_IDGDisconnectSw`, `ELEC_DCMeterSelector`, `ELEC_ACMeterSelector`,
`ELEC_BatSelector`, `ELEC_CabUtilSw`, `ELEC_IFEPassSeatSw`,
`HYD_PumpSw_eng`, `HYD_PumpSw_elec`), no solo los anunciadores puros — para
esos switches SÍ se leen en vivo (una vez confirmado el mecanismo de lectura
contra MSFS real), solo que no se pueden ACCIONAR desde la cabina compartida
todavía.

**Lo que SIGUE pendiente de verdad** (esta tabla de abajo sigue vigente para
eso): si en el futuro alguien quiere hacer ESCRIBIBLE alguno de esos
switches (no solo leerlo), SÍ necesita un Event ID de `PMDG_NG3_Control.Event`
CONFIRMADO EN VIVO contra MSFS + PMDG real (los valores de la tabla de abajo
son CALCULADOS desde el header, no confirmados) antes de agregar un bloque
`write` y quitar `readOnly: true` del control correspondiente en
`controls/electrical.yaml` / `controls/hydraulics.yaml`. Los anunciadores
puros (`ELEC_annun*`, `HYD_annun*`, `ELEC_MeterDisplayTop/Bottom`,
`ELEC_BusPowered[16]`) nunca van a necesitar Event ID: no tiene sentido
"escribir" un anunciador o un display.


Checklist ejecutable para continuar la Fase 7 (bloqueada). Generado 2026-07-25
tras agregar `controls/lights.yaml` (`lights.taxi`, único control con offset +
Event ID confirmados hoy). Fuentes usadas:

- `apps/desktop-ui/Documentation/SDK/PMDG_NG3_SDK.h` (header oficial, struct
  `PMDG_NG3_Data` + tabla de `#define EVT_*`).
- `apps/desktop-ui/Documentation/SDK/PMDG_NG3_ConnectionTest.cpp` (único
  ejemplo de uso real, `toggleTaxiLightSwitch()`).
- `apps/simulator-bridge/.../PmdgNg3DataLayout.cs` (offsets de lectura
  transcritos, primer tramo del struct hasta `LTS_WheelWellSw`).
- `apps/simulator-bridge/.../PmdgClientDataClient.cs`
  (`KnownControlEventIds`, `TryResolveEventId`).

## HALLAZGO IMPORTANTE de hoy (cambia el plan de "probar todo en vivo")

`PMDG_NG3_SDK.h` línea 604 define:

```c
#define THIRD_PARTY_EVENT_ID_MIN   0x00011000   // = 69632
```

Y **todos** los `#define EVT_OH_*` / `EVT_MCP_*` / `EVT_EFIS_*` / etc. del
header se expresan como `THIRD_PARTY_EVENT_ID_MIN + <offset>`, incluyendo
`EVT_OH_LIGHTS_TAXI = THIRD_PARTY_EVENT_ID_MIN + 117 = 69632 + 117 = 69749`.

Ese resultado (69749) **coincide exactamente** con el único valor numérico
confirmado hasta ahora por el ejemplo `.cpp` (`EVT_OH_LIGHTS_TAXI = 69749`).
Es decir: el header no es solo "nombres simbólicos sin valor" — con
`THIRD_PARTY_EVENT_ID_MIN` ya podemos **calcular** el valor numérico de
cualquier `#define EVT_*` del header, y ese cálculo quedó cruzado
independientemente contra el único caso ya validado por el `.cpp` oficial.

Esto **NO es lo mismo que "confirmado contra MSFS real"** (nunca se abrió
MSFS/PMDG en este entorno), pero es una fuente bastante más fuerte que "no hay
ningún Event ID conocido": para los campos de abajo, el candidato ya no hay
que "buscarlo" en vivo, hay que **validarlo** en vivo (activar el switch real
y confirmar que ese ID exacto es el que dispara SimConnect, y que
`Control.Parameter` efectivamente fija 0/1 como en el taxi light).

`PmdgClientDataClient.TryResolveEventId` ya acepta un entero directo en YAML
(`write.event: 69749`, `uint.TryParse` primero) sin necesitar tocar
`KnownControlEventIds` — así que declarar estos candidatos en YAML no requiere
cambios en C#, solo pasar por validación en vivo antes de confiar en ellos.

## NOTA 2026-07-26: las dos tablas de abajo (ELEC_*/HYD_*) quedaron RESUELTAS por EVT_EVENT_IDS_FULL.txt

Todos los Event IDs listados como "candidato calculado" en las dos tablas de
abajo (ELEC_* y HYD_*) coinciden EXACTAMENTE con los valores confirmados por
escrito en `EVT_EVENT_IDS_FULL.txt` (comentario original del header, no solo
offset calculado) — el cálculo `THIRD_PARTY_EVENT_ID_MIN + offset` ya era
correcto. Todos esos controles se movieron a `controls/electrical.yaml` /
`controls/hydraulics.yaml` con `write.type: clientDataEvent` real (ver
sección de arriba, "ACTUALIZACIÓN 2026-07-26 (sesión posterior)"). Las tablas
quedan abajo como registro histórico de cómo se llegó al valor, pero ya NO
son "pendientes" — siguen sin confirmación EN VIVO, que es la única pieza
real que falta ahora para estos campos.

## Candidatos ELEC_* (electrical) — offset de lectura confirmado, Event ID CANDIDATO (no probado en vivo)

| Campo (`PmdgNg3DataLayout`, struct `PMDG_NG3_Data`) | `#define` candidato (header) | Valor calculado | Notas / riesgo |
|---|---|---|---|
| `ELEC_annunBAT_DISCHARGE`, `ELEC_annunTR_UNIT`, `ELEC_annunELEC` | — (son annunciators, solo lectura, no tienen switch que fijar) | — | No requieren `write`; si el esquema soportara control solo-lectura, listos hoy. |
| `ELEC_DCMeterSelector` | `EVT_OH_ELEC_DC_METER` | `69632 + 3 = 69635` | Knob, puede no ser boolean (`dataType: number`?) — confirmar si es un selector multi-posición o pulso. |
| `ELEC_ACMeterSelector` | `EVT_OH_ELEC_AC_METER` | `69632 + 4 = 69636` | Igual que arriba. |
| `ELEC_BatSelector` | ninguno claro en el header (¿`EVT_OH_ELEC_BATTERY_SWITCH` = 69633?) | `69632 + 1 = 69633` (sin confirmar que sea el mismo control) | `ELEC_BatSelector` (selector) vs `EVT_OH_ELEC_BATTERY_SWITCH` (switch) pueden no ser el mismo control físico — verificar en el header/PDF antes de asumir. |
| `ELEC_CabUtilSw` | `EVT_OH_ELEC_CAB_UTIL` | `69632 + 5 = 69637` | Header dice "[-800/900 only]" — coincide con nuestro perfil (900/900ER). |
| `ELEC_IFEPassSeatSw` | `EVT_OH_ELEC_IFE` | `69632 + 6 = 69638` | Igual, "[-800/900 only]". |
| `ELEC_StandbyPowerSelector` | `EVT_OH_ELEC_STBY_PWR_SWITCH` (+ `EVT_OH_ELEC_STBY_PWR_GUARD` = 69643 si el switch tiene guarda física separada) | `69632 + 10 = 69642` | Confirmar si hace falta togglear la guarda (Event separado) antes de que el switch acepte el Set. |
| `ELEC_IDGDisconnectSw[0]` (izquierdo) | `EVT_OH_ELEC_DISCONNECT_1_SWITCH` (+ `..._1_GUARD`) | `69632 + 12 = 69644` (guard: `69632+13=69645`) | Switch con guarda tipo "cubierta" — mismo riesgo que StandbyPower. |
| `ELEC_IDGDisconnectSw[1]` (derecho) | `EVT_OH_ELEC_DISCONNECT_2_SWITCH` (+ `..._2_GUARD`) | `69632 + 14 = 69646` (guard: `69632+15=69647`) | Igual. |
| `ELEC_GrdPwrSw` | `EVT_OH_ELEC_GRD_PWR_SWITCH` | `69632 + 17 = 69649` | Sin guarda visible en el header. |
| `ELEC_BusTransSw_AUTO` | `EVT_OH_ELEC_BUS_TRANSFER_SWITCH` (+ `..._GUARD`) | `69632 + 18 = 69650` (guard: `69632+19=69651`) | Confirmar semántica exacta de "AUTO" en el campo vs el switch de 3 posiciones real. |
| `ELEC_GenSw[0]` (izquierdo) | `EVT_OH_ELEC_GEN1_SWITCH` | `69632 + 27 = 69659` | — |
| `ELEC_GenSw[1]` (derecho) | `EVT_OH_ELEC_GEN2_SWITCH` | `69632 + 30 = 69662` | Ojo: no es +28, es +30 (el orden de los `#define` en el header no es estrictamente L,R contiguo). |
| `ELEC_APUGenSw[0]` (izquierdo) | `EVT_OH_ELEC_APU_GEN1_SWITCH` | `69632 + 28 = 69660` | — |
| `ELEC_APUGenSw[1]` (derecho) | `EVT_OH_ELEC_APU_GEN2_SWITCH` | `69632 + 29 = 69661` | — |

Campos ELEC_* sin ningún `#define EVT_OH_ELEC_*` identificable en el header
transcrito arriba (revisar el header completo, esta tabla no es exhaustiva del
lado header): `ELEC_annunSTANDBY_POWER_OFF`, `ELEC_annunGRD_POWER_AVAILABLE`,
`ELEC_annunTRANSFER_BUS_OFF[2]`, `ELEC_annunSOURCE_OFF[2]`,
`ELEC_annunGEN_BUS_OFF[2]`, `ELEC_annunAPU_GEN_OFF_BUS`,
`ELEC_MeterDisplayTop/Bottom` (displays, no switches),
`ELEC_BusPowered[16]` (status, no switch) — todos son annunciators/displays de
solo lectura, consistente con no tener Event de escritura.

## Candidatos HYD_* (hydraulics) — offset de lectura confirmado, Event ID CANDIDATO (no probado en vivo)

| Campo | `#define` candidato | Valor calculado | Notas |
|---|---|---|---|
| `HYD_PumpSw_eng[0]` | `EVT_OH_HYD_ENG1` | `69632 + 165 = 69797` | Asumiendo que el índice 0 del array de lectura corresponde al motor 1 (izquierdo) — **no confirmado**, el orden del array C real puede diferir. |
| `HYD_PumpSw_eng[1]` | `EVT_OH_HYD_ENG2` | `69632 + 166 = 69798` | Mismo riesgo de orden de array. |
| `HYD_PumpSw_elec[0]` | `EVT_OH_HYD_ELEC1` | `69632 + 168 = 69800` | Ojo: en el header `EVT_OH_HYD_ELEC2` (167) aparece ANTES que `EVT_OH_HYD_ELEC1` (168) en el orden de `#define` — no asumir que el orden de aparición en el header es el orden del array `HYD_PumpSw_elec[2]`. |
| `HYD_PumpSw_elec[1]` | `EVT_OH_HYD_ELEC2` | `69632 + 167 = 69799` | Igual. |

`HYD_annunLOW_PRESS_eng[2]`, `HYD_annunLOW_PRESS_elec[2]`,
`HYD_annunOVERHEAT_elec[2]`: annunciators de solo lectura, sin Event
esperado.

## Otros sistemas con offset de lectura — ACTUALIZADO 2026-07-26: ya NO pendientes de "agregar control", solo de Event ID

Todos los campos listados en esta sección (versión anterior de este
documento) YA se agregaron como controles `readOnly: true` reales -- ver
`controls/flight-controls.yaml` (FCTL_*), `controls/fuel.yaml` (FUEL_*),
`controls/lights.yaml` (LTS_* restantes + `lights.logo` ahora ESCRIBIBLE),
`controls/air.yaml` (ICE_*/AIR_*), `controls/engine.yaml` (APU_Selector,
ENG_StartSelector, ENG_IgnitionSelector), `controls/cabin-misc.yaml`
(OH_WiperLSelector/RSelector, COMM_ServiceInterphoneSw,
COMM_NoSmokingSelector, COMM_FastenBeltsSelector). Ya no están "pendientes"
en el sentido de "no se puede hacer nada con ellos todavía" -- se leen en
vivo (una vez confirmado el mecanismo de lectura contra MSFS real).

**Lo que SIGUE pendiente de verdad**: convertirlos en escribibles requiere,
igual que ELEC_*/HYD_*, un Event ID de `PMDG_NG3_Control.Event` (o, como se
descubrió con `lights.logo`, un Event ID mapeado vía
`SimConnect_MapClientEventToSimEvent` + `write.type: inputEvent`)
CONFIRMADO EN VIVO o, como mínimo, CALCULADO (`THIRD_PARTY_EVENT_ID_MIN +
offset del #define`) contra el header completo -- esta sesión revisó los dos
.cpp de ejemplo (no encontró más Event IDs confirmados salvo
`EVT_OH_LIGHTS_LOGO`, ver arriba) pero NO revisó el header `PMDG_NG3_SDK.h`
completo línea por línea para calcular candidatos de cada campo FCTL_*/
FUEL_*/LTS_*/ICE_*/AIR_*/ENG_*/OH_*/COMM_* -- queda para una próxima pasada
si se quiere repetir el ejercicio de "candidatos calculados" que ya se hizo
para ELEC_*/HYD_* (ver secciones de abajo).

## Cómo cerrar cada fila de este checklist (pasos ejecutables)

1. **Confirmar el `#define` correcto en el header** (`PMDG_NG3_SDK.h`) para el
   campo del struct que se quiere escribir. Si no existe un `EVT_OH_*`
   evidente, revisar `PMDG_737_MSFS_SDK.pdf` (sección de eventos de terceros /
   Client Data Area) por si el nombre del switch en cabina no coincide
   literalmente con el nombre del campo del struct.
2. **Calcular el candidato**: `THIRD_PARTY_EVENT_ID_MIN (69632) + offset del
   #define`.
3. **EN VIVO, con MSFS + PMDG 737 abiertos y `EnableDataBroadcast=1`**
   (ver `PmdgClientDataClient.cs` líneas ~24-36):
   - Activar el switch real en cabina y confirmar (log/breakpoint en
     `PmdgClientDataClient`) que el bit correspondiente en
     `PMDG_NG3_Data` (offset ya calculado en `PmdgNg3DataLayout`) cambia.
   - Escribir manualmente `Control.Event = <candidato>` con
     `Control.Parameter = 0` y `1` y confirmar que el switch físico se mueve a
     OFF/ON de forma determinística (no un toggle).
   - Si el switch tiene guarda (`_GUARD` en el header), confirmar si hace
     falta levantar la guarda primero con su propio Event antes de que el
     switch acepte el Set.
4. Solo tras el paso 3: mover el control de "candidato" a
   `controls/electrical.yaml` / `controls/hydraulics.yaml` /
   `controls/lights.yaml` con `sdkTier: clientDataArea`, `write.type:
   clientDataEvent`, `semantics` describiendo el efecto exacto observado, y
   subir `capabilities.electrical` / `capabilities.hydraulics` de `none` a
   `partial` en `manifest.yaml` (nunca `full` sin cobertura completa del
   sistema).
5. Actualizar este archivo tachando/moviendo la fila cerrada a un changelog
   al final (no lo hay todavía — crear una sección "Confirmados" cuando el
   primero de esta lista se cierre).
