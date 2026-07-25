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
// defecto se asume 2024. Hoy esto es casi irrelevante porque los overrides de
// mappings/msfs2020.yaml y msfs2024.yaml de los perfiles existentes están
// vacíos, pero se documenta como limitación conocida para cuando dejen de estarlo.
var simVersion = simVersionEnv == "2020" ? SimulatorVersion.Msfs2020 : SimulatorVersion.Msfs2024;

var profileRepo = new ProfileRepository(profilesRoot);
using var simClient = new SimConnectNativeClient();

BridgeWebSocketServer? server = null;
var bridge = new BridgeService(
    simClient,
    profileRepo,
    log,
    message => server?.Broadcast(message),
    simVersion);

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
