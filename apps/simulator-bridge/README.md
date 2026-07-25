# SharedCockpit.Bridge (`apps/simulator-bridge`)

Fase 1 / Sprint 1 del plan maestro: proceso .NET 8 que se conecta a MSFS vía
SimConnect, detecta la aeronave cargada, lee/escribe los controles declarados
en `aircraft-profiles/*/controls/*.yaml`, y expone todo por WebSocket local en
`ws://localhost:7620` (puerto fijado en `docs/decisiones/web-first.md`).

## Estructura

```
apps/simulator-bridge/
├── SimulatorBridge.sln
├── src/SimulatorBridge/
│   ├── Program.cs                    # entry point, wiring
│   ├── Logging/                      # logging estructurado a stdout
│   ├── Protocol/                     # espejo C# de packages/protocol/types.ts
│   ├── Profiles/                     # carga aircraft-profiles/*.yaml + matching por título
│   ├── SimConnectInterop/            # P/Invoke nativo contra SimConnect.dll
│   ├── Bridge/                       # ISimConnectClient, BridgeService (orquestación), debounce
│   └── Ws/                           # servidor WebSocket local (HttpListener)
└── tests/SimulatorBridge.Tests/      # xUnit: matching de perfiles, forma de mensajes, debounce
```

## Cómo compilar

Requiere .NET 8 SDK (probado con 8.0.423) y Windows x64 (el proyecto fija
`PlatformTarget=x64` porque P/Invoke a `SimConnect.dll` nativa solo tiene
sentido ahí).

```
cd apps/simulator-bridge
dotnet build SimulatorBridge.sln
dotnet test tests/SimulatorBridge.Tests
```

Ambos comandos se corrieron en este entorno de desarrollo (sin MSFS ni
Windows con el SDK de MSFS instalado) y terminan en 0 errores / 24/24 tests
en verde.

## Cómo correrlo contra MSFS real

1. Copiar `SimConnect.dll` (la DLL nativa, NO el ensamblado administrado) al
   directorio de salida (`src/SimulatorBridge/bin/Debug/net8.0/`) o dejarla en
   el PATH. Se obtiene de:
   - La carpeta `SimConnect SDK/lib/` de la SDK oficial de MSFS (instalable
     desde el propio simulador: Opciones > General > Herramientas de
     desarrollador > Instalar SDK), o
   - La instalación de MSFS misma (varios add-ons ya la traen junto a su
     ejecutable).
2. `dotnet run --project src/SimulatorBridge` con MSFS abierto y un vuelo
   cargado.
3. El bridge imprime a stdout: intento de conexión, perfil detectado (o el
   aviso de que ningún perfil calzó), y cualquier excepción de SimConnect.
4. Conectar un cliente WebSocket a `ws://localhost:7620` para ver los mensajes
   `control.event` / `control.axis` / `bridge.status` / `bridge.error`.

Variables de entorno opcionales:
- `SHAREDCOCKPIT_PROFILES_DIR`: ruta explícita a `aircraft-profiles/` (por
  defecto se busca subiendo desde el directorio de ejecución).
- `SHAREDCOCKPIT_SIM_VERSION`: `2020` o `2024` (por defecto `2024`) — ver
  limitación abajo.

## Por qué P/Invoke nativo y no el paquete NuGet oficial

Microsoft distribuye el ensamblado administrado
`Microsoft.FlightSimulator.SimConnect.dll` únicamente junto con la SDK de
MSFS (instalador dentro del propio sim), **no** como paquete NuGet. Se
verificó en este entorno (con acceso a `api.nuget.org`) que no existe un
paquete oficial de Microsoft; solo wrappers de terceros (`CTrue.FsConnect`,
`SimConnect.NET`, `CsSimConnect`, etc.) que redistribuyen binarios de la SDK
sin ser la fuente oficial.

En vez de depender de un wrapper de terceros o de una referencia a un DLL que
no está presente en este entorno (lo que habría hecho que `dotnet build`
fallara aquí, o habría requerido fingir que compila), se implementó un
**P/Invoke directo contra la API C nativa de `SimConnect.dll`**
(`SimConnectInterop/NativeMethods.cs` + `SimConnectStructs.cs` +
`SimConnectEnums.cs`), reproduciendo a mano las firmas y estructuras públicas
y estables del SDK (`SimConnect_Open`, `SimConnect_AddToDataDefinition`,
`SimConnect_RequestDataOnSimObject`, `SimConnect_SetDataOnSimObject`,
`SimConnect_MapClientEventToSimEvent`, `SimConnect_TransmitClientEvent`,
`SimConnect_GetNextDispatch`, etc.). Esto:

- Compila limpio sin la DLL presente (un `[DllImport]` solo se resuelve en
  tiempo de ejecución, no en tiempo de compilación).
- No depende de licencias/binarios de terceros redistribuidos.
- Es real, no un mock: si se copia la `SimConnect.dll` nativa correcta junto
  al ejecutable con MSFS corriendo, este código intentará conectarse de
  verdad y leer/escribir simvars de verdad.
- Queda detrás de `ISimConnectClient` (`Bridge/ISimConnectClient.cs`) para
  poder sustituirlo por el ensamblado administrado oficial el día que se
  decida usarlo, sin tocar `BridgeService` ni los tests.

## Qué se pudo verificar en este entorno (sin MSFS/Windows con SimConnect)

