# Event IDs pendientes — PMDG 737-900/900ER (Client Data Area, SDK oficial)

## ACTUALIZACIÓN 2026-07-27 (sesión posterior, simconnect-bridge-agent) — gear lever bug real corregido (K:GEAR_SET nunca funcionaba para bajar) + guardas físicas: confirmado que NO se sincronizan por diseño (no un bug)

Darwin reportó dos problemas nuevos que parecían el mismo patrón de bug real
que ya afectó `ground.parking_brake` (evento inventado que PMDG ignora):

### 1. "Landing gear lever -> solo sube no baja" — BUG REAL, CORREGIDO

`flight.gear` (`controls/flight-controls.yaml`) usaba `write.type: inputEvent`,
`name: "GEAR_SET"` (evento K: estándar de MSFS, `Parameter=0/1` explícito,
`read.name: "GEAR HANDLE POSITION"`). Evidencia real encontrada en
`apps/desktop-ui/recurso/definitions/FS2020/aircraft/"PMDG Simulations -
Boeing 737NG Series.yaml"` (implementación de referencia de YourControls, la
misma fuente ya usada verbatim para `native_toggle.landing_gear_lever_unlock`
y para casi todos los `native_toggle.*` del perfil):

```yaml
- # Gear Lever Up
  type: CustomCalculator
  get: (L:switch_455_73X) 0 ==
  set: 1 (>K:GEAR_UP)
- # Gear Lever Down
  type: CustomCalculator
  get: (L:switch_455_73X) 60 ==
  set: 1 (>K:GEAR_DOWN)
```

El PMDG NG3 (código heredado de FSX/P3D) **nunca escucha `K:GEAR_SET`** para
su lever -- solo hookea los dos K:events legacy separados y deterministas
`K:GEAR_UP` / `K:GEAR_DOWN`. `K:GEAR_SET(0)` (subir) coincidía por casualidad
con el comportamiento del sistema de tren por defecto de MSFS (por eso "subir"
parecía funcionar), pero `K:GEAR_SET(1)` (bajar) nunca llegaba al gauge de
PMDG -- de ahí exactamente el síntoma "sube pero no baja". Esto también
confirma, por escrito en `PMDG_NG3_SDK.h` (`unsigned char MAIN_GearLever; //
0: UP 1: OFF 2: DOWN`, línea 402, offset ya transcrito en
`PmdgNg3DataLayout.cs`) y en la sección `// Gear panel` del header
(`EVT_GEAR_LEVER`/`EVT_GEAR_LEVER_OFF`/`EVT_GEAR_LEVER_UNLOCK`), que PMDG SÍ
modela su propio estado de lever, separado del `GEAR HANDLE POSITION` estándar
de MSFS que seguíamos leyendo.

**Corrección aplicada** (sin tocar `packages/profile-schema` -- misma
filosofía que el soporte de "parameter dinámico" para `clientDataEvent`):
`BridgeService` ahora reconoce una convención nueva en
`write.type: inputEvent`, `write.name`: si el `dataType` es `boolean` y
`name` contiene un separador `'|'` (ej. `"GEAR_DOWN|GEAR_UP"`), el bridge
transmite el PRIMER K:event si el valor absoluto es `true` y el SEGUNDO si es
`false` (dwData=1 fijo para ambos -- mismo patrón que YourControls, que
siempre transmite `1` sin importar el estado). Sigue siendo un SET_ON/SET_OFF
explícito y determinístico (nunca un toggle): la elección de CUÁL K:event
disparar ya codifica la dirección, no hay alternancia. Ver
`BridgeService.ResolveInputEventPulse` +
`apps/simulator-bridge/tests/SimulatorBridge.Tests/
BridgeServiceInputEventPulseTests.cs`. `controls/flight-controls.yaml`
(`flight.gear`) actualizado a `write.name: "GEAR_DOWN|GEAR_UP"`. El `read`
(`GEAR HANDLE POSITION`) se dejó sin cambios: es un simvar estándar de MSFS
que SÍ se actualiza cuando se disparan `K:GEAR_UP`/`K:GEAR_DOWN` (son los
eventos legacy nativos del sistema de tren base del sim, no algo propietario
de PMDG), a diferencia del caso de `PARKING_BRAKE` donde ni siquiera el evento
existía. No verificado EN VIVO contra MSFS+PMDG real todavía (mismo estado
pendiente que el resto del perfil).

### 2. "Si abren la cubierta pero no la cierra" (guardas físicas) — INVESTIGADO, CONFIRMADO QUE NO ES UN BUG (por diseño, sin evidencia de SDK para sincronizarlo)

Se revisaron los 4 switches con guarda física de este perfil:
`electrical.standby_power_selector` (guard `EVT_OH_ELEC_STBY_PWR_GUARD`),
`electrical.idg_disconnect_sw_1`/`_2` (guards
`EVT_OH_ELEC_DISCONNECT_1/2_GUARD`), `electrical.bus_trans_sw_auto` (guard
`EVT_OH_ELEC_BUS_TRANSFER_GUARD`). Hipótesis original: el bridge solo
transmite el evento del switch principal y nunca el de la guarda, dejando la
guarda visualmente en el estado del último toggle manual del otro jugador.

**Dos hallazgos que descartan esta hipótesis como "bug corregible hoy":**

1. `PMDG_NG3_SDK.h` (`grep -i guard` sobre el struct completo) **no tiene
   NINGÚN campo de guarda** -- las guardas NO tienen posición legible en
   `PMDG_NG3_Data`. No hay forma de leer el estado real de una guarda ni de
   confirmar divergencia tras escribirla (`confirmAfterWrite` no tendría nada
   que confirmar).
