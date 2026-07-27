# Plan — Full sync del PMDG 737 entre dos jugadores (2026-07-25)

## Quinta ronda — CORRECCIÓN IMPORTANTE: el PDF sí era legible (Darwin instaló poppler)

Las rondas anteriores concluyeron "solo 2-3 Event IDs de escritura
confirmados (taxi/logo/FD light)" y "el PDF no es legible en este sandbox
(falta `pdftoppm`/poppler)". **Esa conclusión era incompleta, no falsa**: era
correcta para el entorno de esa sesión, pero Darwin instaló poppler él mismo
(`winget install oschwartz10612.Poppler`) y extrajo el PDF completo a texto
(`apps/desktop-ui/Documentation/SDK/PMDG_737_MSFS_SDK.txt`, 1127 líneas) más
la lista completa de 1062 `#define EVT_*` del header
(`apps/desktop-ui/Documentation/SDK/EVT_EVENT_IDS_FULL.txt`). Con eso, esta
ronda encontró la regla real que rige TODOS los Event IDs, no solo 2-3:

> Manual del SDK, p.14: "All values below 8192 are treated as a numeric
> position to which the item being controlled should be placed... non-Boolean
> parameters will include position information in the comments" (ej.
> `unsigned char ELEC_BatSelector; // 0: OFF 1: BAT 2: ON`).

Es decir: **`PMDG_NG3_Control{Event,Parameter}` es el mecanismo genérico
oficial para los 1062 eventos**, y cualquier campo booleano o con posiciones
enumeradas documentadas es seguro de mapear como `write` absoluto (cumple
anti-TOGGLE). Solo los selectores continuos (heading/course/altitude
análogos, sin posiciones enumeradas) siguen requiriendo simulación de mouse
relativa — esos siguen excluidos, correctamente, con el mismo criterio de
anoche.

**Resultado de esta ronda (todo verificado, nada inventado):**

1. **Modelado del botón momentáneo del CDU aprobado por `orchestrator`**:
   protocolo sin cambios (`control.event` con `value: true` ya alcanza),
   pero `packages/profile-schema/control.schema.json` ganó `writeOnly: true`
   (simétrico a `readOnly`, permite un control sin `read`).
2. **89 controles subieron de solo-lectura a lectura+escritura real**
   (Event ID confirmado + campo de lectura ya existente), repartidos en
   `electrical` (14), `hydraulics` (4), `fuel` (14), `lights` (12), `fms` (7),
   `engine` (2), `cabin-misc` (6), `air` (25), `flight-controls` (5).
3. **147 controles `writeOnly` nuevos**: 140 botones del CDU/FMC
   (`controls/mcdu.yaml`, uno por cada `EVT_CDU_L_*`/`EVT_CDU_R_*` real del
   header) + 7 setters de MCP/autopiloto con semántica de SET absoluta
   documentada explícitamente en el manual.