- `dotnet build SimulatorBridge.sln` — compila sin errores ni advertencias.
- `dotnet test` — 24/24 pruebas en verde:
  - Carga real de `aircraft-profiles/cessna-172` y `aircraft-profiles/pmdg-737-900`
    (YAML real del repo, no fixtures inventados) y verificación de que
    `lights.beacon` / `ground.parking_brake` resuelven a los simvars/eventos
    esperados (`LIGHT BEACON` / `BEACON_LIGHTS_SET`,
    `BRAKE PARKING POSITION` / `PARKING_BRAKE_SET`).
  - Matching de perfil por `detection.yaml` (`titleContains`,
    `fallbackToPartialMatch`), incluyendo el caso "ningún perfil calza" (no
    debe adivinar un perfil por defecto).
  - Forma exacta de los mensajes salientes (`control.event`, `control.axis`)
    contra `packages/protocol/messages.schema.json` (nombres de campo, y que
    `origin` nunca se serializa).
  - Parseo de mensajes entrantes, siempre marcados `origin: remote`.
  - Regla anti-TOGGLE: ningún control de los dos perfiles reales usa un
    nombre de evento con "TOGGLE" cuando `write.type` es `inputEvent`.
  - Debounce por control (`ControlValueDebouncer`).

## Qué queda SIN verificar (requiere MSFS real en Windows)

Esto es honesto y deliberado — nada de lo siguiente se pudo probar en este
entorno de desarrollo:

1. **Que `SimConnect_Open` realmente conecte** con una instancia de MSFS
   corriendo. La lógica de reintento (`BridgeService.RunAsync`, intervalo de
   5s por defecto) nunca se ejecutó contra un simulador real.
2. **Que las firmas P/Invoke reproducidas a mano sean 100% correctas.** Se
   basan en el layout documentado y estable del `SimConnect.h` de la SDK
   (usado así por herramientas de código abierto de la comunidad desde FSX),
   pero no hay forma de confirmar aquí que el marshaling de
   `SIMCONNECT_RECV_SIMOBJECT_DATA` (lectura del payload variable tras la
   cabecera fija) sea correcto byte a byte sin recibir un mensaje real.
3. **Que los nombres de simvars/eventos de los perfiles (`LIGHT BEACON`,
   `BEACON_LIGHTS_SET`, `BRAKE PARKING POSITION`, `PARKING_BRAKE_SET`, etc.)
   efectivamente existan y se comporten así en MSFS 2020/2024** — eso es
   responsabilidad de aircraft-profiles-agent validarlo contra el sim real
   (ver notas en los propios YAML, especialmente el perfil PMDG que está
   marcado como PLACEHOLDER sin validar).
4. **Detección de título real.** Se usa el simvar `TITLE` (string) como
   variable de detección; no se pudo confirmar contra un MSFS real que ese
   sea el simvar correcto para cada aeronave (el comentario en
   `detection.yaml` menciona también `ATC MODEL` como alternativa — no se
   implementó fallback a esa variable en Sprint 1).
5. **Throttle** — el objetivo explícito del Sprint 1 ("Lee: beacon, parking
   brake, throttle") no tiene un control `engine.throttle` declarado todavía
   en `aircraft-profiles/cessna-172/controls/*.yaml` (no hay `controls/engine.yaml`).
   El bridge es genérico: leerá/escribirá throttle automáticamente en cuanto
   aircraft-profiles-agent declare ese control (no se tocó ningún YAML de
   perfil desde este agente, por estar fuera de su alcance). Ver "Pendiente"
   más abajo.
6. **Rendimiento real del canal rápido** (`control.axis`, 20-60Hz) — se pide
   un `SIMCONNECT_PERIOD_SIM_FRAME` por eje continuo, que en MSFS típicamente
   entrega datos a la tasa de fotogramas del sim (usualmente dentro de ese
   rango), pero no se pudo medir la tasa real entregada.
7. **HttpListener en `ws://localhost:7620`** — el binding y el handshake
   WebSocket usan APIs estándar de .NET, pero nunca se probó un cliente real
   (ej. `bridgeClient.ts`) conectándose de punta a punta.

## Limitaciones de diseño conocidas (documentadas en el código)

- `packages/profile-schema/control.schema.json` no declara una unidad
  SimConnect (`units`) por control; `BridgeService.SubscribeControls` usa un
  default razonable (`"Bool"` / `"Number"`) según `dataType`, que funciona
  para interruptores y la mayoría de valores simples pero no está
  garantizado para simvars que requieren una unidad específica distinta (ej.
  frecuencias de radio en BCD). Se recomienda evaluar con el orquestador si
  vale la pena agregar `units` al esquema de control.
- `read.type: lvar` / `hvar` y `write.type: hvar` / `calculatorCode` no se
  pueden resolver con las funciones estándar de SimConnect que usa este
  proceso — requieren ejecutar `execute_calculator_code` dentro de un gauge,
  que es responsabilidad de **wasm-agent** (ver
  `docs/plan-maestro.md` Fase 1: "Agentes: simconnect-bridge-agent,
  wasm-agent"). El bridge detecta esos casos y emite un `bridge.error`
  estructurado en vez de fallar en silencio o improvisar un TOGGLE.
- No hay detección automática de si el proceso conectado es MSFS2020 o
  MSFS2024; se puede forzar con `SHAREDCOCKPIT_SIM_VERSION`. Hoy es
  irrelevante porque `mappings/msfs2020.yaml` y `mappings/msfs2024.yaml` de
  los dos perfiles existentes tienen `overrides: []`, pero dejará de serlo en
  cuanto algún perfil declare una diferencia real entre versiones.

## Pendiente / siguiente paso sugerido

- Validar contra MSFS real (Windows + SDK de MSFS instalada) todo lo listado
  en "Qué queda sin verificar".
- Pedir a aircraft-profiles-agent que declare un control de throttle (ej.
  `engine.throttle1`) en `aircraft-profiles/cessna-172/controls/` para
  completar literalmente el ítem 3 del Sprint 1 ("Lee: beacon, parking
  brake, throttle") — el bridge ya lo soportará sin cambios de código en
  cuanto exista.
