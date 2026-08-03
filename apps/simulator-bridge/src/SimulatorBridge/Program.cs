using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.IFlySdk;
using SharedCockpit.Bridge.Infrastructure;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using SharedCockpit.Bridge.SimConnectInterop;
using SharedCockpit.Bridge.Ws;

var log = new ConsoleLog();
log.Info("SharedCockpit.Bridge — Sprint 1 (Fase 1: detección + lectura/escritura básica)");

var runtimeConfig = BridgeConfiguration.Load(AppContext.BaseDirectory);
var bridgeConfig = runtimeConfig.Bridge;
var processDetector = new WindowsProcessDetector();
var iflyMonitor = new IFlySdkMonitor(
    bridgeConfig.Ifly,
    processDetector,
    new IFlyMemoryReader(),
    log,
    bridgeConfig.Diagnostics.LogEveryChange);

if (args.Any(arg => string.Equals(arg, "--ifly-sdk-inspector", StringComparison.OrdinalIgnoreCase)))
{
    using var inspectorMonitor = iflyMonitor;
    var inspector = new IFlySdkInspector(inspectorMonitor, bridgeConfig.Ifly, processDetector, log);
    Environment.ExitCode = inspector.Run();
    return;
}

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
//
// Este MISMO objeto también implementa ICalculatorCodeClient (ver
// Bridge/ICalculatorCodeClient.cs) y se inyecta más abajo como
// calculatorCodeClient -- confirmado en vivo (2026-07-27) que
// FSUIPCClientDLL.MSFSVariableServices.ExecuteCalculatorCode() SÍ funciona
// invocado desde este proceso externo, a través del módulo WASM/WAPI propio
// de FSUIPC7 (John Dowson's WASM module). REQUIERE que "FSUIPC_WAPID.dll"
// (en la instalación de Darwin: C:\FSUIPC7\Utils\FSUIPC_WAPID.dll) esté
// copiado junto a SharedCockpit.Bridge.exe en el directorio de salida -- si
// falta, MSFSVariableServices.Init()/Start() puede fallar o quedarse
// IsRunning=false indefinidamente, y los controles calculatorCode se
// reportan como BridgeError sin crashear el resto del bridge (ver
// FsuipcLVarClient.TryConnect/ExecuteCalculatorCode).
using var sharedCockpitWasmClient = new FsuipcLVarClient();
using var iflySdkClient = new IflySdkClient(AppContext.BaseDirectory);

// Polaridad de los controles posicionales aprendida en vuelo y acumulada entre
// sesiones (ver Bridge/PolarityCalibration.cs). Se guarda junto al resto del
// estado de la app de escritorio, no en el repo: es una medición de ESTA
// instalación, no parte del perfil.
var polarityCalibration = new PolarityCalibration(
    Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "we-connect-desktop-ui",
        "polarity-calibration.json"));

BridgeWebSocketServer? server = null;
var bridge = new BridgeService(
    simClient,
    profileRepo,
    log,
    message => server?.Broadcast(message),
    simVersion,
    iflySdkMonitor: iflyMonitor,
    pmdgClient: pmdgClient,
    sharedCockpitWasmClient: sharedCockpitWasmClient,
    iflyClient: iflySdkClient,
    // FsuipcLVarClient implementa también ICalculatorCodeClient (ver
    // ICalculatorCodeClient.cs) -- mismo objeto/conexión FSUIPC7 que ya se usa
    // para leer L-Vars, reutilizado para ejecutar calculator code (RPN) vía el
    // módulo WASM/WAPI de FSUIPC7. Confirmado en vivo el 2026-07-27 contra
    // MSFS 2024 + PMDG 737-900 real.
    calculatorCodeClient: sharedCockpitWasmClient,
    polarityCalibration: polarityCalibration);

// Token efímero opcional: We Connect (electron/main.cjs) lo genera al lanzar
// este proceso y lo exige en el handshake WebSocket. Lanzado a mano sin la
// variable, el bridge acepta clientes locales sin token, como siempre.
var bridgeToken = Environment.GetEnvironmentVariable("SHAREDCOCKPIT_BRIDGE_TOKEN");
if (!string.IsNullOrEmpty(bridgeToken))
{
    log.Info("Token de autenticación del bridge activo (SHAREDCOCKPIT_BRIDGE_TOKEN).");
}

server = new BridgeWebSocketServer(
    bridgeConfig.LocalWebSocket.Host,
    bridgeConfig.LocalWebSocket.Port,
    bridgeConfig.LocalWebSocket.AllowedOrigins,
    log,
    bridge.HandleIncoming,
    bridgeToken);
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