4. **Radios revisados a fondo y correctamente descartados**: ~130 Event IDs
   `EVT_ACP_*/COM*/NAV*/ADF_*/SELCAL_*` no tienen semántica de SET absoluto
   documentada (varios son explícitamente relativos, "1000 added for volume
   rotation event") — no se mapeó nada ahí, documentado en
   `EVENT_IDS_PENDIENTES.md`, correcto no forzarlo.
5. **Descartes explícitos por prudencia** (candidatos posibles pero no
   confirmados al 100%, documentados en vez de adivinados): selectores de
   start/ignition/APU por posición en el header sin nombre inequívoco, un
   par de switches con comentario ambiguo tipo "...Decrease".
6. **Bug real #4 de la noche, atrapado antes de que Darwin lo viera**: igual
   que con `readOnly` en la ronda anterior, el deserializador C# no
   soportaba `writeOnly`/`read` opcional — habría reventado con
   `NotSupportedException`/`NullReferenceException` en cuanto el bridge
   intentara cargar `mcdu.yaml`. Corregido por `simconnect-bridge-agent`
   (mismo patrón: `Read` nullable, guardas en `BridgeService.cs`). Build
   limpio, `dotnet test`: **37/37 pass**, perfil completo del 737 (~230
   controles) confirmado cargando sin excepción.
7. **Tests ampliados** (`qa-agent`): schema de `writeOnly` cubierto
   (acepta/rechaza casos), auditoría anti-TOGGLE de los 230 controles
   `clientDataEvent`/`inputEvent` del 737 — **0 violaciones encontradas**.
   Todas las suites re-confirmadas en verde: Python 16/16, synchronization-core
   30/30, server/api 9/9, simulator-bridge 37/37.

**Capabilities**: se mantuvieron todas en `partial` (nunca `full`) — sería
deshonesto declarar `full` cuando quedan campos continuos sin mapear y,
sobre todo, cuando **nada de esto se ha probado ni una sola vez contra MSFS
real todavía**. El número de controles reales subió muchísimo (de ~230
solo-lectura a un mix de ~90 read+write reales + 147 writeOnly + los que ya
eran read+write de antes), pero "más controles declarados" no es lo mismo
que "capability full" sin la prueba en vivo.

**Sanity de esta ronda**: `git log` sigue en `0292dd6`, sin commits. Las
cuatro suites relevantes confirmadas en verde directamente (no solo
reportado por los agentes): Python, synchronization-core, server/api,
simulator-bridge.

**Lo que de verdad sigue sin poder hacerse sin MSFS real** (ahora es una
lista más corta y honesta, no por falta de información sino por naturaleza):
- Confirmar en vivo que el Parameter absoluto realmente mueve cada switch a
  la posición esperada (offsets/Event IDs correctos, sin errores de
  transcripción en 230 controles es mucho volumen para cero errores humanos).
- Los selectores continuos (heading/course/altitude análogos) — el mecanismo
  correcto ahí es simulación de mouse relativa, que es una implementación
  distinta (no mapeable como `clientDataEvent` simple), pendiente de diseño
  aparte si Darwin la quiere más adelante.
- El cliente C# de lectura del CDU (`PMDG_NG3_CDU_0/1`) — el scaffold de
  perfil/protocolo existe, pero nadie escribió el código que realmente lee
  la pantalla; los 140 botones de escritura SÍ están listos para probarse
  aunque la pantalla de respuesta visual todavía no se vea en la UI.

## Cuarta ronda — remapeo extendido + scaffold del CDU (madrugada)

Última instrucción de la noche: seguir remapeando el 737 sistema por sistema,
avanzar el diseño del CDU más allá de solo documentarlo, ampliar tests, y
revisar honestidad de la UI. Esto es lo que se cerró, hasta agotar de verdad
lo que se puede hacer sin MSFS real:

**Remapeo extendido del 737 (`aircraft-profiles-agent`):**
- Se agregaron ~180 controles `readOnly: true` reales nuevos (todos con
  offset confirmado en `PmdgNg3DataLayout.cs`, ninguno inventado) en archivos
  nuevos `controls/fms.yaml`, `controls/engine.yaml`, `controls/fuel.yaml`,
  `controls/air.yaml`, `controls/cabin-misc.yaml`, más ampliaciones de
  `flight-controls.yaml`, `autopilot.yaml`, `radios.yaml`, `lights.yaml`.
- **Segundo Event ID de escritura confirmado**: `EVT_OH_LIGHTS_LOGO = 69754`
  (del `.cpp` de ejemplo oficial), implementado como `lights.logo`. Se
  revisaron con cuidado `PMDG_NG3_ConnectionTest.cpp` y
  `PMDG_NG3_SDK_CDU_Test.cpp` completos — no hay más Event IDs de escritura
  determinística ahí. Se encontraron y **rechazaron correctamente** dos
  candidatos más (`EVT_MCP_FD_SWITCH_L`, `EVT_MCP_HEADING_SELECTOR`) por ser
  simulación de click/scroll de mouse, no `SET_VALUE` — violarían la regla
  anti-TOGGLE, así que no se implementaron.
- Capabilities subidas con evidencia real: `fuel` `none→partial` (solo
  lectura), `fms`/`air`/`cabinMisc` documentadas como `partial` solo-lectura
  (categorías sin key en el manifest schema, mismo precedente que `lights`).
  Ninguna subió a `full`.
- Gap real encontrado (no forzado): varios campos son `float`/`int` en el
  header (agujas de combustible, EGT del APU, presión de cabina) y el schema
  solo aceptaba `bool/uchar/uint/char_array` — el orchestrator lo amplió
  (aditivo) pero **no se convirtieron esos campos en controles todavía**
  (queda para la próxima ronda, es trabajo mecánico una vez el schema lo
  permite).

**Scaffold real del CDU (no solo diseño en papel):**
- `orchestrator`: mensaje `screen.snapshot` agregado a
  `packages/protocol/messages.schema.json`/`types.ts` (forma real:
  `sessionId, screenId, rows, cols, cells[{char,colorId,flags}], powered?,
  revision, origin?, timestamp?`), y `packages/profile-schema/screen.schema.json`
  nuevo para el recurso `screens/*.yaml`. Dimensiones reales confirmadas del
  header: **14 filas x 24 columnas**, 6 colores posibles, flags de
  fuente/reverse/dim.
- `aircraft-profiles-agent`: `aircraft-profiles/pmdg-737-900/screens/cdu.yaml`
  real, dos pantallas (`cdu_captain`/`PMDG_NG3_CDU_0`, `cdu_fo`/`PMDG_NG3_CDU_1`),
  ambas `readOnly: true` (sin escritura de botones, decisión intencional).
  `mcdu` subió de `none` a `partial` con el comentario honesto "solo
  lectura de pantalla, sin botones, sin FMC funcional".
- `sync-engine-agent`: `packages/synchronization-core` ahora sabe procesar
  `screen.snapshot` end-to-end (antes solo `LoopGuard` genérico lo protegía,
  pero `SyncEngine.applyIncomingMessage` no tenía rama explícita) —
  descarta snapshots viejos por revisión, deduplicado por `screenId`
  (capitán y primer oficial no se mezclan). 30/30 tests.
- **Lo que NO se hizo** (fuera de alcance explícito de esta ronda): no se
  escribió el lado C# que realmente lea `PMDG_NG3_CDU_0/1` — el scaffold es
  solo esquema + protocolo + definición de perfil, tal como se pidió
  ("andamiaje del lado de esquema/protocolo... no lo fuerces" si el código
  del bridge era demasiado riesgo sin poder probarlo). Implementar el
  cliente C# de lectura del CDU queda en el plan de la próxima sesión.

**Tres bugs reales más encontrados y corregidos esta ronda** (ninguno
inventado, todos con test o verificación directa):
1. `tools/validate_profiles.py` seguía crasheando (`AttributeError`
   distinto) si `screens/*.yaml` era un objeto suelto en vez de una lista —
   corregido directamente (guardas `isinstance` explícitas) y confirmado con
   `validate_profiles.py` real.
2. El test de `qa-agent` que documentaba ese bug (`@unittest.expectedFailure`)
   quedó desactualizado apenas se corrigió — se le quitó el marcador y ahora
   pasa en verde de verdad.
3. `SyncEngine` no tenía rama para `screen.snapshot` (ver arriba) — corregido
   por `sync-engine-agent`.

**Ampliación de tests (`qa-agent`):** `tests/profiles/test_screen_validator.py`
nuevo (positivo/negativo contra `screens/*.yaml` real y fixtures), test de
`LoopGuard` confirmando que también protege `screen.snapshot`, test C# nuevo
cubriendo las dos formas reales de escritura (`lights.taxi` vía
`clientDataEvent`, `lights.logo` vía `inputEvent` estándar — mezcla
intencional, no un bug).

**Revisión de honestidad de la UI (`frontend-agent`):** revisado a fondo,
**no se encontró nada que arreglar**. `Cockpit.tsx` ya renderiza todos los
controles del bridge como texto puro de solo lectura (no hay switches/botones
interactivos por control individual todavía en la UI, solo los botones de
sesión pedir/ceder control), así que no hay riesgo de "mentir" ofreciendo
interacción con algo `readOnly`. `Aircraft.tsx` ya lee capabilities
dinámicamente del backend real, sin nada hardcodeado. Confirmado con
`npm run build` limpio.

**Sanity final de esta ronda (verificado directamente):**
- `git log --oneline -1` → sigue en `0292dd6`, sin commits nuevos.
- `git status --porcelain` → 79 rutas modificadas/nuevas, nada en stage.
- `packages/synchronization-core`: `npm test` → **30/30 pass**.
- `server/api`: suite completa → **9/9 pass**.
- `tools/validate_profiles.py` (Python real) → **13/13 pass** (suite de
  tests) + validación de los dos perfiles reales, limpia.
- `apps/simulator-bridge`: `dotnet build` → 0 errores/0 warnings;
  `dotnet test` → **35/35 pass**.
- `apps/desktop-ui`: sin cambios necesarios esta ronda, build limpio
  reconfirmado por `frontend-agent`.

**Dónde de verdad se agotó lo que se puede hacer sin MSFS real** (límite
honesto, no forzado más):
- Más Event IDs de escritura del `PMDG_NG3_Control` — se revisó
  exhaustivamente todo el material de texto disponible (header completo,
  ambos `.cpp` de ejemplo); lo que falta está en el PDF (`PMDG_737_MSFS_SDK.pdf`,
  no legible en este sandbox por falta de `pdftoppm`/poppler) o solo se puede
  obtener probando en vivo: activar cada switch real en MSFS+PMDG y capturar
  qué Event ID dispara SimConnect.
- Los campos `float`/`int` recién habilitados en el schema no se convirtieron
  en controles — es trabajo mecánico seguro (mismo patrón que los ~180 ya
  agregados) pero se dejó pendiente para no seguir extendiendo el perfil sin
  que Darwin revise el volumen ya generado esta noche primero.
- El cliente C# de lectura del CDU (`PMDG_NG3_CDU_0/1`) — deliberadamente no
  escrito esta ronda, es la pieza de mayor riesgo/incertidumbre sin poder
  probar contra MSFS real.
- Todo lo de Client Data Area (offsets, los dos Event IDs, el struct del CDU)
  sigue sin una sola lectura/escritura real confirmada contra MSFS — la
  prueba de hoy con Darwin y su amigo es la primera vez que se corre de
  verdad.

> Trabajo nocturno autónomo. Todo lo de este documento está verificado contra
> el repo real o contra fuentes públicas citadas — nada está inventado. Los
> cambios de código quedaron en el working tree (`git diff`), sin commit,

## Actualización — segunda mitad de la noche (ejecución de los 7 pasos)

Darwin pidió seguir sin pausas por el resto de los pasos priorizados, invocando
los subagentes del repo de forma síncrona. Esto es lo que se completó, en
orden, cada uno con su subagente dueño de la carpeta correspondiente:

**Paso 3 (urgente) — conflicto de modelo de autoridad: RESUELTO.**
`orchestrator` revisó `server/api` (autoridad nueva de anoche,
`control_owner`/`control_requested_by` en Postgres) contra
`packages/synchronization-core` (`AuthorityManager`/`SyncEngine`, en memoria,
probado, pero **no conectado a ningún runtime real todavía** — hallazgo
propio del orchestrator). Decisión: modelo de dos capas, no compiten.
`server/api`/Postgres = fuente de verdad persistente de "quién es el dueño"
(sobrevive a reconexión). `synchronization-core` = motor de aplicación en
tiempo real dentro de cada proceso conectado, sembrado desde `server/api` al
conectar. Puente: `server/api` debe emitir el mensaje real `authority.transfer`
del protocolo (no solo su `session.state` custom) cuando cambia el dueño.
**No hizo falta tocar `packages/protocol`** — el mensaje ya alcanzaba.
`networking-agent` implementó los ajustes: `control_owner`/`control_requested_by`
ahora guardan `seat` (no `pilotName`, resuelto desde `session_participants`),
nueva columna `control_revision` incrementada atómicamente en `giveControls`,
y `server.ts` ahora emite `authority.transfer` real por WebSocket con la forma
exacta de `packages/protocol/types.ts`, dejando comentado que el relay
peer-to-peer existente y este flujo autoritativo no compiten.
Wiring pendiente identificado (no implementado, es trabajo de mañana): nadie
instancia `AuthorityManager`/`SyncEngine` en un proceso real todavía —
candidato natural es el bridge, ver "Pendiente" más abajo.

**Paso 1 — extensión de `packages/profile-schema`: APROBADO E IMPLEMENTADO.**
`orchestrator` (dueño de esa carpeta) agregó de forma aditiva/retrocompatible:
`read.type: clientDataArea` (`areaName`/`field`/`arrayIndex`/`nativeType`),
`write.type: clientDataEvent` (`areaName`/`event`/`parameter`/`semantics`
**obligatorio**, para mantener auditable la regla anti-TOGGLE), y
`sdkTier: standardSimConnect|clientDataArea` (default retrocompatible).
También reforzó `tools/validate_profiles.py` para rechazar `semantics` trivial
("toggle"/"toggles") y corrigió un bug de encoding UTF-8 latente en el mismo
script (fallaba en Windows con locale no-UTF-8 apenas hubiera un carácter
acentuado). Confirmado con `validate_profiles.py` real: `cessna-172` y
`pmdg-737-900` siguen pasando sin cambios — retrocompatibilidad real, no
teórica.

**Paso 2 (paso 4 original, adelantado por dependencia) — cliente de Client
Data Area: ESCRITO, NO PROBADO CONTRA MSFS REAL.**
`simconnect-bridge-agent` hizo dos partes:
- Deserialización: `ProfileYamlDto.cs`/`ProfileModels.cs`/`ProfileEnumMapper.cs`/
  `ProfileRepository.cs` ahora entienden las formas nuevas del schema,
  retrocompatibles (perfiles existentes deserializan igual que antes).
- Cliente nuevo: `SimConnectInterop/PmdgClientDataClient.cs` +
  `SimConnectInterop/PmdgNg3DataLayout.cs` — mapea `PMDG_NG3_Data` (offsets
  calculados a mano desde el header, cubren desde el inicio del struct hasta
  `LTS_WheelWellSw`, **no todo el struct**), escribe a `PMDG_NG3_Control`
  vía `{Event, Parameter}`. Solo un Event ID de escritura está confirmado
  simbólicamente del `.cpp` de ejemplo: `EVT_OH_LIGHTS_TAXI = 69749`
  (taxi light). Integrado en `Bridge/BridgeService.cs` con fallback seguro:
  si el cliente PMDG no conecta (EnableDataBroadcast no activo, PMDG no
  cargado), loggea warning y no rompe los controles `standardSimConnect`
  existentes. `dotnet build` no se pudo correr en este entorno (sin `dotnet`
  en PATH del sandbox) — revisado a mano línea por línea, no por compilador.
  **Requiere validación real en máquina de Darwin con MSFS + PMDG 737 +
  `EnableDataBroadcast=1` antes de confiar en cualquier offset o Event ID.**

**Paso 3 (paso 7 original) — cobertura de tests: HECHO, corrido de verdad.**
`qa-agent` agregó y **corrió** (no solo escribió):
- `server/api/test/db.test.ts` (9/9 pass, con un Postgres falso en memoria
  vía `t.mock.module` ya que no hay Postgres real en este entorno) — cubre
  el modelo de autoridad nuevo completo.
- `apps/simulator-bridge/tests/SimulatorBridge.Tests/ProfileYamlDeserializationTests.cs`
  (30/30 pass total con `dotnet test`, encontrado en
  `/c/Program Files/dotnet/dotnet.exe` — sí estaba disponible, solo no en
  PATH del shell bash).
- `tests/profiles/test_anti_toggle_validator.py` (6/6 pass, corrido con
  Python real en `C:\Users\darwi\AppData\Local\Programs\Python\Python312\python.exe`
  — el `python3`/`python` del PATH es un alias roto de Microsoft Store).
- Reconfirmó `packages/synchronization-core`: **27/27 pass** (no 18 como
  decía el README viejo — hay 9 tests más que anoche o que el README nunca
  contó bien), incluyendo el ciclo anti-reenvío de mensajes `origin: remote`.
- **Bug real encontrado y documentado con test (no corregido):**
  `leaveSession` en `server/api/src/db.ts` (~líneas 322-337) reasigna
  `control_owner` al seat del creador aunque el creador sea quien se está
  yendo y no quede nadie más conectado — debería quedar `null`/sin dueño.
  Pendiente de fix mañana (`networking-agent`).

**Paso 4 (paso 5 original) — remapeo del manifest del 737: BLOQUEADO CON
EVIDENCIA, no se inventó nada.**
`aircraft-profiles-agent` encontró dos bloqueos reales y no forzó ningún
control falso:
1. El schema nuevo exige `write` siempre (`required` a nivel de control) —
   **no existe todavía la opción de declarar un control solo-lectura**. La
   mayoría de los campos `ELEC_*`/`HYD_*` de PMDG son annunciadores/luces de
   solo lectura por naturaleza, así que esto bloquea subir `electrical` o
   `hydraulics` aunque haya offsets de lectura reales disponibles.
2. Solo hay **un** Event ID de escritura confirmado
   (`EVT_OH_LIGHTS_TAXI`, campo de luces, no de electrical/hydraulics) — no
   hay evidencia real para escribir nada en esos dos sistemas todavía.
   Resultado: `manifest.yaml`/`capabilities.yaml` del 737 **no cambiaron**
   (`electrical: partial`, `hydraulics: none` se mantienen, correctamente).
   Se documentaron en `aircraft-profiles/pmdg-737-900/controls/electrical.yaml`
   (comentarios) y `controls/hydraulics.yaml` (nuevo, lista vacía) los campos
   `ELEC_*`/`HYD_*` que sí tienen offset de lectura listo, para no tener que
   re-investigar el header mañana. `validate_profiles.py` confirmado pasando
   antes y después (sin controles nuevos que pudieran romperlo).

**Paso 5 (paso 6 original) — diseño del MCDU/CDU: propuesto abajo, sin
implementar** (ver sección nueva "Diseño propuesto: pantalla del CDU").

### Pendiente inmediato para mañana (ordenado)

1. Fix del bug de `leaveSession` encontrado por qa-agent (trivial, bajo
   riesgo) — `networking-agent`.
2. Decisión de orquestador: ¿permitir controles solo-lectura en
   `packages/profile-schema` (`write` opcional)? Sin esto, ningún
   annunciador de PMDG (la mayoría de lo que hay en `electrical`/`hydraulics`)
   es exponible nunca, tenga o no offset real.
3. Wiring real de `AuthorityManager`/`SyncEngine` dentro de un proceso —
   candidato natural: `apps/simulator-bridge`, ya que `desktop-ui` no
   escribe al simulador. Hoy sigue sin usarse en ningún runtime.
4. Conseguir más Event IDs de `PMDG_NG3_Control.Event` confirmados (hoy solo
   hay uno) — sin esto, la escritura vía Client Data Area sigue limitada a
   taxi light.
5. Validar en máquina real (Darwin, MSFS + PMDG 737 + `EnableDataBroadcast=1`):
   offsets de `PmdgNg3DataLayout.cs`, conexión de `PmdgClientDataClient.cs`,
   y compilación real con `dotnet build` (no se pudo confirmar en el sandbox
   de esta sesión, solo revisión manual línea por línea).

## Diseño propuesto: pantalla del CDU/MCDU (solo lectura primero)

No implementado esta noche — decisión de arquitectura de mayor riesgo, queda
para que el orquestador y Darwin la revisen juntos. El SDK expone
`PMDG_NG3_CDU_0`/`PMDG_NG3_CDU_1` como una Client Data Area separada de
`PMDG_NG3_Data`, con struct `PMDG_NG3_CDU_Screen` = arreglo de
`PMDG_NG3_CDU_Cell` (carácter + color de entre 6 valores + flags de
fuente/reverse/dim). Esto **no encaja** en el modelo actual de
`controls/*.yaml` ("un control = un id + un valor escalar sincronizable").

Propuesta concreta:

- Nuevo tipo de recurso a nivel de perfil, ej. `aircraft-profiles/pmdg-737-900/screens/cdu.yaml`,
  fuera de `controls/` (que sigue siendo solo para controles discretos/ejes).
  Declara `areaName: "PMDG_NG3_CDU_0"` (y su par `_1` para el segundo CDU),
  dimensiones de la grilla (filas x columnas, según el struct real), y
  `sdkTier: clientDataArea` obligatorio (no existe fallback estándar para
  esto).
- Mensaje de protocolo nuevo o extendido — **requiere orchestrator**, no
  encaja en `control.event` (es de-hecho un blob, no un valor discreto) ni
  en `control.axis` (no es continuo en el sentido de un eje). Candidato:
  `screen.snapshot` (canal confiable, baja frecuencia, solo cuando cambia la
  pantalla completa — el CDU no cambia a 20-60Hz) con el contenido serializado
  como array de celdas comprimible (muchas celdas suelen repetir espacio en
  blanco).
- **Empezar solo-lectura**: reflejar la pantalla del CDU del piloto en la
  UI del copiloto sin intentar escritura de botones todavía. Justificación:
  research de esta noche confirmó que la comunidad reporta eventos de botón
  del CDU no completamente documentados y excepciones
  (`SIMCONNECT_EXCEPTION_ILLEGAL_OPERATION`) al leer pantalla en ciertos
  estados — escribir botones sin la lista completa de Event IDs es alto
  riesgo de romper el FMC del avión en pleno vuelo. La lectura sola ya
  entrega valor real (el copiloto puede ver qué está haciendo el capitán en
  el FMC), que es explícitamente lo que Darwin pidió como objetivo.
- Escritura de botones del CDU queda fuera de alcance hasta tener Event IDs
  confirmados contra el sim real — no antes.

## Cierre final — tercera ronda (dejar listo para probar con MSFS real)

Última instrucción de la noche: "déjalo listo para conectarme con mi amigo y
probar todo en sim". Se cerraron los pendientes que sí eran completables sin
MSFS, y se verificó consistencia end-to-end real (no solo tests unitarios).

**Cerrado 100% esta ronda:**

1. **Bug de `leaveSession`** (documentado en la ronda anterior) — corregido
   por `networking-agent` en `server/api/src/db.ts`: si el dueño del control
   se va y no queda nadie más activo, `control_owner`/`control_requested_by`
   quedan `NULL` en vez de apuntar a un asiento desconectado. Test
   actualizado por `qa-agent` para afirmar el comportamiento correcto.
   Suite completa de `server/api` re-corrida: **9/9 pass**.
2. **Manifest del 737, con evidencia real** — se agregó `lights.taxi`
   (`aircraft-profiles/pmdg-737-900/controls/lights.yaml`), el único control
   de PMDG con Event ID de escritura confirmado (`EVT_OH_LIGHTS_TAXI =
   69749`, cruzado matemáticamente contra `THIRD_PARTY_EVENT_ID_MIN` del
   header como verificación adicional). No se pudo subir `capabilities` de
   `lights` porque esa categoría no existe en el enum de
   `packages/profile-schema/manifest.schema.json` — no se inventó.
3. **Controles solo-lectura desbloqueados** — el `orchestrator` hizo `write`
   opcional en `control.schema.json` (antes exigía siempre escritura,
   bloqueando cualquier indicador legítimamente solo-lectura) y agregó
   `readOnly: true` explícito y obligatorio cuando no hay `write`, con
   reglas `if/then` que impiden la contradicción "escribible y readOnly a la
   vez". Retrocompatibilidad confirmada con `validate_profiles.py` real.
   `aircraft-profiles-agent` usó esto para agregar **40 controles readOnly
   reales** en `electrical.yaml` y **10 en `hydraulics.yaml`** del 737 (solo
   los campos con offset ya confirmado en `PmdgNg3DataLayout.cs`, ninguno
   inventado) — `hydraulics` subió de `none` a `partial` **de solo
   lectura**, documentado explícitamente como tal en el manifest.
4. **Bug real de compilación evitado antes de que Darwin lo viera** —
   `simconnect-bridge-agent` confirmó que el deserializador C# (escrito
   ANTES de que existiera `readOnly`) habría lanzado `NotSupportedException`
   en tiempo de ejecución al cargar el perfil del 737 con los ~50 controles
   readOnly nuevos. Corregido: `Write` ahora es nullable en
   `ProfileYamlDto.cs`/`ProfileModels.cs`, `ReadOnly` se deserializa, y
   `BridgeService.cs` rechaza explícitamente cualquier intento de escribir a
   un control readOnly (antes había riesgo real de `NullReferenceException`).
   `dotnet build`: **0 errores**. `dotnet test`: **34/34 pass** (30 + 4
   nuevos, incluyendo carga real de `aircraft-profiles/pmdg-737-900` y
   `cessna-172` completos, no fixtures).
