# Guía de prueba en vivo — Shared Cockpit con tu amigo (2026-07-25)

> Para Darwin. Esto asume que ambos van a volar el **Cessna 172** o el
> **PMDG 737-900** en MSFS 2020, cada uno en su propia PC, conectados por
> internet. El backend (`server/api`) ya está desplegado en Railway — no
> necesitan levantarlo ustedes mismos salvo que algo falle ahí.

## 0. Qué esperar (honesto, para no sorprenderse a mitad de vuelo)

**Va a funcionar bien:**
- Crear sesión, unirse con código, ver quién está conectado.
- Cessna 172: yoke/rudder/trim/flaps (full), throttle/mixture (agregado
  anoche), luces de panel, freno de estacionamiento, la mayoría de
  interruptores del overhead ya declarados.
- PMDG 737-900: controles declarados como `partial` en `flightControls`,
  `autopilot`, `radios` (SimConnect estándar, ya probado con anterioridad).
- Transferencia de "quién tiene el control" (botón pedir/ceder controles) —
  reescrito y probado esta noche.

**NO va a funcionar / no lo intenten todavía:**
- **MCDU/FMC — pantalla visual**: hay 140 botones de escritura reales
  (`controls/mcdu.yaml`, uno por cada tecla del CDU: LSKs, números, EXEC,
  etc.) listos para probarse, PERO nadie escribió todavía el código que lee
  la pantalla de vuelta (`PMDG_NG3_CDU_0/1`) — así que pueden intentar
  "presionar" un botón del CDU, pero no van a VER el resultado en la
  pantalla desde la app todavía. Prueben esto solo si quieren confirmar que
  el mecanismo de escritura llega al sim (miren el CDU real dentro de MSFS
  para confirmar, no la app).
- **Selectores continuos** (heading/course/altitude tipo perilla) — el SDK
  de PMDG los controla por simulación de mouse relativa, no por un valor
  absoluto, así que a propósito NO se mapearon (mapear eso mal sería
  exactamente el tipo de bug de "estados invertidos" que la regla
  anti-TOGGLE existe para evitar). No están disponibles todavía.
- **Todo lo demás del SDK de PMDG (más de 300 controles nuevos entre
  lectura, lectura+escritura, y botones del CDU) — nunca probado contra
  MSFS real, ni una sola vez.** Esto incluye los 89 controles que ahora
  tienen escritura real (antes eran solo lectura) además de taxi/logo
  light. Pueden simplemente no aparecer o el bridge puede loggear un error
  y seguir sin ellos (fallback seguro confirmado en el código, pero no en
  vivo). Los controles de electrical que ya existían antes de esta noche
  (`battery`, `apu_master`, `avionics_master`) SÍ deberían seguir
  funcionando porque usan SimConnect estándar, no el SDK de PMDG.
- Nada del 737 debería "romper" el vuelo — todo lo nuevo del SDK tiene
  fallback seguro (si el cliente de Client Data Area no conecta, el bridge
  loggea un warning y sigue con los controles estándar, no crashea). Pero
  con este volumen de controles nuevos (~300), es esperable encontrar
  algunos offsets o Event IDs que no calcen exactamente — anótenlos, es
  exactamente la retroalimentación que hace falta para la próxima ronda.

**Corrección importante sobre lo que se dijo anoche**: se había concluido
"solo 2-3 Event IDs de escritura confirmados" porque el PDF del SDK no se
podía leer en el entorno de desarrollo (faltaba `poppler`). Darwin lo
instaló y extrajo el manual completo — resultó que el mecanismo de escritura
es genérico para los ~1062 eventos del header, no algo especial de 2-3
luces. Por eso esta sesión pudo subir tanto la cobertura de golpe. Ver
`docs/plan-737-fullsync-2026-07-25.md`, sección "Quinta ronda", para el
detalle completo.

## 1. Preparación (una sola vez, en cada PC)

### 1.1. En AMBAS máquinas (Darwin y su amigo)

1. MSFS 2020 instalado, con el Cessna 172 (de base) y/o PMDG 737-900
   instalado y activado.
2. **Solo si van a probar el 737 con el SDK nuevo**: activar la Client Data
   Area del addon. Buscar el archivo de opciones del PMDG 737
   (`737_Options.ini` o equivalente para MSFS, normalmente dentro de la
   carpeta de datos del addon) y agregar/confirmar:
   ```
   [SDK]
   EnableDataBroadcast=1
   ```
   Sin esto, el bridge simplemente no podrá leer/escribir nada vía Client
   Data Area (pero el resto del avión debería seguir funcionando por
   SimConnect estándar).
3. .NET 8 Runtime instalado (para correr `SharedCockpit.Bridge.exe`).
4. Clonar/tener este repo actualizado en la máquina.

### 1.2. Solo en la PC donde corre el bridge de cada quien