2. La implementación de referencia PROBADA (YourControls,
   `apps/desktop-ui/recurso/definitions/FS2020/aircraft/"PMDG Simulations -
   Boeing 737NG Series.yaml"`) declara EXPLÍCITAMENTE las 4 guardas
   correspondientes como locales/no sincronizadas -- `type: var` SIN ningún
   mecanismo de escritura, con el comentario literal `"(keep var)"`:
   `"STANDBY POWER Switch Guard (keep var)"` (línea 2324, `L:switch_11_73X`),
   `"BUS TRANSFER Guard (keep var)"` (línea 4237, `L:switch_19_73X`), `"GEN
   DRIVE DISC Right Guard (keep var)"` (línea 4835), `"GEN DRIVE DISC Left
   Guard (keep var)"` (línea 5986). YourControls es la misma fuente que este
   proyecto ya usa como prueba de "funciona en vivo" para decenas de otros
   controles de este perfil (`native_toggle.*`) -- no es una fuente menor.

**Conclusión**: no se agregó ningún mecanismo de transmisión de evento de
guarda. Esto NO es el mismo tipo de bug que `parking_brake`/`flight.gear`
(donde el switch principal mismo estaba roto) -- aquí el switch principal SÍ
sincroniza correctamente (`ELEC_IDGDisconnectSw`, `ELEC_StandbyPowerSelector`,
`ELEC_BusTransSw_AUTO` ya viajan con `parameter: "$value"`, ver sección de
arriba). Lo que NO sincroniza es puramente la animación visual de la tapa
física, que ni el SDK expone como estado legible ni la implementación de
referencia del proyecto intenta sincronizar. Se actualizaron los comentarios
`semantics` de los 4 controles en `controls/electrical.yaml` (antes decían
solo "Guard ... not modeled", ahora documentan explícitamente que es una
limitación confirmada por diseño, con la fuente exacta, para que un futuro
agente no intente "arreglarlo" adivinando una secuencia de eventos sin
evidencia). Si en el futuro el usuario reporta que el switch mismo (no la
tapa) no sincroniza para alguno de estos 4 controles, eso SÍ sería un bug real
nuevo a investigar por separado.

`dotnet build SimulatorBridge.sln` y `dotnet test tests/SimulatorBridge.Tests`
pasan tras estos cambios. `python3 tools/validate_profiles.py` pasa para los
dos perfiles del repo.

## ACTUALIZACIÓN 2026-07-27 (sesión aircraft-profiles-agent) — EGPWS/inhibidores, panel de radio, fire protection panel: TODOS bloqueados por offset no transcrito; master caution/fire warn/ovht det SÍ agregados (offset ya existía)

Pedido del usuario en esta sesión: ground proximity (EGPWS), flap/gear/terr
inhibit, panel bright/flood bright/main panel bright/upper-lower/inbd-outbd DU
bright, panel de radio (selector), wx rdr, ovht det, test fault/fire, engine
ext test, master caution, fire warn.

**Ya cubiertos antes de esta sesión, sin cambios necesarios** (se verificó
`controls/lights.yaml` antes de asumir que faltaban): panel bright
(`lights.main_panel_knob_capt/fo` -> `LTS_MainPanelKnob`), flood bright
(`lights.background_knob` -> `LTS_BackgroundKnob`, `lights.afds_flood_knob` ->
`LTS_AFDSFloodKnob`), upper DU bright (`lights.upper_du_brt_knob`), lower DU
bright (`lights.lower_du_brt_knob`, `lights.lower_du_map_brt_knob`), inbd DU
bright (`lights.inbd_du_brt_knob_capt/fo`, `lights.inbd_du_map_brt_knob_capt/
fo`), outbd DU bright (`lights.outbd_du_brt_knob_capt/fo`). Los 20 controles
ya existían `readOnly: true` de la sesión anterior (extensión del layout
hasta `LTS_LowerDUMapBrtKnob`). No se tocaron.

**Agregados NUEVOS esta sesión, `controls/warnings.yaml` (readOnly, sin
extender el layout — offset ya transcrito)**: `warnings.annun_fire_warn_1/2`
(`WARN_annunFIRE_WARN[2]`), `warnings.annun_master_caution_1/2`
(`WARN_annunMASTER_CAUTION[2]`), `warnings.annun_ovht_det`
(`WARN_annunOVHT_DET`) — los 3 viven en la sección "Warnings" del
glareshield (`PMDG_NG3_SDK.h` líneas 313-327), que ya estaba completamente
transcrita en `PmdgNg3DataLayout.cs` (entre `LTS_WheelWellSw` y
`EFIS_MinsSelBARO`) desde la sesión de EFIS/lights, solo que nunca se había
usado para agregar controles de este tramo salvo `warnings.annun_pseu`
(que en realidad vive en otro campo, `WARN_annunPSEU`, en
`controls/cabin-misc.yaml`). No hizo falta escalar nada al bridge para
estos 3.

Quedaron `readOnly: true` a propósito, NO por falta de offset sino por la
regla anti-TOGGLE: existen candidatos de Event ID de escritura
(`EVT_FIRE_WARN_LIGHT_LEFT`=THIRD_PARTY_EVENT_ID_MIN+347,
`EVT_FIRE_WARN_LIGHT_RIGHT`=+439, `EVT_MASTER_CAUTION_LIGHT_LEFT`=+348,
`EVT_MASTER_CAUTION_LIGHT_RIGHT`=+438), pero el comentario original del
header dice literalmente "MASTER CAUTION Light Left Switch **Toggle**" /
"Master Fire Warning (FIRE WARN) Light Left Switch **Toggle**" — exactamente
el patrón que la regla anti-TOGGLE del proyecto prohíbe. `WARN_annunOVHT_DET`
no tiene ni candidato: es solo el anunciador, no hay Event ID de "sets ovht
det annunciator" en el header (el switch físico real es un campo distinto,
ver más abajo, "Fire protection panel").