5. **Bug real de UI evitado antes de la prueba en vivo** — `frontend-agent`
   encontró que `views/Cockpit.tsx` seguía comparando
   `session?.controlOwner === pilotName` y mostrando el valor crudo en
   pantalla, roto por el cambio de anoche de `pilotName` a `seat`. Esto
   habría dejado los botones de pedir/ceder control completamente inútiles
   en la prueba de mañana. Corregido con un helper `seatOwnerLabel()` que
   resuelve seat → nombre de piloto para mostrar, y comparaciones contra
   `localParticipant.seat`. También se agregó manejo del mensaje
   `authority.transfer` en `useSessionSocket.ts` (no se procesaba antes).
   `npm run build`: **limpio, 0 errores**. `npm run dev`: arranca sin
   errores (confirmado sirviendo en `:5173`).
6. **Consistencia end-to-end confirmada por lectura directa** (no solo por
   agente aislado): el broadcast `authority.transfer` de `server/api`
   coincide campo por campo con `packages/protocol/types.ts`, y con lo que
   ahora `useSessionSocket.ts` espera. `apiClient.ts` ya enviaba el campo
   `sim` obligatorio (no hizo falta arreglarlo, solo se confirmó).
7. **Guía de prueba en vivo escrita**: `docs/GUIA-PRUEBA-EN-VIVO.md` — orden
   de arranque exacto (MSFS → bridge local por persona → app → crear/unirse
   sesión), el paso de `EnableDataBroadcast=1` en AMBAS máquinas explícito,
   y una sección honesta de "qué esperar que funcione" vs "qué no esperar
   todavía" (MCDU, y todo lo del SDK de PMDG sin probar en vivo).