Cada jugador corre **su propio** `apps/simulator-bridge` contra **su propio**
MSFS — no es un servidor compartido, es un proceso local por persona.

```powershell
cd apps\simulator-bridge
dotnet build SimulatorBridge.sln
```

Debe terminar en 0 errores (confirmado esta noche en este entorno, sin
Windows+MSFS real — la compra real con MSFS abierto queda pendiente de que
ustedes la corran).

Para conectar con SimConnect real hace falta la DLL nativa `SimConnect.dll`
(no viene en este repo) — instrucciones completas en
`apps/simulator-bridge/README.md` sección "Cómo correrlo contra MSFS real".

## 2. Orden de arranque (por cada sesión de vuelo)

1. **Cada uno abre MSFS** y carga un vuelo con el avión elegido (Cessna 172
   o PMDG 737-900) — el bridge detecta el perfil por el título ATC del
   avión cargado, así que MSFS debe estar corriendo con el avión ya
   cargado antes de este paso.
2. **Cada uno corre su bridge local:**
   ```powershell
   cd apps\simulator-bridge
   dotnet run --project src\SimulatorBridge
   ```
   Debe imprimir en consola el intento de conexión y, si encuentra un
   perfil que calce, `Perfil detectado: 'cessna-172'` (o `pmdg-737-900`).
   Si dice "ningún perfil coincide", confirmen el título ATC exacto del
   avión cargado contra `aircraft-profiles/<id>/manifest.yaml` →
   `detection.titleContains`.
3. **Cada uno abre la app de escritorio** (`apps/desktop-ui`, empacada como
   "We Connect.exe", o `npm run dev` si van a correr desde código):
   - Se conecta automáticamente al backend en Railway (no hace falta que
     levanten `server/api` ustedes mismos — ya está desplegado).
   - Se conecta a su propio bridge local en `ws://localhost:7620`.
4. **Uno de los dos crea la sesión** (elige avión, elige MSFS2020, pone
   nombre de piloto y asiento — capitán o primer oficial) y comparte el
   código de sesión con el otro.
5. **El otro se une** con el código.
6. Ambos deberían ver el estado de sesión, participantes, y quién tiene el
   control ahora mismo (el creador arranca con el control).
7. Prueben pedir/ceder control desde la UI — esto usa el flujo nuevo de
   anoche (`request-controls`/`give-controls`, persistido en Postgres, con
   `authority.transfer` transmitido en tiempo real por WebSocket).
8. Muevan un control simple primero (ej. luces del panel en el Cessna, o
   flaps) para confirmar que la sincronización básica funciona antes de
   probar algo más complejo del 737.

## 3. Si algo falla

- **El bridge no encuentra `SimConnect.dll`**: ver
  `apps/simulator-bridge/README.md`, sección de instalación de la DLL
  nativa desde el SDK de MSFS o la carpeta del propio simulador.
- **El bridge dice "ningún perfil coincide"**: el título ATC real del avión
  no calza con `titleContains` del manifest — repórtenlo, es un dato fácil
  de corregir una vez que lo confirmen en vivo.
- **Los indicadores nuevos del 737 (electrical/hydraulics/taxi light) no
  aparecen o el bridge loggea errores sobre "PMDG client no pudo
  conectar"**: revisen que `EnableDataBroadcast=1` esté activo (paso 1.1) y
  que el addon esté cargado. Si sigue sin funcionar, no es bloqueante —
  todo lo demás del avión debería seguir sincronizando normal.
- **La creación de sesión falla con "invalid sim" o similar**: confirmen que
  la UI está actualizada (se corrigió anoche un caso donde faltaba el campo
  `sim` en algunos flujos).
- **Nada de esto se pudo probar contra MSFS/PMDG real en este entorno de
  desarrollo** — todo lo de esta sección es la mejor predicción posible
  basada en el código y el SDK, no una confirmación en vuelo. La primera
  vez que ustedes lo corran es, de hecho, la primera prueba real de punta a
  punta de todo el trabajo del SDK de esta noche.

## 4. Qué reportar de vuelta (para la siguiente sesión de trabajo)

- ¿El bridge conectó a SimConnect sin problema?
- ¿El perfil correcto se detectó automáticamente?
- ¿Los controles del Cessna 172 (throttle/mixture nuevos, luces) sincronizaron
  bien entre los dos?
- ¿El flujo de pedir/ceder control funcionó de punta a punta?
- Si probaron el 737 con `EnableDataBroadcast=1`: ¿el taxi light sincronizó?
  ¿aparecieron los indicadores de electrical/hydraulics nuevos, aunque sea
  de solo lectura?
- Cualquier Event ID de `PMDG_NG3_Control` que logren confirmar en vivo
  (activando un switch real y viendo qué evento dispara) — anótenlo, es
  exactamente lo que hace falta para desbloquear más controles escribibles
  del 737 (ver `aircraft-profiles/pmdg-737-900/EVENT_IDS_PENDIENTES.md`).