**Bloqueado por offset NO transcrito en `PmdgNg3DataLayout.cs`** (todos viven
DESPUÉS de `LTS_LowerDUMapBrtKnob`, el último campo transcrito — requiere
escalar a simconnect-bridge-agent/wasm-agent para extender `OrderedFields`
antes de poder agregar ningún `read`):

- **EGPWS / inhibidores** (`PMDG_NG3_SDK.h` líneas 432-435, justo después del
  tramo `LTS_*BrtKnob`, offset acumulado inmediato tras `LTS_LowerDUMapBrtKnob`):
  `GPWS_annunINOP` (bool, "ground proximity" -- único candidato de anunciador
  de sistema EGPWS en todo el struct, no existe un switch de "GPWS ON/OFF"
  separado), `GPWS_FlapInhibitSw_NORM` (bool), `GPWS_GearInhibitSw_NORM`
  (bool), `GPWS_TerrInhibitSw_NORM` (bool). Candidatos de escritura
  calculados (sección "// GPWS" del header, sin comentario que confirme
  semántica, offset = THIRD_PARTY_EVENT_ID_MIN + N):
  `EVT_GPWS_SYS_TEST_BTN`=+500 (candidato para el botón de test del sistema,
  no para `GPWS_annunINOP` directamente -- no hay campo "test switch"
  separado en el struct, solo el anunciador INOP resultante),
  `EVT_GPWS_FLAP_INHIBIT_SWITCH`=+501 (+ `EVT_GPWS_FLAP_INHIBIT_GUARD`=+502,
  guarda física del switch, evento separado),
  `EVT_GPWS_GEAR_INHIBIT_SWITCH`=+503 (+ `_GUARD`=+504),
  `EVT_GPWS_TERR_INHIBIT_SWITCH`=+505 (+ `_GUARD`=+506). Ninguno tiene
  comentario original en el header (a diferencia de los `EVT_MCP_*_SET` que
  sí decían "Sets..."), mismo nivel de evidencia débil que EFIS/DU selector
  documentado en la entrada anterior de este archivo -- aun si se extendiera
  el layout, estos 4 controles nacerían `readOnly: true`, no read+write.