**No se pudo hacer (límite real, no evitable sin MSFS+PMDG+Windows con
SimConnect real) — esto es exactamente lo que la prueba de mañana con su
amigo va a confirmar por primera vez:**

- Nadie ha confirmado que `PmdgClientDataClient.cs` conecta de verdad a la
  Client Data Area de PMDG — todo el trabajo de esta noche sobre Client Data
  Area (offsets, el único Event ID conocido, los 50 controles readOnly) está
  revisado a mano y compila, pero **cero bytes reales han sido leídos de
  `PMDG_NG3_Data` en este entorno**.
  No se pudo confirmar más allá de eso porque `pdftoppm`/poppler no está
  instalado en este sandbox — extraer más tablas del PDF requiere ese
  render o, más confiable, probar en vivo con Darwin activando switches
  reales y capturando qué Event ID dispara SimConnect.
- El wiring de `AuthorityManager`/`SyncEngine` (`packages/synchronization-core`)
  dentro de un proceso real (candidato: el bridge) sigue sin hacerse — el
  modelo de autoridad que SÍ va a probarse mañana es el de `server/api`
  (Postgres + `authority.transfer` por WebSocket), que es autosuficiente y
  correcto por sí solo para el MVP de dos jugadores; el motor en memoria
  queda como optimización de latencia para más adelante, no bloquea la
  prueba de mañana.
