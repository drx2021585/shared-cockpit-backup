using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using SharedCockpit.Bridge.SimConnectInterop;
using SharedCockpit.Bridge.Ws;

var log = new ConsoleLog();
log.Info("SharedCockpit.Bridge — Sprint 1 (Fase 1: detección + lectura/escritura básica)");

const int Port = 7620; // ver docs/decisiones/web-first.md — puerto fijo acordado con desktop-ui.

var profilesRoot = Environment.GetEnvironmentVariable("SHAREDCOCKPIT_PROFILES_DIR")
    ?? ProfileRepository.DiscoverRoot(AppContext.BaseDirectory)
    ?? ProfileRepository.DiscoverRoot(Directory.GetCurrentDirectory());

if (profilesRoot is null)
{
    log.Error(
        "No se encontró aircraft-profiles/ subiendo desde el directorio de ejecución ni desde el directorio " +
        "actual. Defina la variable de entorno SHAREDCOCKPIT_PROFILES_DIR apuntando a la carpeta " +
        "aircraft-profiles del monorepo. El bridge no puede detectar ninguna aeronave sin perfiles.");
    profilesRoot = Path.Combine(Directory.GetCurrentDirectory(), "aircraft-profiles");
}
else
{
    log.Info($"aircraft-profiles/ resuelto en: {profilesRoot}");
}

var simVersionEnv = Environment.GetEnvironmentVariable("SHAREDCOCKPIT_SIM_VERSION");
// NOTA honesta: el bridge no auto-detecta todavía si el proceso conectado es
// MSFS2020 o MSFS2024 (SimConnect no expone esa distinción de forma directa y
// sencilla). Se puede forzar con SHAREDCOCKPIT_SIM_VERSION=2020|2024; por
// defecto se asume 2020, que es la versión compatible con los perfiles actuales.
// mappings/msfs2020.yaml y msfs2024.yaml de los perfiles existentes están
// vacíos, pero se documenta como limitación conocida para cuando dejen de estarlo.
var simVersion = simVersionEnv == "2024" ? SimulatorVersion.Msfs2024 : SimulatorVersion.Msfs2020;

var profileRepo = new ProfileRepository(profilesRoot);
using var simClient = new SimConnectNativeClient();

// Cliente opcional para controles sdkTier=clientDataArea (SDK de terceros, ej.
// PMDG NG3, ver SimConnectInterop/PmdgClientDataClient.cs). Se instancia siempre
// que este proceso corra en Windows con SimConnect.dll disponible; si el SDK de
// terceros no puede conectar (addon no cargado, EnableDataBroadcast=0, etc.),
// BridgeService hace fallback sin crashear (ver
// BridgeService.EnsurePmdgClientReady) — NO probado contra MSFS/PMDG real en
// este entorno de desarrollo, ver comentario de archivo en PmdgClientDataClient.cs.
using var pmdgClient = new PmdgClientDataClient();

// Cliente para el área "SharedCockpitBridge_LVars" -- hoy respaldado por
// FSUIPC7 (FsuipcLVarClient, vía FSUIPCConnection.ReadLVar), no por el
// módulo WASM propio (SharedCockpitWasmClient sigue en el repo, compilado y
// documentado, pero nunca se probó cargando de verdad en MSFS). FSUIPC7 ya
// está instalado y corriendo en la máquina de Darwin con su WAPI conectado
// (confirmado en vivo: 4265 L-Vars disponibles), mucho menor riesgo que
// confiar en un módulo WASM recién escrito. Mismo comportamiento de
// fallback seguro que pmdgClient: si FSUIPC7 no está corriendo, BridgeService
// omite esos controles con un warning sin crashear el resto del bridge.
using var sharedCockpitWasmClient = new FsuipcLVarClient();

BridgeWebSocketServer? server = null;
var bridge = new BridgeService(
    simClient,
    profileRepo,
    log,
    message => server?.Broadcast(message),
    simVersion,
    pmdgClient: pmdgClient,
    sharedCockpitWasmClient: sharedCockpitWasmClient);

server = new BridgeWebSocketServer(Port, log, bridge.HandleIncoming);
server.Start();

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    log.Info("Señal de apagado recibida, cerrando bridge...");
    cts.Cancel();
};

try
{
    await bridge.RunAsync(cts.Token);
}
catch (Exception ex)
{
    // Última red de seguridad: un proceso de fondo no debería terminar con un
    // stack trace crudo por una excepción no prevista en el loop principal.
    log.Error($"Error no manejado en el loop principal del bridge: {ex}");
}
finally
{
    await server.DisposeAsync();
    await bridge.DisposeAsync();
    log.Info("SharedCockpit.Bridge detenido.");
}