- **Panel de radio (selector de micrófono)**: `COMM_SelectedMic[3]`
  (`PMDG_NG3_SDK.h` línea 450, "array: 0=capt, 1=F/O, 2=observer... 0=VHF1
  1=VHF2 2=VHF3 3=HF1 4=HF2 5=FLT 6=SVC 7=PA"), justo dentro del mismo tramo
  no transcrito (después de `GPWS_TerrInhibitSw_NORM`, antes de `CDU_*`).
  Además de bloqueado por offset, el mecanismo de escritura real
  (`EVT_ACP_CAPT_MIC_VHF1`=+734, `..._MIC_VHF2`=+735, `..._MIC_FLT`=+736,
  `..._MIC_SVC`=+737, `..._MIC_PA`=+738, y variantes `..._MIC_VHF3`/`HF1`/
  `HF2` "out of order" +877/878/879) es un botón MOMENTÁNEO POR ESTACIÓN
  (7-8 Event IDs distintos, uno por posición), no un solo Event con parámetro
  de posición como `LTS_LandingLtRetractableSw` -- representarlo como UN
  control con `write` único no encaja con el patrón `parameter: "$value"`
  usado en el resto del perfil; requeriría un diseño nuevo (7-8 controles
  "botón momentáneo" tipo `mcdu.*`, o extender el esquema con un mapa
  valor->evento). Documentado aquí para decidir en conjunto con el
  orchestrator, no se inventó nada.
- **Fire protection panel** (`PMDG_NG3_SDK.h` líneas 457-467, sección "Control
  Stand" del struct, muy por delante del tramo GPWS/COMM anterior):
  `FIRE_OvhtDetSw[2]` (uchar, "0: A  1: NORMAL  2: B" -- el switch físico de
  "ovht det" pedido por el usuario, distinto del anunciador
  `WARN_annunOVHT_DET` ya agregado), `FIRE_DetTestSw` (uchar, "0: FAULT/INOP
  1: neutral  2: OVHT/FIRE" -- corresponde a "test fault/fire"),
  `FIRE_ExtinguisherTestSw` (uchar, "0: 1  1: neutral  2: 2" -- corresponde a
  "engine ext test"). Candidatos de escritura calculados (sección "// Fire
  protection panel"): `EVT_FIRE_OVHT_DET_SWITCH_1`=+694,
  `EVT_FIRE_OVHT_DET_SWITCH_2`=+705, `EVT_FIRE_DETECTION_TEST_SWITCH`=+696,
  `EVT_FIRE_EXTINGUISHER_TEST_SWITCH`=+715 -- ninguno tiene comentario
  original, mismo nivel de evidencia débil que el grupo GPWS de arriba.
- **Wx rdr (radar meteorológico)**: NO se encontró NINGÚN campo en todo
  `PMDG_NG3_Data` para modo/tilt/ganancia del radar meteorológico (a
  diferencia de todos los casos anteriores, que sí tienen un campo de
  lectura pendiente de transcribir). Solo existen Event IDs
  (`EVT_WXR_L_TFR/WX/MAP/GC/AUTO/TEST`=+790/791/792/793/917/918,
  `EVT_WXR_L_TILT_CONTROL/GAIN_CONTROL`=+794/923, y variantes `_R_*` para el
  lado FO) en la sección "// WX RADAR panel" del header, ninguno con
  comentario que confirme semántica. `TILT_CONTROL`/`GAIN_CONTROL` en
  particular tienen nombre de encoder rotativo (mismo patrón de riesgo que
  `circuit_breaker_knob`/`overhead_panel_knob`, ya descartados por prudencia
  en `lights.yaml` por sugerir pulso relativo) -- aun si apareciera un campo
  de lectura en una extensión futura del layout, estos dos NO deberían
  convertirse a write sin evidencia adicional de que sean SET absoluto, no
  rotación relativa. `EVT_WXR_L_WX`/`MAP`/`GC`/`TFR`/`AUTO`/`TEST` sí parecen
  selectores de modo tipo botón (tal vez seguros como readOnly en el futuro),
  pero sin ningún campo de struct que leer, no hay nada que agregar hoy ni
  siquiera como `readOnly: true`.

**Resumen de qué quedó funcional esta sesión:**

- **Read+write reales**: ninguno de los controles nuevos de esta sesión
  (regla anti-TOGGLE bloquea fire warn/master caution; ovht det no tiene
  Event ID de anunciador; los demás no tienen offset transcrito todavía).
- **Solo lectura (`readOnly: true`), nuevo en esta sesión**:
  `controls/warnings.yaml` (5 controles: `annun_fire_warn_1/2`,
  `annun_master_caution_1/2`, `annun_ovht_det`).
- **Ya existía, verificado sin cambios**: los 20 controles de brillo de panel
  (`lights.main_panel_knob_*`, `background_knob`, `afds_flood_knob`,
  `outbd_du_brt_knob_*`, `inbd_du_brt_knob_*`, `inbd_du_map_brt_knob_*`,
  `upper_du_brt_knob`, `lower_du_brt_knob`, `lower_du_map_brt_knob`) en
  `controls/lights.yaml` cubren TODOS los "bright" pedidos por el usuario.
- **Bloqueado, sin offset transcrito -- requiere escalar a
  simconnect-bridge-agent/wasm-agent para extender
  `PmdgNg3DataLayout.OrderedFields` más allá de `LTS_LowerDUMapBrtKnob`**:
  EGPWS/inhibidores (`GPWS_annunINOP`/`FlapInhibitSw_NORM`/
  `GearInhibitSw_NORM`/`TerrInhibitSw_NORM`), panel de radio
  (`COMM_SelectedMic[3]`, con complicación adicional de diseño de escritura
  por botón-por-estación), fire protection panel (`FIRE_OvhtDetSw[2]`,
  `FIRE_DetTestSw`, `FIRE_ExtinguisherTestSw`).
- **Sin evidencia suficiente ni siquiera para documentar un offset**: wx rdr
  (radar meteorológico) -- no existe campo de struct correspondiente en
  `PMDG_NG3_Data`, solo Event IDs de escritura sin comentario, dos de ellos
  con nombre de encoder rotativo (candidatos de riesgo anti-TOGGLE si
  alguna vez aparece un campo de lectura).

## ACTUALIZACIÓN 2026-07-27 (sesión posterior, simconnect-bridge-agent) — PmdgNg3DataLayout.cs extendido hasta LTS_LowerDUMapBrtKnob; EFIS/light test/DU selectors agregados readOnly; mcp_*_set SIGUEN bloqueados (motivo cambió)

Se extendió `PmdgNg3DataLayout.OrderedFields`
(`apps/simulator-bridge/src/SimulatorBridge/SimConnectInterop/PmdgNg3DataLayout.cs`)
desde `LTS_WheelWellSw` (línea 307 del header) hasta `LTS_LowerDUMapBrtKnob`
(línea 430), transcribiendo TODOS los campos intermedios en orden exacto
(sección "Glareshield" completa: `WARN_*`, `EFIS_*`, `MCP_*` completo,
`MAIN_*`, `HGS_*`, `LTS_*BrtKnob`). Se agregaron dos kinds nuevos a
`LayoutFieldKind` (`UShort`, `Short`, 2 bytes) para modelar
`MCP_Course`/`MCP_Heading`/`MCP_Altitude` (unsigned short) y
`MCP_VertSpeed` (short) -- necesarios para el offset correcto de los campos
siguientes, igual que ya se hacía con `Float`/`Int`. `dotnet build
SimulatorBridge.sln` y `dotnet test tests/SimulatorBridge.Tests` (44/44)
pasan sin romper ningún offset previo (solo se agregó después del último
campo ya transcrito, nunca se reordenó nada existente).

**Resultado real para los 7 controles `autopilot.mcp_*_set` (el objetivo
original de extender el layout): NINGUNO pudo convertirse a read+write.**
El offset ya existe para los 5 campos, pero:

- `mcp_crs_l_set`/`mcp_crs_r_set` (`MCP_Course[2]`), `mcp_hdg_set`
  (`MCP_Heading`), `mcp_alt_set` (`MCP_Altitude`), `mcp_vs_set`
  (`MCP_VertSpeed`): son `unsigned short`/`short` en el struct C real, y
  `packages/profile-schema/control.schema.json` -> `read.nativeType` no
  tiene ni "ushort" ni "short" en su enum (solo
  `["bool","uchar","uint","char_array","float","int"]`). Bloqueado por
  esquema -- **contrato compartido, requiere pasar por el orchestrator** (no
  se tocó `packages/profile-schema` en esta sesión, según la regla del
  proyecto). Antes de esta sesión el motivo documentado era "sin offset
  transcrito"; ahora el motivo real es "sin nativeType soportado para
  ushort/short" -- el hallazgo cambió, la conclusión práctica (siguen
  writeOnly) no.
- `mcp_ias_set`/`mcp_mach_set` (`MCP_IASMach`, `float`, SÍ soportado por el
  esquema): bloqueados por un motivo DISTINTO y más profundo -- el header
  documenta que este ÚNICO campo representa IAS o Mach según el modo activo
  del MCP ("Mach if < 10.0"), y no hay ningún campo de "modo" en el tramo
  transcrito que permita distinguir cuál de los dos es el valor real en un
  momento dado. Agregar `read` a ambos controles mostraría el mismo valor
  crudo en los dos, lo cual sería activamente engañoso (ej. "250" mostrado
  como IAS 250 en un control y como Mach 2.50 en el otro simultáneamente).
  Se deja como `writeOnly` a propósito.

**Sí se agregaron controles NUEVOS `readOnly: true`** (offset real, sin
Event ID con semántica de SET absoluto confirmada -- mismo criterio ya usado
para `lights.circuit_breaker_knob`/`overhead_panel_knob`):

- `controls/efis.yaml` (archivo nuevo, 20 controles): `EFIS_MinsSelBARO`,
  `EFIS_BaroSelHPA`, `EFIS_VORADFSel1`, `EFIS_VORADFSel2`, `EFIS_ModeSel`,
  `EFIS_RangeSel` (por lado CPT/FO, `readOnly: true`) +
  `MAIN_LightsSelector` (light test/brillo del panel DSP),
  `MAIN_MainPanelDUSel`, `MAIN_LowerDUSel` (selectores de fuente de DU, por
  lado CPT/FO), `MAIN_DisengageTestSelector` (por lado CPT/FO, hallazgo
  bonus). Candidatos de escritura calculados (`THIRD_PARTY_EVENT_ID_MIN +
  offset`) existen para los 4 tipos, pero NINGUNO tiene comentario en
  `EVT_EVENT_IDS_FULL.txt` que confirme "Sets X" -- solo nombran el switch
  físico (ej. "CAPT side MAIN PANEL DISPLAY UNITS (MAIN PANEL DUs)
  Selector"), mismo nivel de evidencia insuficiente ya documentado en la
  entrada anterior de este archivo ("ACTUALIZACIÓN 2026-07-27 — EFIS, Light
  Test, Main Panel DUs, Lower DU"). Esa entrada de abajo queda vigente en
  cuanto a candidatos de Event ID, solo cambia que ahora SÍ hay offset de
  lectura y por tanto SÍ se pudo agregar el control (en modo `readOnly`).
- `controls/lights.yaml` (+13 controles): `LTS_MainPanelKnob`,
  `LTS_BackgroundKnob`, `LTS_AFDSFloodKnob`, `LTS_OutbdDUBrtKnob`,
  `LTS_InbdDUBrtKnob`, `LTS_InbdDUMapBrtKnob`, `LTS_UpperDUBrtKnob`,
  `LTS_LowerDUBrtKnob`, `LTS_LowerDUMapBrtKnob` -- todas las perillas de
  brillo del panel inferior (por lado CPT/FO donde aplica), `readOnly: true`.
  Candidatos de escritura (`EVT_LWRMAIN_CAPT_*_BRT`/`EVT_LWRMAIN_FO_*_BRT`)
  NO tienen NINGÚN comentario en el header, evidencia todavía más débil que
  EFIS/DU selector.

`python3 tools/validate_profiles.py` (ejecutado con el intérprete disponible
en este entorno) pasa para los dos perfiles del repo tras estos cambios.

**Resumen de qué quedó funcional de punta a punta (read+write) vs. solo
lectura vs. bloqueado, tras esta sesión:**

- **Read+write reales, listos para usar entre jugadores**: NINGUNO de los
  controles tocados en esta sesión (ni `autopilot.mcp_*_set`, ni los nuevos
  de `efis.yaml`/`lights.yaml`). Los 7 `mcp_*_set` siguen `writeOnly: true`
  (motivo documentado arriba, ahora distinto para los 5 ushort/short vs. los
  2 float compartidos). Ningún control de esta sesión tenía ya un `write`
  esperando su `read` salvo los `mcp_*_set`, y esos siguen bloqueados.
- **Solo lectura (`readOnly: true`), nuevos en esta sesión**: los 20
  controles de `controls/efis.yaml` + los 13 nuevos de `controls/lights.yaml`
  (33 en total) -- se puede leer su estado real hoy (una vez confirmado el
  mecanismo de lectura contra MSFS real, pendiente para TODO el perfil, no
  específico de esta sesión), pero no escribirlos desde la cabina
  compartida.
- **Sigue bloqueado, sin cambio de estado**: los 7 `autopilot.mcp_*_set`
  (siguen `writeOnly: true`, ver motivo arriba); todo lo que ya estaba
  `readOnly: true`/bloqueado antes de esta sesión y no se tocó (radios,
  `circuit_breaker_knob`/`overhead_panel_knob`, campos float/int de
  needles/cantidades, etc. -- ver secciones más abajo de este archivo, sin
  cambios).

## ACTUALIZACIÓN 2026-07-27 (simconnect-bridge-agent) — soporte de "parameter dinámico" IMPLEMENTADO, tres bugs reales corregidos

Se investigaron y corrigieron 3 problemas reales de sincronización reportados
por Darwin (botones de cabina compartida que no sincronizaban entre
jugadores):

1. **`ground.parking_brake` (controls/overhead.yaml) — REMOVIDO, no arreglado
   in-place.** Usaba `write.type: inputEvent`, `name: "PARKING_BRAKE_SET"`,
   que NO es un K:event real de MSFS (el único evento estándar de parking
   brake es `PARKING_BRAKES`, un TOGGLE puro sin variante `_SET`) y, aunque lo
   fuera, el PMDG NG3 ignora K:events estándar de sus propios switches de
   cabina. La escritura se perdía en silencio → divergencia de estado entre
   jugadores. El perfil ya tenía el control correcto y confirmado en vivo
   para este mismo interruptor físico: `native_toggle.parking_brake_lever`
   (`controls/native-toggle-switches.yaml`, bus `ROTOR_BRAKE` param 69301 +
   lectura `L:switch_693_73X` vía `SharedCockpitBridge_LVars`). Se retiró el
   control roto de `overhead.yaml` en vez de dejarlo como un segundo id
   fantasma para el mismo switch físico.
2. **`lights.dome_white_sw` (controls/lights.yaml) — bug real de bridge,
   RESUELTO.** El control ya declaraba `write.type: clientDataEvent` con
   Event ID confirmado, pero `apps/simulator-bridge/.../Bridge/
   BridgeService.WriteClientDataEventControl` NUNCA recibía el valor real que
   el usuario estaba escribiendo -- siempre transmitía `Control.Parameter`
   fijo (0, por `ParseParameter(null)`), así que mover el selector de 3
   posiciones (DIM/OFF/BRIGHT) no tenía ningún efecto salvo casualmente
   coincidir con la posición 0. Mismo bug latente (más sutil, boolean 0/1) en
   `lights.taxi` y otros 11 controles de ese archivo.
3. **Soporte de "parameter dinámico" — IMPLEMENTADO en el bridge, sin tocar
   `packages/profile-schema`** (el esquema ya admitía `parameter` como
   `integer|string`, ver `control.schema.json`). Convención nueva:
   `write.parameter: "$value"` en el YAML del control indica que
   `Control.Parameter` debe sustituirse en tiempo de escritura por el valor
   ABSOLUTO que el cliente está fijando (0/1 para boolean, posición entera
   para number) en vez de un literal estático. Ver
   `BridgeService.ResolveWriteEventParameter`/`DynamicParameterPlaceholder` +
   tests en `BridgeServiceWriteParameterTests.cs`.

   **Corrección de alcance importante tras revisar el resto del perfil**: el
   gap no afectaba solo a `lights.dome_white_sw`/`lights.taxi` -- afectaba a
   TODOS los controles `write.type: clientDataEvent` de TODO el perfil (85
   controles reales fuera de `controls/mcdu.yaml`, contando comentarios
   descriptivos aparte), incluyendo controles que este mismo archivo daba por
   "readOnly, pendientes de activar" (`electrical.dc_meter_selector`,
   `electrical.ac_meter_selector`, `electrical.standby_power_selector`,
   `air.pack_switch_1`, `air.pack_switch_2`, `air.isolation_valve_switch`) --
   en realidad YA estaban activos (`write` presente, sin `readOnly: true`) en
   `controls/electrical.yaml`/`controls/air.yaml`, así que llevaban tiempo
   silenciosamente rotos en producción (siempre transmitían
   `Control.Parameter=0`), no "bloqueados a propósito" como decía esta nota
   antes de esta sesión. Se aplicó `parameter: "$value"` a los 99 controles
   `clientDataEvent` reales de todo el perfil que lo necesitaban (13 en
   `controls/lights.yaml`: taxi, dome_white_sw, emer_exit_selector,
   landing_lt_retractable_sw_1/2, landing_lt_fixed_sw_1/2,
   runway_turnoff_sw_1/2, position_sw, anti_collision_sw, wing_sw,
   wheel_well_sw; 14 en `electrical.yaml`; 4 en `hydraulics.yaml`; 14 en
   `fuel.yaml`; 25 en `air.yaml` -incluye pack_switch_1/2 e
   isolation_valve_switch-; 2 en `engine.yaml`; 6 en `cabin-misc.yaml`; 7 en
   `fms.yaml`; 5 en `flight-controls.yaml`). Los botones momentáneos de
   `controls/mcdu.yaml` (`parameter: 1` literal, 140 controles) NO se
   tocaron ni se ven afectados: solo se activa la sustitución dinámica
   cuando el valor declarado es exactamente la cadena `"$value"`.
   `tools/validate_profiles.py` y los 44 tests de
   `apps/simulator-bridge/tests/SimulatorBridge.Tests` pasan tras el cambio.

**Ya activos y ahora funcionales de punta a punta** (Event ID confirmado por
NOMBRE, sin confirmación EN VIVO contra MSFS+PMDG real todavía -- eso sigue
pendiente para TODO el perfil, no es nuevo de esta sesión):
`electrical.dc_meter_selector`, `electrical.ac_meter_selector`,
`electrical.standby_power_selector`, `air.pack_switch_1`, `air.pack_switch_2`,
`air.isolation_valve_switch`, y el resto de los 85 controles
`clientDataEvent` de `electrical/hydraulics/fuel/air/engine/cabin-misc/
fms/flight-controls.yaml`. El gap de "parameter dinámico" que los bloqueaba
YA NO existe.

**Siguen bloqueados de verdad (sin Event ID ni siquiera candidato):**
`lights.circuit_breaker_knob`/`lights.overhead_panel_knob` (candidatos con
comentario "...Decrease", riesgo de pulso relativo, se dejan `readOnly: true`
a propósito) y todo lo listado en la sección "Radios" más abajo -- ninguno
tiene Event ID de SET absoluto confirmado ni siquiera calculado. **Corrección
de esta sesión**: `fuel.crossfeed_sw` NO estaba bloqueado -- ya tenía Event ID
y bloque `write` (solo le faltaba `parameter: "$value"`, ya corregido arriba).
No existe un control dedicado "eng1/2 bus transfer" distinto de
`electrical.bus_trans_sw_auto` (ya corregido arriba, mismo gap) y
`native_toggle.bus_transfer_switch` (bus ROTOR_BRAKE, ya funcional desde
antes de esta sesión).

## ACTUALIZACIÓN 2026-07-27 — EFIS, Light Test, Main Panel DUs, Lower DU: investigados, NINGUNO agregado (sección "Glareshield en adelante" del struct, sin offset transcrito)

El usuario reportó estos 4 controles como candidatos a agregar al perfil. Se
revisaron las tres fuentes de siempre (`PMDG_NG3_SDK.h`,
`EVT_EVENT_IDS_FULL.txt`, `PmdgNg3DataLayout.cs`). Conclusión: **no se agregó
ningún control YAML nuevo** — hay evidencia de Event ID calculado para los 4,
pero ninguno cumple las dos condiciones que este perfil exige para agregar un
control real (offset transcrito + Event ID con comentario que confirme
semántica de SET absoluto). Detalle por control:

### 1. EFIS control panels (`EFIS_*`, struct línea 329-335 de `PMDG_NG3_SDK.h`)

Campos leíbles reales que existen en el struct (por lado CPT/FO, `[2]`):
`EFIS_MinsSelBARO` (bool), `EFIS_BaroSelHPA` (bool), `EFIS_VORADFSel1`/`Sel2`
(uchar, 0:VOR 1:OFF 2:ADF), `EFIS_ModeSel` (uchar, 0:APP 1:VOR 2:MAP 3:PLAN),
`EFIS_RangeSel` (uchar, 0:5...7:640). Candidatos de escritura (`THIRD_PARTY_EVENT_ID_MIN`
+ offset, `EVT_EVENT_IDS_FULL.txt` líneas 216-261):

| Campo | CPT `#define` | Valor CPT | FO `#define` | Valor FO |
|---|---|---|---|---|
| `EFIS_MinsSelBARO` | `EVT_EFIS_CPT_MINIMUMS_RADIO_BARO` | 69988 | `EVT_EFIS_FO_MINIMUMS_RADIO_BARO` | 70044 |
| `EFIS_BaroSelHPA` | `EVT_EFIS_CPT_BARO_IN_HPA` | 69998 | `EVT_EFIS_FO_BARO_IN_HPA` | 70054 |
| `EFIS_VORADFSel1` | `EVT_EFIS_CPT_VOR_ADF_SELECTOR_L` | 69990 | `EVT_EFIS_FO_VOR_ADF_SELECTOR_L` | 70046 |
| `EFIS_VORADFSel2` | `EVT_EFIS_CPT_VOR_ADF_SELECTOR_R` | 70000 | `EVT_EFIS_FO_VOR_ADF_SELECTOR_R` | 70056 |
| `EFIS_ModeSel` | `EVT_EFIS_CPT_MODE` | 69991 | `EVT_EFIS_FO_MODE` | 70047 |
| `EFIS_RangeSel` | `EVT_EFIS_CPT_RANGE` | 69993 | `EVT_EFIS_FO_RANGE` | 70049 |

Los nombres coinciden razonablemente bien con el campo (`MINIMUMS_RADIO_BARO`
↔ `MinsSelBARO`, `BARO_IN_HPA` ↔ `BaroSelHPA`, `VOR_ADF_SELECTOR_L/R` ↔
`VORADFSel1/2`, `MODE` ↔ `ModeSel`, `RANGE` ↔ `RangeSel`) y ninguno tiene
comentario de riesgo tipo "Decrease"/"wheel" — pero **ninguno tiene tampoco un
comentario que confirme explícitamente semántica de SET absoluto** (a
diferencia de `EVT_MCP_HDG_SET`, que sí dice literalmente "Sets new heading").
Además, y esto es lo que bloquea incluso una versión `writeOnly` como se hizo
con `autopilot.mcp_*_set`: **el resto de botones del panel EFIS
(`EVT_EFIS_CPT_MINIMUMS` propiamente dicho, `MINIMUMS_RST`, `MODE_CTR`,
`RANGE_TFC`, `FPV`, `MTRS`, `BARO`, `BARO_STD`, `WXR`, `STA`, `WPT`, `ARPT`,
`DATA`, `POS`, `TERR`) NO tienen ningún campo correspondiente visible en el
struct transcrito hasta ahora** — puede que existan más adelante en la
sección "Glareshield en adelante" (no revisada completa línea por línea en
esta pasada) o que simplemente no se reporten en `PMDG_NG3_Data` (solo se
puedan escribir, sin lectura de vuelta). No se puede declarar `read` para
ellos sin ese campo.

**Por qué no se agregó ni siquiera `writeOnly`**: se decidió exigir el mismo
nivel de evidencia que motivó agregar `autopilot.mcp_*_set` (Event ID con
comentario que confirme "Sets X"), no solo coincidencia de nombre — los 6
candidatos de la tabla de arriba no llegan a ese nivel. Que no haya riesgo
visible (`"Decrease"`) no es lo mismo que tener confirmación positiva.

### 2. Light test (`MAIN_LightsSelector`, struct línea 388)

`unsigned char MAIN_LightsSelector; // 0: TEST  1: BRT  2: DIM` — selector
único (no hay `[2]` por lado; coincide con que en el 737 real es un solo
switch físico en el panel de displays, no uno por piloto). Candidato:
`EVT_DSP_CPT_MASTER_LIGHTS_SWITCH = THIRD_PARTY_EVENT_ID_MIN + 346 = 69978`
(comentado en el header como `// MASTER LIGHTS & TEST switch`,
`EVT_EVENT_IDS_FULL.txt` línea 270). El campo `EVT_DSP_CPT_LAST` confirma que
es el último ítem del lado CPT del panel DSP (no hay un `EVT_DSP_FO_*`
equivalente, consistente con ser un switch único de cabina).

Mismo bloqueo que EFIS: (a) offset de `MAIN_LightsSelector` no está en
`PmdgNg3DataLayout.cs` (el tramo transcrito termina en `LTS_WheelWellSw`,
línea 307 del header; `MAIN_LightsSelector` está en la línea 388, dentro de
la sección "Glareshield en adelante" sin transcribir) — no se puede declarar
`read`; (b) el comentario del `#define` no dice "Sets X", solo nombra el
switch físico — mismo nivel de evidencia que los candidatos EFIS de arriba,
insuficiente para `writeOnly` bajo el criterio usado para `mcp_*_set`.

Hallazgo relacionado (no solicitado, no agregado, mismo bloqueo): un switch de
"test" hermano en el mismo bloque del struct, `MAIN_DisengageTestSelector[2]`
(`// 0: 1  1: OFF  2: 2`, línea 383) ↔ `EVT_DSP_CPT_DISENGAGE_TEST_SWITCH` /
`EVT_DSP_FO_DISENGAGE_TEST_SWITCH` (`// CAPT/FO side DISENGAGE LIGHTS TEST
switch`, offsets 342/442 → 69974/70074). Se deja anotado por si en el futuro
se retoma este bloque completo del struct.

### 3. Main panel DUs y 4. Lower DU (`MAIN_MainPanelDUSel[2]` / `MAIN_LowerDUSel[2]`, struct líneas 376-377)

```
unsigned char MAIN_MainPanelDUSel[2];  // 0: OUTBD PFD ... 4 MFD for Capt; reverse sequence for FO
unsigned char MAIN_LowerDUSel[2];      // 0: ENG PRI ... 2 ND for Capt; reverse sequence for FO
```

Estos son selectores de **fuente/reversión de pantalla** (qué se muestra en
cada DU), no perillas de brillo — el nombre del `#define` en el header
coincide literalmente, incluyendo el paréntesis, con la terminología que usó
el usuario:

| Campo | CPT `#define` (comentario original) | Valor CPT | FO `#define` | Valor FO |
|---|---|---|---|---|
| `MAIN_MainPanelDUSel` | `EVT_DSP_CPT_MAIN_DU_SELECTOR` — *"CAPT side MAIN PANEL DISPLAY UNITS (MAIN PANEL DUs) Selector"* | 69967 | `EVT_DSP_FO_MAIN_DU_SELECTOR` | 70072 |
| `MAIN_LowerDUSel` | `EVT_DSP_CPT_LOWER_DU_SELECTOR` — *"CAPT side LOWER DISPLAY UNIT (LOWER DU) Selector"* | 69968 | `EVT_DSP_FO_LOWER_DU_SELECTOR` | 70073 |

Es la coincidencia de nombre más fuerte de las cuatro (el comentario original
literalmente dice "(MAIN PANEL DUs)" y "(LOWER DU)"), pero sigue sin decir
"Sets X" y sigue en la misma zona sin offset transcrito (`MAIN_MainPanelDUSel`
línea 376, `MAIN_LowerDUSel` línea 377 — ambas después de `LTS_WheelWellSw`,
línea 307, límite del tramo transcrito en `PmdgNg3DataLayout.cs`). Se dejó
sin agregar por el mismo motivo que EFIS y Light Test.

**Nota aparte sobre brillo real de las DUs** (por si el usuario en realidad
se refería a brillo y no a selección de fuente): sí existen perillas de
brillo dedicadas en el struct — `LTS_MainPanelKnob[2]` (línea 422, "Position
0...150"), `LTS_OutbdDUBrtKnob[2]`, `LTS_InbdDUBrtKnob[2]`,
`LTS_InbdDUMapBrtKnob[2]`, `LTS_UpperDUBrtKnob`, `LTS_LowerDUBrtKnob`,
`LTS_LowerDUMapBrtKnob` (líneas 423-430) con candidatos `EVT_LWRMAIN_CAPT_*_BRT`
/ `EVT_LWRMAIN_FO_*_BRT` (offsets 328-338 y 507-510,
`EVT_EVENT_IDS_FULL.txt` líneas 1037-1053). Mismo bloqueo (sin offset
transcrito, sin comentario "Sets X" — de hecho estos NO tienen ningún
comentario en absoluto, ni siquiera el nombre coincide 1:1 con el campo salvo
por posición) — nivel de evidencia más débil todavía que los selectores de
fuente. Se documenta aquí para no perder el hallazgo si se retoma.

### Qué hace falta para cerrar estos 4 hallazgos

1. **wasm-agent / simconnect-bridge-agent**: extender
   `PmdgNg3DataLayout.OrderedFields` (`apps/simulator-bridge/src/
   SimulatorBridge/SimConnectInterop/PmdgNg3DataLayout.cs`) desde
   `LTS_WheelWellSw` (línea 307 del header) hasta al menos `LTS_LowerDUMapBrtKnob`
   (línea 430) — hay que transcribir TODOS los campos intermedios en orden
   exacto (incluye el bloque `MCP_*` completo, ya pendiente por la misma
   razón para `autopilot.mcp_*_set`) para que el offset acumulado sea
   correcto. Sin esto, ningún `read.field` de EFIS/Light Test/DU selector se
   puede declarar.
2. **EN VIVO** (MSFS + PMDG 737 abiertos): una vez transcrito el offset,
   confirmar lectura real del campo, y solo después probar cada candidato de
   escritura con `Control.Parameter` explícito (mismo checklist de "Cómo
   cerrar cada fila" al final de este archivo).
3. Ninguno de estos 4 requiere cambio de `packages/profile-schema` — todos
   los `nativeType` involucrados (`bool`, `uchar`) ya están soportados.

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