- No se puede confirmar que `SimConnect.dll` nativa + el flujo completo de
  conexión funcionan contra una instalación real de MSFS — es, honestamente,
  la primera vez en todo el proyecto que se va a probar de punta a punta.

**Sanity final (verificado directamente, no solo reportado por subagentes):**
- `git log --oneline -1` → sigue en `0292dd6`, ningún commit nuevo.
- `git status --porcelain` → 64 rutas modificadas/nuevas, todo en working
  tree, nada en stage, nada pusheado.
- `packages/synchronization-core`: `npm test` → **27/27 pass** (corrido
  directamente en esta sesión, no solo reportado).
- `server/api`: suite completa → **9/9 pass** (corrido directamente).
- `apps/simulator-bridge`: `dotnet test` → **34/34 pass** (reportado por
  simconnect-bridge-agent con build limpio confirmado).
- `apps/desktop-ui`: `npm run build` → limpio (reportado por frontend-agent).
> para revisar mañana.

## Resumen ejecutivo

El hallazgo más importante de esta sesión es que **el bloqueo de la Fase 7 ya no existe**: los archivos del SDK oficial de PMDG (`PMDG_NG3_SDK.h`, `PMDG_NG3_ConnectionTest.cpp`, `PMDG_NG3_SDK_CDU_Test.cpp`, `PMDG_737_MSFS_SDK.pdf`) están confirmados en
`apps/desktop-ui/Documentation/SDK/`. Verifiqué el header directamente: define
la Client Data Area `PMDG_NG3_Data` (telemetría, incluye secciones completas
de Electrical y Hydraulics — los dos sistemas que hoy están en `none` en el
manifest), una segunda área `PMDG_NG3_Control` con struct genérico
`{Event, Parameter}` para escribir (el mecanismo real de "apretar switches"),
y dos áreas de pantalla CDU (`PMDG_NG3_CDU_0/1`) con celdas de carácter +
color + flags. Esto es interop real basada en `EnableDataBroadcast=1`, no
ingeniería inversa — coincide con lo que confirma la comunidad (ver Research).

Hoy el perfil `pmdg-737-900` sigue usando solo SimConnect estándar
(`capabilities: partial/none` en todo, `hydraulics: none`, `mcdu: none`), y el
esquema de perfiles actual (`packages/profile-schema/control.schema.json`)
**no tiene todavía** un tipo de `read`/`write` para Client Data Area — solo
conoce `simvar/lvar/hvar` y `inputEvent/hvar/calculatorCode`. Es decir: el
avión ya no está bloqueado por falta de documentación, está bloqueado por
trabajo de ingeniería pendiente (extender el esquema + implementar el
cliente de Client Data Area en el bridge C#), que es justo lo que este plan
prioriza para mañana.

La distancia real a "full sync del 737" es de varios sprints, no de una
noche: hace falta ampliar `packages/profile-schema` (vía orchestrator),
escribir el cliente SimConnect Client Data Area en `apps/simulator-bridge`,
remapear el manifest del 737 con evidencia real de cada campo del SDK, y
decidir cómo se representa el CDU/MCDU (no encaja en el modelo actual de "un
control = un valor escalar"). Ninguna de esas piezas se tocó esta noche
porque todas requieren pasar por el orquestador o son decisiones de
arquitectura — se dejaron documentadas, no implementadas, tal como pedían las
reglas de esta sesión.

## Qué se implementó esta noche (verificado en el working tree, `git diff`)

Todo esto pasó `tools/validate_profiles.py` donde aplicaba y no toca
`packages/protocol/` ni `packages/profile-schema/`. Nada tiene TOGGLE crudo.

- **`aircraft-profiles/cessna-172/controls/engine.yaml` (nuevo)** — agregado
  por el subagente aircraft-profiles-agent: `engine.throttle`
  (`GENERAL ENG THROTTLE LEVER POSITION:1` / `THROTTLE1_SET`) y
  `engine.mixture` (`GENERAL ENG MIXTURE LEVER POSITION:1` / `MIXTURE1_SET`).
  Esto corrige un hueco real y grave: `capabilities.yaml` declaraba
  `engine: full` con throttle incluido, pero **no existía ningún control de
  throttle implementado** — el MVP (`docs/plan-maestro.md`) lo pide
  explícitamente como básico. `carb_heat`/`magnetos`/`starter` se dejaron
  fuera a propósito (switch combinado de 5 posiciones sin simvar de lectura
  simple confirmada — necesita prueba contra el sim real antes de adivinar).
- **`aircraft-profiles/cessna-172/controls/overhead.yaml`** — agregado
  `lights.panel` (`LIGHT PANEL` / `PANEL_LIGHTS_SET`), que `capabilities.yaml`
  ya afirmaba pero no existía.
- **`aircraft-profiles/cessna-172/capabilities.yaml`** — corregido `engine`
  de `level: full` (mentira parcial) a `level: partial` con
  `missing: [carb_heat, magnetos, starter]`, honesto con lo real.
- **`aircraft-profiles/{cessna-172,pmdg-737-900}/manifest.yaml`** —
  `compatibility.msfs2024` corregido de `true` a `false` en ambos (parece un
  bug de copy-paste previo; ninguno de los dos perfiles tiene overrides para
  MSFS2024 todavía).
- **`apps/simulator-bridge` (C#)** — arreglo de bug real: `Program.cs`
  asumía por defecto `SimulatorVersion.Msfs2024` cuando no había override por
  variable de entorno; ahora por defecto es `Msfs2020`, que es la única
  versión con perfiles reales. También se agregó `simulatorVersion` al
  mensaje `bridge.status` (`Protocol/Messages.cs`, `BridgeService.cs`) y
  cacheo del último status para reenviarlo a clientes WebSocket que se
  conectan tarde (`BridgeWebSocketServer.cs`) — antes un cliente que se unía
  después del primer broadcast se quedaba sin saber el estado.
- **`server/api` (Express + Postgres)** — se agregó soporte de sesión más
  completo: columna `sim` (msfs2020/msfs2024) validada contra la
  compatibilidad real del perfil al crear sesión, `closeSession`/
  `leaveSession`, y un primer modelo de autoridad de controles
  (`control_owner`/`control_requested_by`, `requestControls`/
  `giveControls`) en la tabla `sessions`.

  **Nota importante para revisar mañana:** esto es más que un arreglo trivial
  — es lógica de autoridad/transferencia de control, que conceptualmente es
  territorio de `packages/synchronization-core` (Fase 5 del plan maestro,
  "sync-engine-agent (autoridad)"). Se implementó del lado de `server/api`
  (networking) sin pasar por el orquestador porque no toca
  `packages/protocol/` directamente, pero **hay riesgo de que quede un
  segundo modelo de autoridad paralelo** al que ya vive en
  `packages/synchronization-core` si no se unifican. Recomiendo que el
  orquestador revise esto primero mañana, antes de construir más encima.

- **`CLAUDE.md`** — actualizado (vía skill `/init`) con arquitectura real,
  comandos de desarrollo por pieza, y la lista de huecos reales conocidos.
  Las reglas de negocio no negociables originales se preservaron intactas.

## Qué quedó solo documentado/propuesto (no implementado)

- **Extensión del esquema de perfiles** para Client Data Area — propuesta
  concreta de aircraft-profiles-agent (ver Plan #1 abajo). Requiere
  orchestrator porque toca `packages/profile-schema/`.
- **Cliente de Client Data Area en el bridge C#** — no se escribió código
  nuevo de SimConnect Client Data Area esta noche (es la pieza más grande y
  de mayor riesgo; se dejó para mañana con Darwin presente).
- **Remapeo del manifest del 737** con capabilities subidas a `full` — no se
  tocó `aircraft-profiles/pmdg-737-900/manifest.yaml` más allá del fix de
  `msfs2024`, porque subir capabilities requiere que el schema y el bridge
  soporten Client Data Area primero (si no, sería una promesa falsa como la
  que ya se corrigió en el Cessna).
- **Diseño de cómo representar el CDU/MCDU** (pantalla de celdas con color) —
  no encaja en el modelo actual de "un control = un valor escalar"; queda
  como decisión de arquitectura para el orquestador.

## Research de internet (con fuentes)

Confirmado con búsquedas reales (no supuesto):

- El mecanismo `EnableDataBroadcast=1` en el INI de opciones del PMDG 737 es
  el método oficial y documentado que usan herramientas de terceros
  (GoFlight, hardware de cockpit builders) para recibir datos del avión vía
  SimConnect — consistente con lo que dice `docs/plan-maestro.md` Fase 7 y
  con el propio SDK. Fuente: foro oficial de PMDG y PollyPot Software.
  [SDK EnableDataBroadcast=1 (PMDG forum)](https://forum.pmdg.com/forum/main-forum/pmdg-737-for-msfs/general-discussion-no-support/217246-sdk-enabledatabroadcast-1)
- Existen proyectos de la comunidad que ya hacen shared cockpit / sync
  multijugador y tienen soporte específico para la familia PMDG 737NG:
  **YourControls** (Rust, MSFS, tiene un perfil oficial-comunitario para
  PMDG 737NG desde su versión 2.7.6) y **FsCopilot**. Ninguno de los dos usa
  necesariamente la Client Data Area oficial para todo — YourControls
  históricamente sincroniza por LVars/simvars vía definiciones YAML por
  avión, no por el SDK propietario — así que no son un atajo directo, pero
  confirman que el enfoque de "perfil por avión con overrides" que ya usa
  este repo es el patrón correcto de la industria.
  [YourControls PMDG 737NG profile](https://flightsim.to/addon/102561/yourcontrols-shared-cockpit-fly-a-plane-together-profile-for-the-pmdg-737ng-family) ·
  [FsCopilot](https://github.com/yury-sch/FsCopilot) ·
  [Unofficial Shared Flight Deck for PMDG (AVSIM)](https://www.avsim.com/forums/topic/632568-unofficial-shared-flight-deck-for-pmdg/)
- **Limitación real confirmada**: el CDU/FMC vía SDK tiene problemas
  documentados por la comunidad — no hay una lista oficial de variables para
  los botones (hay que inferirlas), y algunos desarrolladores reportan
  `SIMCONNECT_EXCEPTION_ILLEGAL_OPERATION` (código 25) al intentar leer datos
  de pantalla en ciertas condiciones. Esto es coherente con lo que confirmé
  en el header: `PMDG_NG3_Control` es un struct genérico `{Event, Parameter}`
  sin una lista de constantes de `Event` documentada en el `.h` que yo haya
  visto completa (hay que sacarlas del PDF/ejemplos). Confirma que el MCDU
  completo bidireccional es la pieza de mayor riesgo técnico del proyecto,
  como ya advertía el plan maestro al excluirlo del MVP.
  [MSFS SDK / Receive FMC data (PMDG forum)](https://forum.pmdg.com/forum/main-forum/cockpit-builders/304106-msfs-sdk-receive-fmc-data) ·
  [Issues retrieving CDU text via SimConnect (FSDeveloper)](https://www.fsdeveloper.com/forum/threads/issues-retrieving-cdu-text-from-pmdg-737-ng3-using-simconnect.455478/)

## Plan priorizado para mañana

1. **Extender `packages/profile-schema` para soportar Client Data Area**
   — Agente: `orchestrator` (decide/aprueba el contrato) +
   `aircraft-profiles-agent` (implementa una vez aprobado).
   Complejidad: media. Por qué importa: es la base sin la cual nada del SDK
   de PMDG puede declararse en un manifest. Propuesta concreta ya lista (del
   subagente de esta noche): tipo de `read: clientDataArea` (con
   `name`/`field`/tipo C nativo, soporta arrays como `IRS_ModeSelector[2]`),
   tipo de `write: clientDataEvent` (con `name` del evento + `parameter`,
   respetando la regla anti-TOGGLE porque cada evento de PMDG ya tiene
   semántica de "set" explícita), y un flag por control tipo
   `sdkTier: clientDataArea | standardSimConnect` para fallback.

2. **Cliente SimConnect Client Data Area en el bridge** — Agente:
   `simconnect-bridge-agent`. Complejidad: alta. Por qué importa: es el
   componente que de verdad conecta con `PMDG_NG3_Data`/`PMDG_NG3_Control`/
   `PMDG_NG3_CDU_0/1` (`SimConnect_MapClientDataNameToID`,
   `SimConnect_AddToClientDataDefinition`,
   `SimConnect_RequestClientDataOnUserAircraft` para leer, y escribir vía
   `PMDG_NG3_Control{Event, Parameter}`). Referencia real disponible:
   `apps/desktop-ui/Documentation/SDK/PMDG_NG3_ConnectionTest.cpp` y
   `PMDG_NG3_SDK_CDU_Test.cpp` ya muestran el flujo completo en C++, hay que
   portarlo a C#/P-Invoke sobre `SimConnectNativeClient.cs` existente.
   Requiere MSFS + PMDG 737 instalados con `EnableDataBroadcast=1` para
   probar — no se puede validar en este entorno sandbox.

3. **Unificar el modelo de autoridad de controles** — Agente:
   `orchestrator` primero (revisar conflicto), luego `sync-engine-agent`.
   Complejidad: media. Por qué importa: esta noche `server/api` ganó un
   modelo de `control_owner`/`control_requested_by` en la tabla `sessions`
   que puede solaparse con la autoridad que ya vive en
   `packages/synchronization-core`. Antes de construir la UI de
   transferencia de controles del 737 (que tendrá muchos más grupos de
   control que el Cessna: hydraulics, electrical, autopilot, MCDU) hay que
   decidir cuál de los dos es la fuente de verdad.

4. **Remapear `aircraft-profiles/pmdg-737-900/manifest.yaml` con evidencia
   real del SDK** — Agente: `aircraft-profiles-agent`. Complejidad: alta
   (son ~1060 líneas de campos en el header, hay que ir sistema por
   sistema). Por qué importa: es el entregable visible para Darwin — subir
   `hydraulics`/`electrical`/`autopilot` de `none`/`partial` a `full` con
   controles reales, uno por uno, corriendo `validate_profiles.py` en cada
   tanda. Depende de los puntos 1 y 2 primero.

5. **Diseñar cómo representar el CDU/MCDU** — Agente: `orchestrator` +
   `aircraft-profiles-agent`. Complejidad: alta, mayor riesgo del proyecto.
   Por qué importa: es lo que Darwin más quiere ver (que el copiloto vea
   los botones del FMC), pero el SDK expone pantalla-como-texto-con-color,
   no una lista de campos con nombre — probablemente necesite un tipo de
   recurso nuevo (`screens/mcdu.yaml`) fuera del modelo actual de
   `controls/*.yaml`. Empezar por hacer el CDU de **solo lectura**
   (reflejar pantalla) antes de intentar escritura de botones, dado el
   problema confirmado por la comunidad de eventos de botón no documentados.

6. **Probar el bridge contra MSFS real** — Agente: `simconnect-bridge-agent`
   + Darwin (tiene que correr en su máquina con MSFS abierto). Complejidad:
   baja de código, pero bloqueante para validar todo lo demás — nada de esto
   se pudo probar en este entorno (no hay MSFS ni `dotnet` CLI accesible en
   este sandbox).

7. **Cobertura de tests para `apps/simulator-bridge` y `server/api`** —
   Agente: `qa-agent`. Complejidad: media. Por qué importa: `tests/` sigue
   vacío y `server/api` no tiene carpeta de tests automatizados — el modelo
   de autoridad nuevo de control_owner (punto 3) necesita tests antes de
   construir más encima, para no repetir el patrón de "declarado pero no
   probado" que ya se encontró y corrigió en el Cessna esta noche.

## Riesgos y bloqueos reales que quedan

- **MCDU/FMC bidireccional puede no ser viable al 100%** — la comunidad
  reporta que los eventos de botón del CDU no están completamente
  documentados y hay excepciones conocidas al leer pantalla en ciertos
  estados. Puede terminar siendo "CDU de solo lectura" en vez de full sync,
  al menos en una primera versión.
- **Nada de esto se puede probar en este entorno** — no hay MSFS, PMDG 737,
  ni `dotnet` CLI accesibles aquí. Todo el trabajo de los puntos 2, 4, 5 y 6
  del plan requiere la máquina de Darwin con el simulador abierto.
- **Posible colisión de modelos de autoridad** (ver punto 3) si no se
  revisa antes de seguir construyendo — riesgo introducido esta misma noche,
  hay que resolverlo temprano mañana.
- **`EnableDataBroadcast=1` es una configuración del lado del usuario** —
  hay que documentar en la UI/instalador que el jugador necesita activarlo
  en el INI de opciones del PMDG 737 para que el bridge nuevo funcione;
  si no está activo, debe caer con gracia al modo SimConnect estándar
  actual (de ahí la propuesta de `sdkTier` con fallback en el punto 1).
- **`packages/protocol` puede necesitar cambios** a mediano plazo si los
  datos de Client Data Area no caben bien en `control.event`/`control.axis`
  actuales (ej. bloques de CDU) — no se tocó esta noche, pero el orquestador
  debería evaluarlo al aprobar el punto 1.
