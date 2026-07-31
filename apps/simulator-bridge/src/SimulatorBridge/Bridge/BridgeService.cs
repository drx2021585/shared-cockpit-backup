using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using SharedCockpit.Bridge.Protocol;

namespace SharedCockpit.Bridge.Bridge;

/// <summary>
/// Orquesta el ciclo de vida completo del bridge: conexión/reconexión a
/// SimConnect, detección de aeronave + selección de perfil, suscripción a los
/// controles declarados por el perfil activo, y traducción bidireccional entre
/// SimConnect y los mensajes de packages/protocol expuestos por el WebSocket
/// local. No conoce detalles de WebSocket ni de P/Invoke directamente (los
/// recibe inyectados), lo que permite probar el matching de perfiles y el
/// armado de mensajes sin una conexión real a MSFS (ver tests).
/// </summary>
public sealed class BridgeService : IAsyncDisposable
{
    private enum FlightCorrectionMode
    {
        Ground,
        Taxi,
        Airborne,
        Handoff,
    }

    private sealed record FlightPoseState(
        double Lat,
        double Lon,
        double Alt,
        double Pitch,
        double Bank,
        double Heading,
        double GroundSpeed,
        double IndicatedAirspeed,
        double VerticalSpeed);

    private sealed record RemoteFlightPoseTarget(
        FlightPoseState Pose,
        long Sequence,
        long ReceivedAtMs,
        bool RequiresSnap);

    private sealed record WriteOnlyTriggerMirror(string TriggerLVar, int CommandCode, ControlDefinition Control);

    private sealed record PendingWriteConfirmation(
        ControlDefinition Control,
        object DesiredValue,
        long StartedAtMs,
        long LastAttemptAtMs,
        int Attempts)
    {
        /// <summary>
        /// Distancia al valor pedido en la PRIMERA lectura observada tras la
        /// escritura (solo para dataType number). Es la referencia contra la que se
        /// juzga si el control se está ALEJANDO del destino -- ver
        /// ObserveConfirmedValue.
        ///
        /// Deliberadamente la primera y no la anterior: las L-Vars del iFly se
        /// ANIMAN (documentado en NOTAS-SDK.md: 14.75 observado en tránsito entre
        /// 20 y 10), así que un control correcto puede sobrepasar el destino y
        /// hacer crecer la distancia respecto de la lectura previa. Comparar contra
        /// la anterior confundía ese sobrepaso normal con una polaridad invertida.
        /// Contra la INICIAL no: un sobrepaso cerca del destino nunca supera la
        /// distancia de partida, mientras que un control que va al lado equivocado
        /// la supera en el primer paso.
        /// </summary>
        public double? InitialDistance { get; init; }

        /// <summary>
        /// ¿Llegó ALGUNA lectura de este control mientras la escritura estaba
        /// pendiente? Distingue dos fallos que hasta ahora se reportaban igual:
        /// "se movió pero no llegó a tiempo" (hubo lecturas) y "no se movió en
        /// absoluto" (ninguna), que es la firma de una polaridad invertida
        /// contra el tope. Ver ProcessPendingWriteConfirmations.
        /// </summary>
        public bool ObservedAnyReading { get; init; }
    }

    /// <summary>
    /// Sprint 1 no tiene concepto de sesión/multijugador todavía ("Resultado:
    /// app local que detecta MSFS y controla varios elementos, sin
    /// multijugador" — docs/plan-maestro.md Fase 1). sync-engine-agent
    /// asignará sessionId reales en Fase 2; hasta entonces se usa un
    /// placeholder estable para que la forma del mensaje ya sea válida contra
    /// el esquema (sessionId es requerido).
    /// </summary>
    public const string LocalSessionId = "local";

    private const string TitleKey = "__aircraft_title__";
    private const string SimSource = "bridge:sim";
    private const string PoseLatKey = "__flight_pose_lat__";
    private const string PoseLonKey = "__flight_pose_lon__";
    private const string PoseAltKey = "__flight_pose_alt__";
    private const string PosePitchKey = "__flight_pose_pitch__";
    private const string PoseBankKey = "__flight_pose_bank__";
    private const string PoseHeadingKey = "__flight_pose_heading__";
    private const string PoseGroundSpeedKey = "__flight_pose_ground_speed__";
    private const string PoseIndicatedAirspeedKey = "__flight_pose_ias__";
    private const string PoseVerticalSpeedKey = "__flight_pose_vertical_speed__";
    private const int FlightPoseBroadcastIntervalMs = 100;
    private const int FlightPoseCorrectionIntervalMs = 50;
    private const int FlightPoseMaxExtrapolationMs = 350;

    private readonly ISimConnectClient _sim;

    /// <summary>
    /// Cliente opcional para controles con sdkTier=clientDataArea (ej. PMDG NG3).
    /// Null en Sprint 1 salvo que Program.cs lo inyecte explícitamente. Ver
    /// SimConnectInterop/PmdgClientDataClient.cs para el estado de verificación
    /// (NO probado contra MSFS/PMDG real). Si es null, o si no logra conectar,
    /// los controles clientDataArea se omiten con un warning estructurado — NUNCA
    /// se crashea el bridge ni se afectan los controles standardSimConnect.
    /// </summary>
    private readonly IPmdgClientDataClient? _pmdgClient;

    /// <summary>
    /// Cliente para el área propia "SharedCockpitBridge_LVars" expuesta por
    /// simulator/wasm-bridge (módulo WASM propio del proyecto, no de PMDG — ver
    /// SimConnectInterop/SharedCockpitWasmClient.cs y la memoria del proyecto
    /// "decision_wasm_bridge_pmdg_sync"). Mismo patrón opcional/fallback-seguro
    /// que _pmdgClient: null o desconectado no crashea el bridge, solo omite
    /// esos controles con un warning.
    /// </summary>
    private readonly IPmdgClientDataClient? _sharedCockpitWasmClient;

    /// <summary>
    /// Ejecutor de calculator code (RPN) para controles write.type=calculatorCode
    /// (ej. flight.yoke.pitch/roll, flight.rudder en el 737 -- ver
    /// ICalculatorCodeClient para el detalle de la verificación en vivo). En
    /// Program.cs es el mismo objeto que _sharedCockpitWasmClient
    /// (FsuipcLVarClient implementa ambas interfaces), pero se modela como una
    /// dependencia separada para no acoplar BridgeService a esa implementación
    /// concreta ni a que ambas capacidades vengan siempre del mismo cliente.
    /// Null o no listo → se reporta BridgeError estructurado, nunca crashea ni
    /// hace fallback a un TOGGLE/escritura no explícita.
    /// </summary>
    private readonly ICalculatorCodeClient? _calculatorCodeClient;
    private bool _calculatorCodeUnavailableWarned;

    /// <summary>
    /// Polaridad real APRENDIDA de los controles posicionales, que el perfil no
    /// puede declarar con certeza porque no se deduce del modelo 3D (ver
    /// PolarityCalibration para el detalle completo del problema). Cuando el lazo
    /// de convergencia detecta que un control va al revés, el bridge invierte su
    /// RPN, reintenta y lo recuerda — en vez de rendirse, que es lo que hacía
    /// hasta la 0.1.13.
    /// </summary>
    private readonly PolarityCalibration _polarity;

    /// <summary>
    /// Contadores acumulados de esta sesión del bridge, para el reporte descargable
    /// de la UI (ver BridgeDiagnostics). Son deliberadamente crudos: lo que hace
    /// falta al diagnosticar es poder comparar órdenes de magnitud de un vistazo
    /// -- "1100 escrituras intentadas y 980 descartadas" dice inmediatamente que el
    /// filtro anti-avalancha está trabajando, y "129 fallidas de 140" dice que un
    /// perfil está roto en masa. Eso no se ve leyendo líneas de log.
    /// </summary>
    private int _writesAttempted;
    private int _writesSkippedAlreadyAtValue;
    private int _writesConfirmed;
    private int _writesFailed;
    private int _pulsePressesWritten;
    private int _errorsReported;

    private long _lastDiagnosticsAtMs;

    /// <summary>
    /// Único punto de salida hacia la UI local. Envuelve el Action inyectado para
    /// poder contar los bridge.error sin tener que acordarse de incrementar un
    /// contador en cada uno de los ~15 sitios que los emiten (y sin que un sitio
    /// nuevo se olvide de hacerlo). El total importa porque el buffer de la UI está
    /// acotado: si el contador es mayor que lo que trae el reporte, hubo truncado.
    /// </summary>
    private void Broadcast(JsonObject message)
    {
        if (message["type"]?.GetValue<string>() == "bridge.error")
        {
            _errorsReported++;
        }

        _broadcast(message);
    }

    /// <summary>
    /// Cada cuánto se emite bridge.diagnostics. 5 s es suficiente para que el
    /// reporte esté al día cuando el usuario pulse el botón, sin añadir tráfico
    /// notable al WebSocket local.
    /// </summary>
    private const int DiagnosticsIntervalMs = 5000;

    private readonly ProfileRepository _profileRepo;
    private readonly ILog _log;
    private readonly Action<JsonObject> _broadcast;
    private readonly SimulatorVersion _simVersion;
    private readonly string _appName;
    private readonly TimeSpan _reconnectInterval;
    private readonly TimeSpan _pumpInterval;
    private readonly ControlValueDebouncer _debouncer = new();

    private IReadOnlyList<AircraftProfile> _allProfiles = Array.Empty<AircraftProfile>();

    /// <summary>
    /// Carpetas de aircraft-profiles/ que existen en disco pero no se pudieron
    /// cargar. Se conserva para poder mencionarlas cuando falla la detección,
    /// no solo al arrancar (ver ReportProfilesThatFailedToLoad).
    /// </summary>
    private IReadOnlyList<string> _failedProfileIds = Array.Empty<string>();
    private AircraftProfile? _matchedProfile;
    private string? _lastTitle;
    private long _sequence;
    private bool _pmdgUnavailableWarned;
    private readonly Dictionary<string, PendingWriteConfirmation> _pendingWriteConfirmations = new();
    private readonly Dictionary<string, List<WriteOnlyTriggerMirror>> _writeOnlyTriggerMirrorsBySyntheticKey = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<WriteOnlyTriggerMirror>> _writeOnlyTriggerMirrorsByFieldAndCode = new(StringComparer.Ordinal);
    private readonly Dictionary<string, int> _writeOnlyTriggerEchoesToSuppress = new(StringComparer.Ordinal);
    private readonly HashSet<string> _writeOnlyTriggerDuplicateWarnings = new(StringComparer.Ordinal);
    private readonly HashSet<string> _writeOnlyTriggerAmbiguousKeys = new(StringComparer.Ordinal);

    /// <summary>
    /// Última (sequence, timestamp de llegada al bridge) observada por control
    /// para mensajes entrantes ORIGIN=REMOTE de controles authority=exclusive
    /// (ej. flight.yoke.pitch/roll, flight.rudder en el 737). Defensa en
    /// profundidad barata: el árbitro real de autoridad vive en server/api (ver
    /// contexto de la tarea), este diccionario NO bloquea ni decide nada, solo
    /// permite loggear como warning una señal de que el filtro de autoridad del
    /// servidor pudo haber fallado (dos mensajes del mismo control exclusivo con
    /// sequence decreciente llegando en rápida sucesión -- indicio de que se
    /// coló una escritura de un piloto sin autoridad vigente, sin dedupe).
    /// </summary>
    private readonly Dictionary<string, (long Sequence, long ObservedAtMs)> _lastExclusiveSequenceByControl = new();

    /// <summary>
    /// Ventana en la que una sequence decreciente para el mismo control
    /// exclusive se considera "rápida sucesión" (señal de filtro de autoridad
    /// del servidor posiblemente fallado) en vez de una reconexión/reset
    /// legítimo y lento de sesión. Puramente para clasificar el log, no cambia
    /// ningún comportamiento de escritura.
    /// </summary>
    private static readonly TimeSpan ExclusiveSequenceAnomalyWindow = TimeSpan.FromSeconds(2);
    private readonly Dictionary<string, double> _lastObservedPoseValues = new(StringComparer.Ordinal);
    private RemoteFlightPoseTarget? _remoteFlightPoseTarget;
    private long _lastFlightPoseBroadcastAtMs;
    private long _lastFlightPoseCorrectionAtMs;

    public BridgeService(
        ISimConnectClient sim,
        ProfileRepository profileRepo,
        ILog log,
        Action<JsonObject> broadcast,
        SimulatorVersion simVersion,
        string appName = "SharedCockpit.Bridge",
        TimeSpan? reconnectInterval = null,
        TimeSpan? pumpInterval = null,
        IPmdgClientDataClient? pmdgClient = null,
        IPmdgClientDataClient? sharedCockpitWasmClient = null,
        ICalculatorCodeClient? calculatorCodeClient = null,
        PolarityCalibration? polarityCalibration = null)
    {
        // Sin ruta de persistencia por defecto: en tests la calibración vive solo
        // en memoria. Program.cs inyecta la instancia que sí escribe a disco.
        _polarity = polarityCalibration ?? new PolarityCalibration();

        _sim = sim;
        _profileRepo = profileRepo;
        _log = log;
        _broadcast = broadcast;
        _simVersion = simVersion;
        _appName = appName;
        _reconnectInterval = reconnectInterval ?? TimeSpan.FromSeconds(5);
        _pumpInterval = pumpInterval ?? TimeSpan.FromMilliseconds(33);
        _pmdgClient = pmdgClient;
        _sharedCockpitWasmClient = sharedCockpitWasmClient;
        _calculatorCodeClient = calculatorCodeClient;

        _sim.Connected += OnConnected;
        _sim.Disconnected += OnDisconnected;
        _sim.SimConnectException += OnSimConnectException;
        _sim.NumericValueReceived += OnNumericValueReceived;
        _sim.StringValueReceived += OnStringValueReceived;

        if (_pmdgClient is not null)
        {
            _pmdgClient.Warning += OnPmdgWarning;
            _pmdgClient.FieldValueReceived += OnNumericValueReceived;
            _pmdgClient.StringFieldValueReceived += OnStringValueReceived;
            _pmdgClient.ScreenSnapshotReceived += OnScreenSnapshotReceived;
        }

        if (_sharedCockpitWasmClient is not null)
        {
            _sharedCockpitWasmClient.Warning += OnPmdgWarning;
            _sharedCockpitWasmClient.FieldValueReceived += OnNumericValueReceived;
            _sharedCockpitWasmClient.StringFieldValueReceived += OnStringValueReceived;
            _sharedCockpitWasmClient.ScreenSnapshotReceived += OnScreenSnapshotReceived;
        }
    }

    /// <summary>
    /// Un perfil que revienta al cargar (YAML mal formado, un enum que este
    /// binario todavía no conoce, etc.) NO tumba el bridge: ProfileRepository.LoadAll
    /// atrapa la excepción y sigue con los demás. El problema es que hasta acá eso
    /// dejaba UNA línea de log fácil de perder, y lo que veía el usuario después era
    /// un "no matching aircraft profile" que apunta al lugar equivocado (parece un
    /// problema de detección cuando en realidad el perfil ni se cargó).
    ///
    /// Caso real que motivó esto (2026-07-28): un `SharedCockpit.Bridge.exe`
    /// publicado antes de que ProfileEnumMapper soportara `nativeType: float`
    /// descartaba en silencio el perfil entero del iFly 737 MAX 8 y reportaba
    /// "no matching aircraft profile" con el avión correcto cargado.
    ///
    /// Comparar las carpetas que existen en disco contra las que efectivamente
    /// se cargaron es suficiente para nombrar las que fallaron, sin cambiar el
    /// contrato de ProfileRepository.
    /// </summary>
    private void ReportProfilesThatFailedToLoad()
    {
        var loaded = _allProfiles.Select(p => p.ProfileId).ToHashSet(StringComparer.Ordinal);
        var failed = _profileRepo.ListProfileIds().Where(id => !loaded.Contains(id)).ToArray();
        _failedProfileIds = failed;
        if (failed.Length == 0)
        {
            return;
        }

        var list = string.Join(", ", failed);
        _log.Error(
            $"Perfiles que NO se pudieron cargar y por lo tanto nunca van a detectarse: {list}. " +
            "Revise los errores de carga de más arriba en este log. Causa típica: el perfil declara algo " +
            "que este build del bridge todavía no soporta -- republicar el bridge suele resolverlo.");

        foreach (var id in failed)
        {
            Broadcast(BridgeError.Build(id, "load",
                $"el perfil '{id}' existe en aircraft-profiles/ pero no se pudo cargar; no se va a detectar " +
                "aunque la aeronave sea la correcta (ver logs del bridge para el motivo)"));
        }
    }

    public AircraftProfile? MatchedProfile => _matchedProfile;
    private string SimulatorVersionLabel =>
        _simVersion == SimulatorVersion.Msfs2020 ? "msfs2020" : "msfs2024";

    public async Task RunAsync(CancellationToken ct)
    {
        _allProfiles = _profileRepo.LoadAll(_simVersion, _log);
        _log.Info($"Perfiles cargados: {string.Join(", ", _allProfiles.Select(p => p.ProfileId))}");
        ReportProfilesThatFailedToLoad();

        while (!ct.IsCancellationRequested)
        {
            if (!_sim.IsConnected)
            {
                _log.Info("Buscando MSFS en ejecución...");
                var connected = _sim.TryConnect(_appName);
                if (!connected)
                {
                    Broadcast(BridgeStatus.Build(false, null, null, null, SimulatorVersionLabel));
                    try
                    {
                        await Task.Delay(_reconnectInterval, ct);
                    }
                    catch (TaskCanceledException)
                    {
                        break;
                    }

                    continue;
                }
            }

            // Cada Pump va aislado: el bridge es un proceso de fondo que la gente
            // deja corriendo un vuelo entero, y una excepción imprevista en UNO de
            // los clientes no puede llevarse puesto todo lo demás. Antes estas
            // llamadas estaban desnudas y cualquier fallo se escapaba hasta
            // Program.cs, que loguea y termina el proceso -- visto en vivo el
            // 2026-07-28 con el perfil del iFly (982 L-Vars, una sola inexistente
            // bastaba para tumbar el bridge en pleno vuelo).
            PumpSafely("simconnect", () => _sim.Pump());
            PumpSafely("client-data", () => _pmdgClient?.Pump());
            PumpSafely("lvars", () => _sharedCockpitWasmClient?.Pump());
            // Antes que las confirmaciones: si hay escrituras esperando su turno en
            // un trigger, conviene despacharlas ya para que la ventana de
            // confirmación de ese control corra con la escritura hecha, no con la
            // escritura todavía en cola.
            PumpSafely("trigger-queue", DrainDeferredTriggerWrites);
            PumpSafely("write-confirmations", ProcessPendingWriteConfirmations);
            PumpSafely("flight-pose-correction", ProcessRemoteFlightPoseCorrection);
            PumpSafely("diagnostics", EmitDiagnosticsIfDue);

            try
            {
                await Task.Delay(_pumpInterval, ct);
            }
            catch (TaskCanceledException)
            {
                break;
            }
        }

        _sim.Disconnect();
    }

    /// <summary>
    /// Nombres de las etapas de Pump que ya reportaron un fallo, para no repetir
    /// el mismo warning 30 veces por segundo.
    /// </summary>
    private readonly HashSet<string> _pumpStagesWarned = new(StringComparer.Ordinal);

    /// <summary>
    /// Ejecuta una etapa del ciclo de Pump sin dejar que una excepción imprevista
    /// termine el proceso. La etapa que falla se reporta UNA vez (log + BridgeError
    /// estructurado) y el ciclo sigue: es preferible un bridge con una etapa
    /// degradada que un bridge muerto a mitad de un vuelo compartido. Si la etapa
    /// se recupera sola, se vuelve a habilitar el aviso para el próximo fallo.
    /// </summary>
    private void PumpSafely(string stage, Action pump)
    {
        try
        {
            pump();
            _pumpStagesWarned.Remove(stage);
        }
        catch (Exception ex)
        {
            if (_pumpStagesWarned.Add(stage))
            {
                _log.Error($"Fallo en la etapa '{stage}' del ciclo del bridge: {ex}. Se continúa con el resto.");
                Broadcast(BridgeError.Build(stage, "pump", $"fallo en la etapa '{stage}': {ex.Message}"));
            }
        }
    }

    /// <summary>Aplica un mensaje entrante desde el WebSocket local (UI / sync-engine) escribiendo en el sim.</summary>
    public void HandleIncoming(IncomingMessage message)
    {
        switch (message)
        {
            case IncomingControlEvent ce:
                HandleIncomingControlEvent(ce);
                break;
            case IncomingControlAxis ca:
                HandleIncomingControlAxis(ca);
                break;
            case IncomingFlightPose fp:
                HandleIncomingFlightPose(fp);
                break;
            case IncomingUnknown unknown:
                _log.Debug($"Mensaje entrante de tipo no manejado por el bridge: '{unknown.RawType}'");
                break;
        }
    }

    private void HandleIncomingControlEvent(IncomingControlEvent ce)
    {
        // Regla no negociable (CLAUDE.md raíz): todo mensaje entrante por este
        // WebSocket ya viene marcado Origin=Remote desde IncomingMessageParser, y
        // se APLICA al sim (WriteControl) sin jamás reenviarse hacia _broadcast
        // como si fuera un cambio local nuevo -- lo único que sale por _broadcast
        // desde este flujo son BridgeError estructurados, nunca un eco del
        // control.event/control.axis recibido.
        var control = RequireControlForWrite(ce.ControlId);
        if (control is null)
        {
            return;
        }

        CheckExclusiveSequenceAnomaly(control, ce.Sequence, ce.Origin);

        object value = control.DataType switch
        {
            ControlDataType.Boolean => ce.AsBool(),
            ControlDataType.Number => ce.AsNumber(),
            ControlDataType.String => ce.AsString(),
            _ => ce.AsString(),
        };

        if (AlreadyAtValue(control, value))
        {
            _writesSkippedAlreadyAtValue++;
            return;
        }

        _writesAttempted++;
        if (WriteControl(control, value))
        {
            TrackPulseWrite(control, value);
            TrackWriteOnlyTriggerEcho(control, value);
            RegisterPendingWriteConfirmation(control, value);
        }
    }

    /// <summary>
    /// Última lectura conocida por control, para poder descartar escrituras que
    /// no cambiarían nada (ver AlreadyAtValue).
    /// </summary>
    private readonly Dictionary<string, object> _lastObservedByControl = new(StringComparer.Ordinal);

    private void HandleIncomingFlightPose(IncomingFlightPose pose)
    {
        var target = new FlightPoseState(
            pose.Lat,
            pose.Lon,
            pose.Alt,
            pose.Pitch,
            pose.Bank,
            NormalizeHeading(pose.Heading),
            pose.GroundSpeed,
            pose.IndicatedAirspeed,
            pose.VerticalSpeed);

        var requiresSnap = true;
        if (TryBuildCurrentFlightPoseState(out var current))
        {
            var initialTarget = new RemoteFlightPoseTarget(target, pose.Sequence, NowMs(), false);
            var mode = ResolveFlightCorrectionMode(current!, initialTarget);
            requiresSnap = ShouldSnapToPose(current!, target, mode);
        }

        _remoteFlightPoseTarget = new RemoteFlightPoseTarget(target, pose.Sequence, NowMs(), requiresSnap);

        if (requiresSnap)
        {
            ApplyFlightPose(target);
        }
    }

    /// <summary>
    /// ¿El control ya está en el valor que nos piden escribir? Entonces la
    /// escritura es un no-op y hay que SALTARLA, no ejecutarla y esperar a
    /// confirmarla.
    ///
    /// No es una micro-optimización: es lo que impide una avalancha al empezar
    /// una sesión. Medido en vivo el 2026-07-29 con dos jugadores reales — al
    /// conectar, el bridge del otro piloto emite el estado inicial de sus ~982
    /// controles, la UI los reenvía todos, y este bridge los escribía TODOS
    /// aunque la enorme mayoría ya estuviera en la misma posición (los dos
    /// aviones arrancan igual, en frío). Cada uno quedaba pendiente de
    /// confirmación y reintentaba 9-10 veces durante 6 s; como cada
    /// ExecuteCalculatorCode por FSUIPC cuesta ~650 ms y el canal es
    /// serializado, eso son ~1100 escrituras encoladas que tapan el camino
    /// durante minutos. Sintoma que reportó el usuario: "solo algunos botones
    /// funcionan". En el log quedaban 111 "no convergió" en UN segundo.
    ///
    /// Un control sin 'read' (writeOnly, ej. los botones momentáneos) nunca
    /// tiene lectura previa: siempre se escribe, que es lo correcto -- un
    /// pulso no tiene estado que comparar.
    /// </summary>
    private bool AlreadyAtValue(ControlDefinition control, object desiredValue)
    {
        if (control.WriteOnly || control.Read is null)
        {
            return false;
        }

        // Un pulso (botón momentáneo) NO deja el control en el valor pedido: se
        // pulsa y vuelve solo, así que comparar contra la última lectura no dice
        // nada útil. Pero tampoco se puede escribir SIEMPRE: los 580 pulsos del
        // iFly llegan todos en el estado inicial que emite el otro bridge al
        // conectar, y a ~650 ms por ExecuteCalculatorCode eso son ~6 minutos de
        // canal FSUIPC tapado -- exactamente la avalancha que arregló la 0.1.12.
        //
        // La regla correcta es por PARES: el "pulsar" siempre se ejecuta, y el
        // "soltar" solo si nosotros pulsamos antes. Así el pulso nunca queda a
        // medias (que era el bug: el soltar se descartaba y el botón se quedaba
        // hundido dentro del iFly) y el estado inicial no dispara nada, porque en
        // reposo todos los botones llegan sueltos.
        if (MomentaryPulse.IsPulseControl(control))
        {
            return !IsPulsePressRequested(desiredValue)
                && !_pulsesPressedByUs.Contains(control.Id);
        }

        if (!_lastObservedByControl.TryGetValue(control.Id, out var observed))
        {
            return false; // todavía no leímos este control: no hay con qué comparar
        }

        return ValuesEquivalent(control.DataType, desiredValue, observed);
    }

    /// <summary>
    /// Controles de tipo pulso que NOSOTROS pulsamos y todavía no soltamos. Es lo
    /// que permite ejecutar el "soltar" exactamente cuando cierra un par
    /// pulsar/soltar, y descartarlo en cualquier otro caso (sobre todo el estado
    /// inicial de los 580 pulsos al conectar). Ver AlreadyAtValue.
    /// </summary>
    private readonly HashSet<string> _pulsesPressedByUs = new(StringComparer.Ordinal);

    /// <summary>
    /// ¿El valor pedido para un control de tipo pulso significa PULSAR? El RPN de
    /// estos controles ramifica por `$value 0 &gt;`, así que la semántica es la
    /// misma para boolean (true) que para number (&gt; 0).
    /// </summary>
    private static bool IsPulsePressRequested(object desiredValue) => desiredValue switch
    {
        bool b => b,
        double d => d > 0d,
        _ => false,
    };

    /// <summary>
    /// Registra el lado del par pulsar/soltar que se acaba de ejecutar, para que
    /// AlreadyAtValue sepa si el siguiente "soltar" cierra un pulso real.
    /// </summary>
    private void TrackPulseWrite(ControlDefinition control, object writtenValue)
    {
        if (!MomentaryPulse.IsPulseControl(control))
        {
            return;
        }

        if (IsPulsePressRequested(writtenValue))
        {
            _pulsesPressedByUs.Add(control.Id);
            _pulsePressesWritten++;
        }
        else
        {
            _pulsesPressedByUs.Remove(control.Id);
        }

        // La lectura que provoque ESTA escritura es un eco, no un cambio local.
        _pulseEchoToSuppress[control.Id] = writtenValue;
    }

    private void TrackWriteOnlyTriggerEcho(ControlDefinition control, object writtenValue)
    {
        if (!control.WriteOnly || !IsPulsePressRequested(writtenValue))
        {
            return;
        }

        var mirror = _writeOnlyTriggerMirrorsByFieldAndCode.Values
            .SelectMany(static mirrors => mirrors)
            .FirstOrDefault(m => m.Control.Id == control.Id);
        if (mirror is null)
        {
            return;
        }

        var suppressKey = WriteOnlyTriggerFieldAndCodeKey(mirror.TriggerLVar, mirror.CommandCode);
        _writeOnlyTriggerEchoesToSuppress[suppressKey] =
            _writeOnlyTriggerEchoesToSuppress.TryGetValue(suppressKey, out var pending) ? pending + 1 : 1;
    }

    private void HandleIncomingControlAxis(IncomingControlAxis ca)
    {
        var control = RequireControlForWrite(ca.ControlId);
        if (control is null)
        {
            return;
        }

        CheckExclusiveSequenceAnomaly(control, ca.Sequence, ca.Origin);

        if (WriteControl(control, ca.Value))
        {
            RegisterPendingWriteConfirmation(control, ca.Value);
        }
    }

    /// <summary>
    /// Telemetría de diagnóstico pura (no bloquea ni decide autoridad -- eso vive
    /// en server/api, ver contexto de la tarea): para controles authority=exclusive
    /// (flight.yoke.pitch/roll, flight.rudder en el 737), registra un warning
    /// si una sequence decreciente para el MISMO control llega en rápida sucesión
    /// (menos de <see cref="ExclusiveSequenceAnomalyWindow"/> desde la última
    /// observada), lo que sugeriría que el gate de autoridad del servidor dejó
    /// pasar (sin dedupe) un mensaje de un piloto que no debería tener el control
    /// en ese instante. También reafirma explícitamente que el mensaje sigue
    /// marcado Origin=Remote en este punto -- nunca se trata como si fuera local.
    /// </summary>
    private void CheckExclusiveSequenceAnomaly(ControlDefinition control, long incomingSequence, MessageOrigin origin)
    {
        if (control.Authority != ControlAuthority.Exclusive)
        {
            return;
        }

        if (origin != MessageOrigin.Remote)
        {
            // No debería ocurrir nunca -- todo lo que llega por HandleIncoming
            // viene de IncomingMessageParser, que siempre asigna Remote. Se deja
            // como aserción loggeada en vez de silenciosa por si algún llamador
            // futuro rompe esa garantía.
            _log.Warn($"control exclusive '{control.Id}': mensaje entrante con Origin={origin} (se esperaba Remote) -- posible violación de la regla anti-eco del proyecto.");
        }

        var nowMs = NowMs();
        if (_lastExclusiveSequenceByControl.TryGetValue(control.Id, out var last))
        {
            var elapsed = TimeSpan.FromMilliseconds(nowMs - last.ObservedAtMs);
            if (incomingSequence < last.Sequence && elapsed <= ExclusiveSequenceAnomalyWindow)
            {
                _log.Warn(
                    $"control exclusive '{control.Id}': sequence decreciente en rápida sucesión " +
                    $"({incomingSequence} < {last.Sequence}, Δt={elapsed.TotalMilliseconds:F0}ms) -- posible fallo del " +
                    "filtro de autoridad/dedupe en server/api dejando pasar una escritura sin autoridad vigente. " +
                    "No se bloquea aquí (la decisión de autoridad es del servidor), solo se reporta para diagnóstico.");
            }
        }

        _lastExclusiveSequenceByControl[control.Id] = (incomingSequence, nowMs);
    }

    private ControlDefinition? RequireControlForWrite(string controlId)
    {
        if (_matchedProfile is null)
        {
            _log.Warn($"control recibido ('{controlId}') ignorado: no hay perfil de aeronave activo todavía");
            Broadcast(BridgeError.Build(controlId, "write", "no hay perfil de aeronave activo"));
            return null;
        }

        var control = _matchedProfile.FindControl(controlId);
        if (control is null)
        {
            _log.Warn($"control recibido ('{controlId}') no existe en el perfil activo '{_matchedProfile.ProfileId}'");
            Broadcast(BridgeError.Build(controlId, "write", $"control no declarado en el perfil '{_matchedProfile.ProfileId}'"));
            return null;
        }

        // Controles readOnly (ej. anunciadores del PMDG NG3 SDK) no declaran
        // 'write' en el perfil (control.Write es null) -- nunca se debe intentar
        // escribirlos, solo reportar el intento como error estructurado.
        if (control.ReadOnly || control.Write is null)
        {
            _log.Warn($"control recibido ('{controlId}') es readOnly en el perfil activo '{_matchedProfile.ProfileId}': se ignora la escritura");
            Broadcast(BridgeError.Build(controlId, "write", $"control '{controlId}' es de solo lectura (readOnly) en el perfil '{_matchedProfile.ProfileId}'"));
            return null;
        }

        return control;
    }

    private bool WriteControl(ControlDefinition control, object value)
    {
        // RequireControlForWrite ya garantiza que control.Write no es null (controles
        // readOnly se descartan ahí), pero se deja explícito por robustez ante
        // futuros llamadores directos de WriteControl.
        if (control.Write is null)
        {
            _log.Warn($"control '{control.Id}': intento de escritura sin bloque 'write' definido (readOnly). Se ignora.");
            Broadcast(BridgeError.Build(control.Id, "write", $"control '{control.Id}' no tiene 'write' definido (readOnly)"));
            return false;
        }

        switch (control.Write.Type)
        {
            case WriteType.InputEvent:
            {
                // SIEMPRE SET_ON/SET_OFF/SET_VALUE explícito -- nunca un pulso TOGGLE crudo
                // (regla de oro anti-toggle, ver CLAUDE.md raíz y packages/protocol/README.md).
                var (eventName, dwData) = ResolveInputEventPulse(control.Write.Name, control.DataType, value);
                _sim.TransmitSetEvent(eventName, dwData);
                return true;
            }

            case WriteType.Hvar:
                // H:vars siguen sin soporte: a diferencia de calculator code (ver
                // WriteType.CalculatorCode más abajo), no hay un método directo
                // "escribir H:var" en FSUIPCClientDLL/MSFSVariableServices -- se
                // podría emular con calculator code ("(>H:xxx)") si algún perfil
                // lo necesitara, pero ningún control declarado hoy usa Hvar para
                // escritura. Se mantiene como error estructurado explícito en vez
                // de fallar silenciosamente o hacer un TOGGLE.
                _log.Warn($"control '{control.Id}': write.type={control.Write.Type} (H:var) no soportado todavía por este bridge.");
                Broadcast(BridgeError.Build(control.Id, "write", $"write.type={control.Write.Type} no implementado"));
                return false;

            case WriteType.CalculatorCode:
                return WriteCalculatorCodeControl(control, value);

            case WriteType.ClientDataEvent:
                return WriteClientDataEventControl(control, value);

            case WriteType.NativeEventValue:
                return WriteNativeEventValueControl(control);
        }

        return false;
    }

    /// <summary>
    /// Escribe un control write.type=nativeEventValue: evento NATIVO de SimConnect
    /// (no propietario de un addon) transmitido con un parameter FIJO por control
    /// (ej. PMDG NG3 reutilizando "ROTOR_BRAKE" como bus de switches, ver
    /// controls/native-toggle-switches.yaml). A diferencia de InputEvent, el valor
    /// escrito por el llamador (true/false) se IGNORA -- el parameter numérico ya
    /// viene fijado en el perfil (documentado en 'semantics'), porque el mecanismo
    /// es un pulso de toggle, no un SET_VALUE parametrizable en tiempo real.
    /// </summary>
    private bool WriteNativeEventValueControl(ControlDefinition control)
    {
        var write = control.Write!;
        if (write.Parameter is null || !uint.TryParse(write.Parameter, out var dwData))
        {
            _log.Warn($"control '{control.Id}': write.type=nativeEventValue con 'parameter' inválido o ausente ('{write.Parameter}').");
            Broadcast(BridgeError.Build(control.Id, "write", $"control '{control.Id}': parameter inválido para nativeEventValue"));
            return false;
        }

        _sim.TransmitSetEvent(write.Name, dwData);
        return true;
    }

    /// <summary>
    /// Marcador reconocido en control.Write.Parameter (ver
    /// packages/profile-schema/control.schema.json: 'parameter' ya admite
    /// integer|string, así que esto NO requiere ningún cambio de esquema) para
    /// indicar que el Parameter a transmitir NO es un literal estático sino que
    /// debe sustituirse en tiempo de escritura por el valor ABSOLUTO que el
    /// cliente está fijando ahora mismo (0/1 para boolean, posición entera para
    /// number -- ej. selectores de N posiciones como lights.dome_white_sw: 0
    /// DIM/1 OFF/2 BRIGHT). Esto es lo que faltaba para que un clientDataEvent
    /// se comporte como un SET_VALUE real en vez de transmitir siempre
    /// Parameter=0 (ver ResolveWriteEventParameter). Cualquier otro valor de
    /// 'parameter' (incluido null) conserva el comportamiento histórico: un
    /// literal estático fijo por control (ej. mcdu.*.key_* siempre transmiten
    /// parameter: 1 sin importar el valor del press, porque son botones
    /// momentáneos sin estado).
    /// </summary>
    private const string DynamicParameterPlaceholder = "$value";

    /// <summary>
    /// Escribe un control write.type=clientDataEvent (SDK de terceros, ej. PMDG
    /// NG3). Regla anti-TOGGLE: control.Write.Semantics es obligatorio en el
    /// esquema (validado por tools/validate_profiles.py) precisamente para que un
    /// Event de PMDG quede tan auditable como un SET_ON/SET_OFF estándar. Nunca
    /// crashea si el SDK de terceros no está disponible: se loggea un warning y
    /// se reporta un BridgeError estructurado, sin afectar otros controles.
    /// </summary>
    private bool WriteClientDataEventControl(ControlDefinition control, object value)
    {
        // control.Write puede ser null si el control es readOnly; este método solo
        // se alcanza desde WriteControl tras verificar que no lo es, pero se
        // re-verifica aquí (método separado, el compilador no propaga el análisis
        // de nulabilidad entre métodos) para evitar cualquier NullReferenceException.
        var write = control.Write;
        if (write is null)
        {
            _log.Warn($"control '{control.Id}': write.type=clientDataEvent sin bloque 'write' definido (readOnly). Se ignora.");
            Broadcast(BridgeError.Build(control.Id, "write", $"control '{control.Id}' no tiene 'write' definido (readOnly)"));
            return false;
        }

        var areaName = write.AreaName ?? string.Empty;
        if (!EnsurePmdgClientReady(_pmdgClient, areaName, control.Id, "write"))
        {
            return false;
        }

        var eventIdOrName = write.Event ?? string.Empty;
        var resolvedParameter = ResolveWriteEventParameter(write.Parameter, control.DataType, value);
        var ok = _pmdgClient!.WriteControlEvent(areaName, eventIdOrName, resolvedParameter);
        if (!ok)
        {
            Broadcast(BridgeError.Build(control.Id, "write", $"clientDataEvent '{eventIdOrName}' en área '{areaName}' no se pudo escribir (ver logs del bridge para el motivo)"));
        }

        return ok;
    }

    /// <summary>
    /// Escribe un control write.type=calculatorCode ejecutando el RPN declarado
    /// en control.Write.Name a través de _calculatorCodeClient (en producción,
    /// FsuipcLVarClient -- ver ICalculatorCodeClient para el detalle de la
    /// verificación EN VIVO contra MSFS 2024 + PMDG 737-900 real). Igual que
    /// WriteClientDataEventControl, nunca crashea si el ejecutor no está
    /// disponible: se loggea un warning y se reporta un BridgeError
    /// estructurado, sin afectar otros controles.
    /// </summary>
    private bool WriteCalculatorCodeControl(ControlDefinition control, object value)
    {
        var write = control.Write;
        if (write is null)
        {
            _log.Warn($"control '{control.Id}': write.type=calculatorCode sin bloque 'write' definido (readOnly). Se ignora.");
            Broadcast(BridgeError.Build(control.Id, "write", $"control '{control.Id}' no tiene 'write' definido (readOnly)"));
            return false;
        }

        if (!EnsureCalculatorCodeClientReady(control.Id))
        {
            return false;
        }

        // Si ya se aprendió que este control va al revés de lo que declara el
        // perfil, se ejecuta el RPN con la dirección intercambiada. La calibración
        // NO reescribe el YAML: el perfil sigue siendo la fuente de verdad y esto
        // es una corrección medida encima (ver PolarityCalibration).
        var template = ResolveWriteTemplate(control, write.Name);
        var code = ResolveCalculatorCodeTemplate(template, control.DataType, value);

        // Reparto de turnos en el trigger (ver ExtractTriggerLVar): si otro control
        // del MISMO sistema acaba de escribir, este código se encola en vez de
        // ejecutarse. Escribirlo ahora lo perdería sin dejar rastro.
        //
        // Los PULSOS quedan fuera del reparto. Su par pulsar/soltar es atómico y
        // ordenado, y la cola indexa por control quedándose con el valor más nuevo:
        // si el "pulsar" esperara turno, el "soltar" que llega detrás lo
        // reemplazaría y el botón no se pulsaría nunca. Además un pulso lo origina
        // una persona apretando algo, de uno en uno -- no produce la ráfaga
        // simultánea que sí genera sincronizar un panel entero de posicionales, que
        // es lo que este reparto viene a arreglar.
        var trigger = MomentaryPulse.IsPulseControl(control) ? null : ExtractTriggerLVar(code);
        if (trigger is not null && !TryReserveTriggerSlot(trigger))
        {
            _deferredTriggerWrites[control.Id] = new DeferredTriggerWrite(control, trigger, code);
            return true; // aceptada: sale en cuanto el trigger quede libre
        }

        return ExecuteCalculatorCode(control, code);
    }

    private bool ExecuteCalculatorCode(ControlDefinition control, string code)
    {
        var ok = _calculatorCodeClient!.ExecuteCalculatorCode(code);
        if (!ok)
        {
            Broadcast(BridgeError.Build(control.Id, "write", $"calculatorCode '{code}' no se pudo ejecutar para el control '{control.Id}' (ver logs del bridge para el motivo)"));
        }

        return ok;
    }

    private void RegisterPendingWriteConfirmation(ControlDefinition control, object value)
    {
        if (!control.Synchronization.ConfirmAfterWrite || control.WriteOnly || control.Read is null)
        {
            return;
        }

        // Un pulso no tiene estado estable que confirmar: el botón vuelve solo, la
        // lectura nunca sostiene el valor pedido, y el lazo reintentaría durante
        // toda la ventana volviendo a PULSAR la tecla en cada intento (~9 veces en
        // 6 s). El perfil generado declara confirmAfterWrite:true para los 568
        // momentáneos del iFly, así que hay que descartarlos acá.
        if (MomentaryPulse.IsPulseControl(control))
        {
            return;
        }

        var nowMs = NowMs();
        _pendingWriteConfirmations[control.Id] = new PendingWriteConfirmation(
            control,
            value,
            StartedAtMs: nowMs,
            LastAttemptAtMs: nowMs,
            Attempts: 1)
        {
            // Distancia de partida tomada de la lectura que YA teníamos antes de
            // escribir. Con esto la divergencia se detecta en la PRIMERA lectura
            // posterior en vez de la segunda -- un paso menos en la dirección
            // equivocada. Si no había lectura previa (control nunca leído), queda
            // null y ObserveConfirmedValue la fija con la primera que llegue.
            InitialDistance = InitialDistanceFor(control, value),
        };
    }

    /// <summary>
    /// Distancia entre el valor pedido y el último valor leído del control, cuando
    /// ambos son numéricos. Null si no aplica.
    /// </summary>
    private double? InitialDistanceFor(ControlDefinition control, object desiredValue)
    {
        if (control.DataType != ControlDataType.Number
            || desiredValue is not double desired
            || !_lastObservedByControl.TryGetValue(control.Id, out var observed)
            || observed is not double observedNumber)
        {
            return null;
        }

        return Math.Abs(desired - observedNumber);
    }

    /// <summary>
    /// La cabina del iFly no tiene un evento por control: un clic escribe un CODIGO
    /// ENTERO en la L-Var de trigger DEL SISTEMA, y el WASM del addon la lee una vez
    /// por frame. Esa L-Var es, por tanto, un buzon de UNA sola casilla compartido
    /// por todo el sistema -- y esta MUY compartido: 220 controles escriben en
    /// VC_Miscellaneous_trigger_VAL, 80 en VC_Anti_Ice_trigger_VAL, 39 en
    /// VC_Fuel_trigger_VAL.
    ///
    /// Hasta la 0.1.27 las escrituras salian una detras de otra en el mismo tick del
    /// pump, asi que varios controles del mismo sistema se pisaban DENTRO del mismo
    /// frame y solo sobrevivia el ultimo. Se veia como "de las bombas de fuel solo
    /// sincroniza AFT": no es que las demas estuvieran mal declaradas, es que su
    /// codigo lo sobrescribia el siguiente antes de que el addon lo leyera. Y era
    /// determinista -- siempre ganaba el mismo, el ultimo en el orden de iteracion.
    ///
    /// Este espaciado garantiza que entre dos escrituras al MISMO trigger pase al
    /// menos un frame. Los triggers distintos no se estorban: cada uno lleva su
    /// propio turno.
    /// </summary>
    private const int TriggerWriteSpacingMs = 50;

    private readonly Dictionary<string, long> _lastTriggerWriteAtMs = new(StringComparer.Ordinal);

    /// <summary>
    /// Escrituras que esperan turno en su trigger, indexadas POR CONTROL: si al
    /// mismo control le llega un valor mas nuevo mientras espera, reemplaza al
    /// anterior en vez de encolarse detras. Mandar dos posiciones seguidas del mismo
    /// switch no tiene sentido -- solo cuenta la ultima.
    /// </summary>
    private readonly Dictionary<string, DeferredTriggerWrite> _deferredTriggerWrites = new(StringComparer.Ordinal);

    private readonly record struct DeferredTriggerWrite(ControlDefinition Control, string Trigger, string Code);

    /// <summary>
    /// Saca el nombre de la L-Var de trigger a la que apunta un calculator code ya
    /// resuelto, es decir el destino de su ultimo <c>(&gt;L:...)</c>. Devuelve null
    /// si el codigo no escribe ninguna L-Var (otros mecanismos de escritura no
    /// comparten buzon y no necesitan turno).
    /// </summary>
    public static string? ExtractTriggerLVar(string calculatorCode)
    {
        var matches = Regex.Matches(calculatorCode, @"\(>\s*L:([A-Za-z0-9_]+)\s*,", RegexOptions.None, TimeSpan.FromSeconds(1));
        return matches.Count == 0 ? null : matches[^1].Groups[1].Value;
    }

    /// <summary>
    /// Concede el turno del trigger si ya paso el espaciado minimo desde la ultima
    /// escritura. Si lo concede, lo anota -- o sea que llamarlo tiene efecto.
    /// </summary>
    private bool TryReserveTriggerSlot(string trigger)
    {
        var nowMs = NowMs();
        if (_lastTriggerWriteAtMs.TryGetValue(trigger, out var lastMs)
            && nowMs - lastMs < TriggerWriteSpacingMs)
        {
            return false;
        }

        _lastTriggerWriteAtMs[trigger] = nowMs;
        return true;
    }

    /// <summary>
    /// Despacha las escrituras que estaban esperando turno. Como mucho UNA por
    /// trigger en cada pasada: dos del mismo trigger en el mismo tick volverian a
    /// pisarse, que es justo lo que se esta arreglando.
    /// </summary>
    private void DrainDeferredTriggerWrites()
    {
        if (_deferredTriggerWrites.Count == 0)
        {
            return;
        }

        foreach (var (controlId, deferred) in _deferredTriggerWrites.ToArray())
        {
            if (!TryReserveTriggerSlot(deferred.Trigger))
            {
                continue; // su trigger sigue ocupado; se reintenta en el proximo pump
            }

            _deferredTriggerWrites.Remove(controlId);
            ExecuteCalculatorCode(deferred.Control, deferred.Code);
        }
    }

    private void ProcessPendingWriteConfirmations()
    {
        if (_pendingWriteConfirmations.Count == 0)
        {
            return;
        }

        var nowMs = NowMs();
        foreach (var pending in _pendingWriteConfirmations.Values.ToArray())
        {
            var elapsedMs = nowMs - pending.StartedAtMs;
            var timeoutMs = ResolveConfirmTimeoutMs(pending.Control);
            if (elapsedMs >= timeoutMs)
            {
                // No haber visto NINGUNA lectura en toda la ventana también es
                // compatible con una polaridad cruzada: si el control ya está
                // contra su tope, la escritura lo empuja hacia afuera, nada se
                // mueve, y la detección por divergencia de ObserveConfirmedValue
                // -- que necesita ver crecer la distancia -- nunca se dispara. Ese
                // era el punto ciego que la 0.1.13 solo sabía NOMBRAR; acá se
                // intenta corregir.
                //
                // OJO: a diferencia del caso de divergencia, este síntoma es
                // AMBIGUO (sistema sin alimentación, L-Var inexistente en esta
                // variante, valor pedido que no es una detente legal). Por eso se
                // prueba a invertir, pero NUNCA se revierte una calibración ya
                // establecida a partir de este síntoma: se reportaría un fallo
                // ajeno a la polaridad como si lo fuera, y se perdería una
                // corrección que sí era correcta.
                if (!pending.ObservedAnyReading
                    && TryRecoverWithInvertedPolarity(pending, $"NO SE MOVIÓ en absoluto tras {pending.Attempts} intento(s)"))
                {
                    continue;
                }

                _pendingWriteConfirmations.Remove(pending.Control.Id);

                // Sin NINGUNA lectura en toda la ventana el control no se movió
                // ni un paso. Eso no es "lento": es que la escritura no tuvo
                // efecto, y la causa típica es que los códigos de subir/bajar
                // estén cruzados en el perfil y se esté empujando contra el tope
                // (la polaridad varía por control en el iFly, ver
                // aircraft-profiles/ifly-737-max8/NOTAS-SDK.md). Ese caso es
                // CIEGO para la deteccion de divergencia de ObserveConfirmedValue,
                // que necesita ver la distancia crecer -- por eso hay que
                // nombrarlo aquí o queda indistinguible de un timeout normal.
                // Se anota el último valor conocido (o que nunca hubo ninguno).
                // Con FSUIPC en modo push solo llegan las L-Vars que CAMBIAN, así
                // que "nunca reportó" no prueba que la L-Var no exista -- puede
                // ser un switch que nadie ha tocado desde que arrancó el bridge.
                // Justamente por eso el dato hay que mostrarlo en vez de deducir:
                // sin él, "NO SE MOVIÓ" se lee como un fallo de escritura ya
                // diagnosticado cuando en realidad el bridge no tiene ni una
                // lectura con la que afirmarlo.
                var everRead = _lastObservedByControl.TryGetValue(pending.Control.Id, out var lastKnownValue);
                var lectura = everRead
                    ? $"último valor leído '{lastKnownValue}'"
                    : "esta L-Var NUNCA ha reportado un valor en toda la sesión";
                var detalle = pending.ObservedAnyReading
                    ? $"no convergió al valor pedido tras {pending.Attempts} intento(s)"
                    : $"NO SE MOVIÓ en absoluto tras {pending.Attempts} intento(s) [{lectura}] " +
                      (_polarity.IsInverted(ActiveProfileId, pending.Control.Id)
                          ? "NI con la polaridad invertida: la causa no es la polaridad (¿sistema sin " +
                            "alimentación, L-Var inexistente en esta variante, o valor que no es una " +
                            "detente legal?)"
                          : "y el bridge no pudo probar la polaridad invertida (su RPN no es de la forma " +
                            "posicional invertible): revisar el YAML a mano");

                _writesFailed++;
                _log.Warn($"control '{pending.Control.Id}': {detalle} (valor pedido '{pending.DesiredValue}', {elapsedMs}ms).");
                Broadcast(BridgeError.Build(pending.Control.Id, "confirmAfterWrite", $"el control {detalle}"));
                continue;
            }

            var retryIntervalMs = GetConfirmRetryIntervalMs(timeoutMs);
            if (nowMs - pending.LastAttemptAtMs < retryIntervalMs)
            {
                continue;
            }

            if (!WriteControl(pending.Control, pending.DesiredValue))
            {
                _pendingWriteConfirmations.Remove(pending.Control.Id);
                continue;
            }

            _pendingWriteConfirmations[pending.Control.Id] =
                pending with { LastAttemptAtMs = nowMs, Attempts = pending.Attempts + 1 };
        }
    }

    private void ObserveConfirmedValue(ControlDefinition control, object observedValue)
    {
        if (!_pendingWriteConfirmations.TryGetValue(control.Id, out var pending))
        {
            return;
        }

        if (ValuesEquivalent(control.DataType, pending.DesiredValue, observedValue))
        {
            _pendingWriteConfirmations.Remove(control.Id);
            _writesConfirmed++;
            return;
        }

        pending = pending with { ObservedAnyReading = true };
        _pendingWriteConfirmations[control.Id] = pending;

        // Detección de polaridad invertida. Los controles del iFly no aceptan un
        // SET absoluto: cada escritura avanza UN paso, y la dirección la decide el
        // RPN del perfil comparando el estado real contra el destino. Si ese RPN
        // tuviera los códigos de subir/bajar cruzados, cada reintento alejaría el
        // control un paso más -- con una ventana de 6 segundos serían ~9 pasos en
        // la dirección equivocada antes de rendirse.
        //
        // Acá se corta apenas se ve que el control quedó MÁS LEJOS del destino que
        // cuando empezó, y se invierte la polaridad (ver
        // TryRecoverWithInvertedPolarity).
        if (control.DataType != ControlDataType.Number
            || pending.DesiredValue is not double desired
            || observedValue is not double observed)
        {
            return;
        }

        var distance = Math.Abs(desired - observed);

        // La primera lectura fija la referencia; no se puede juzgar divergencia con
        // un solo punto.
        if (pending.InitialDistance is not double initial)
        {
            _pendingWriteConfirmations[control.Id] = pending with { InitialDistance = distance };
            return;
        }

        if (distance > initial + 0.001d)
        {
            // Superar la distancia de PARTIDA es la evidencia más clara de una
            // polaridad cruzada: el control se mueve, obedece, y va justo al lado
            // contrario. Un sobrepaso de animación cerca del destino no llega acá.
            var symptom =
                $"se ALEJÓ del valor pedido '{desired}' (arrancó a {initial} de distancia y quedó a {distance})";

            if (TryRecoverWithInvertedPolarity(pending, symptom))
            {
                return;
            }

            _pendingWriteConfirmations.Remove(control.Id);
            _writesFailed++;

            // Si ya estaba invertido y AÚN así se aleja, la inversión no era la
            // causa: se deshace para no dejar el control peor de como estaba. Es
            // el único caso donde revertir es seguro — divergir en ambas
            // direcciones descarta la polaridad como explicación.
            if (_polarity.IsInverted(ActiveProfileId, control.Id))
            {
                _polarity.RevertInversion(ActiveProfileId, control.Id);
                _log.Warn(
                    $"control '{control.Id}': {symptom} TAMBIÉN con la polaridad invertida. Se descarta la " +
                    "polaridad como causa y se restaura la del perfil.");
            }
            else
            {
                _log.Warn(
                    $"control '{control.Id}': {symptom}. Se aborta la convergencia: los códigos de subir/bajar " +
                    "de este control parecen invertidos en el perfil, pero su RPN no es de la forma posicional " +
                    "que el bridge puede invertir solo (revisar el YAML a mano).");
            }

            Broadcast(BridgeError.Build(
                control.Id,
                "confirmAfterWrite",
                "el control se alejó del valor pedido en vez de acercarse (polaridad invertida) y no se pudo " +
                "corregir automáticamente; se abortó la convergencia para no seguir moviéndolo en la " +
                "dirección equivocada"));
            return;
        }

        // Se acerca (o sobrepasa dentro de la distancia de partida): nada que
        // hacer. La referencia inicial NO se actualiza -- es el punto fijo contra
        // el que se juzga toda la ventana.
    }

    /// <summary>
    /// Ventana de confirmación por defecto cuando el perfil NO declara
    /// synchronization.timeoutMs (que es el caso de la enorme mayoría: 1053 de
    /// 1053 controles del iFly 737 MAX 8 y 524 de 646 del PMDG 737).
    ///
    /// Antes esto era Math.Max(1, timeoutMs), que para un control sin timeoutMs
    /// declarado dejaba una ventana de UN MILISEGUNDO: en el pump siguiente (33 ms
    /// después) ya había expirado y el bridge abortaba con "no convergió tras 1
    /// intento(s)" sin darle al simulador ninguna chance de moverse. Ese Math.Max
    /// existía para evitar una ventana de 0, no para declarar que 1 ms fuese un
    /// timeout razonable. Detectado en vivo el 2026-07-28 con engine.apu_sw del
    /// iFly.
    ///
    /// El valor sale de medirlo en vivo (2026-07-29, iFly gear.autobrake_sw): cada
    /// ExecuteCalculatorCode vía FSUIPC cuesta ~650 ms de ida y vuelta, MUCHO más
    /// que el intervalo de reintento de 250 ms, así que el número real de pasos
    /// que entran en la ventana es timeout/650, no timeout/250. Con 2000 ms solo
    /// entraban 3 pasos y el autobrake se quedaba en 40 yendo a 50. 6000 ms da
    /// ~9 pasos, suficiente para cualquier selector de detentes del 737.
    ///
    /// Esto importa porque en el iFly la confirmación por reintentos ES el lazo de
    /// convergencia: sus selectores no aceptan un SET absoluto y avanzan de a un
    /// paso por escritura (ver aircraft-profiles/ifly-737-max8/NOTAS-SDK.md).
    /// Alargar la ventana es seguro gracias a la detección de divergencia de
    /// ObserveConfirmedValue: si el control se aleja del destino se aborta al
    /// instante, sin gastar los 6 segundos dando pasos para el lado equivocado.
    /// </summary>
    private const int DefaultConfirmTimeoutMs = 6000;

    private static int ResolveConfirmTimeoutMs(ControlDefinition control)
    {
        var declared = control.Synchronization.TimeoutMs;
        return declared > 0 ? declared : DefaultConfirmTimeoutMs;
    }

    private static int GetConfirmRetryIntervalMs(int timeoutMs)
    {
        var candidate = timeoutMs / 4;
        return Math.Clamp(candidate, 100, 250);
    }

    private static bool ValuesEquivalent(ControlDataType dataType, object expected, object observed) => dataType switch
    {
        ControlDataType.Boolean => expected is bool eb && observed is bool ob && eb == ob,
        ControlDataType.Number => expected is double en && observed is double on && Math.Abs(en - on) <= 0.001d,
        ControlDataType.String => string.Equals(expected?.ToString(), observed?.ToString(), StringComparison.Ordinal),
        _ => Equals(expected, observed),
    };

    private void ClearPendingWriteConfirmations()
    {
        _pendingWriteConfirmations.Clear();
        // Las lecturas cacheadas son de la aeronave anterior: conservarlas haria
        // que AlreadyAtValue descartara escrituras validas del avion nuevo.
        _lastObservedByControl.Clear();
        _lastObservedPoseValues.Clear();
        _remoteFlightPoseTarget = null;
        _lastFlightPoseBroadcastAtMs = 0;
        _lastFlightPoseCorrectionAtMs = 0;
        // Un pulso que quedo "pulsado por nosotros" al cambiar de avion o perder la
        // conexion ya no tiene par que cerrar: dejarlo marcado haria que el primer
        // "soltar" del avion nuevo se ejecutara sin haber pulsado nada.
        _pulsesPressedByUs.Clear();
        // Y un eco pendiente de suprimir del avion anterior suprimiria una lectura
        // legitima del nuevo.
        _pulseEchoToSuppress.Clear();
    }

    /// <summary>
    /// Sustituye el marcador DynamicParameterPlaceholder ("$value") dentro de un
    /// template de RPN (control.Write.Name para calculatorCode) por el valor
    /// ABSOLUTO que se está fijando ahora mismo, igual que
    /// ResolveWriteEventParameter hace para clientDataEvent. La escala/signo
    /// específicos de cada evento K: de destino (ej. AXIS_RUDDER_SET espera
    /// -16384..16384, no -1..1) son responsabilidad del propio RPN declarado en
    /// el perfil (puede incluir aritmética, ej. "$value -16384 * (>K:AXIS_RUDDER_SET)"),
    /// no de este método -- ver ICalculatorCodeClient para la escala/signo real
    /// confirmados en vivo para el 737. Si el template no contiene el marcador,
    /// se ejecuta literal (permite RPN estático sin valor, ej. pulsos fijos).
    /// </summary>
    /// <summary>
    /// Devuelve el RPN a ejecutar para un control, aplicando la inversión de
    /// polaridad si se aprendió que este control la necesita. Si el RPN no es de
    /// la forma posicional invertible, Invert devuelve null y se usa el original.
    /// </summary>
    private string ResolveWriteTemplate(ControlDefinition control, string template)
    {
        if (!_polarity.IsInverted(ActiveProfileId, control.Id))
        {
            return template;
        }

        return PolarityCalibration.Invert(template) ?? template;
    }

    private string ActiveProfileId => _matchedProfile?.ProfileId ?? string.Empty;

    /// <summary>
    /// Último recurso antes de reportar un fallo de convergencia: si el síntoma es
    /// compatible con una polaridad cruzada y este control todavía no se probó al
    /// revés, se invierte su RPN y se reintenta con una ventana limpia.
    ///
    /// Devuelve true si se rearmó el reintento (el llamador NO debe reportar
    /// error todavía), false si no hay nada más que probar.
    ///
    /// Esta es la diferencia de fondo con el comportamiento hasta la 0.1.13: antes,
    /// detectar la polaridad invertida solo servía para abortar más rápido y
    /// escribir un mensaje más preciso en el log; el control seguía sin moverse
    /// hasta que alguien editara el YAML a mano. Ahora el bridge lo corrige solo, y
    /// como la corrección se persiste, cada control se calibra UNA vez en la vida
    /// del perfil, no una vez por sesión.
    /// </summary>
    private bool TryRecoverWithInvertedPolarity(PendingWriteConfirmation pending, string symptom)
    {
        var control = pending.Control;
        if (control.Write is null || control.Write.Type != WriteType.CalculatorCode)
        {
            return false;
        }

        var declaredTemplate = control.Write.Name;
        if (!_polarity.ShouldTryInverting(ActiveProfileId, control.Id, declaredTemplate))
        {
            return false;
        }

        _polarity.MarkInverted(ActiveProfileId, control.Id);
        _log.Warn(
            $"control '{control.Id}': {symptom}. Se INVIERTE la polaridad de este control y se reintenta " +
            "(el perfil se generó del modelo 3D asumiendo la convención de la rueda, que no se cumple en " +
            "todos los controles). La corrección queda guardada para las próximas sesiones.");

        if (!WriteControl(control, pending.DesiredValue))
        {
            _pendingWriteConfirmations.Remove(control.Id);
            return false;
        }

        // Ventana limpia: el reintento invertido empieza de cero, sin arrastrar la
        // distancia ni los intentos gastados empujando para el lado equivocado.
        var nowMs = NowMs();
        _pendingWriteConfirmations[control.Id] = pending with
        {
            StartedAtMs = nowMs,
            LastAttemptAtMs = nowMs,
            Attempts = 1,
            // La partida del reintento invertido es la posición ACTUAL (a la que el
            // control llegó yéndose para el lado equivocado), no la original: si no,
            // volver sobre sus pasos parecería divergencia otra vez.
            InitialDistance = InitialDistanceFor(control, pending.DesiredValue),
            ObservedAnyReading = false,
        };

        return true;
    }

    private static string ResolveCalculatorCodeTemplate(string template, ControlDataType dataType, object value)
    {
        if (!template.Contains(DynamicParameterPlaceholder, StringComparison.Ordinal))
        {
            return template;
        }

        var numeric = dataType switch
        {
            ControlDataType.Boolean => value is bool b ? (b ? 1d : 0d) : 0d,
            ControlDataType.Number => value is double d ? d : 0d,
            _ => 0d,
        };

        return template.Replace(
            DynamicParameterPlaceholder,
            numeric.ToString(System.Globalization.CultureInfo.InvariantCulture),
            StringComparison.Ordinal);
    }

    /// <summary>
    /// Verifica (y, si hace falta, intenta abrir) la conexión del ejecutor de
    /// calculator code. Reporta como warning/BridgeError la primera vez que no
    /// está disponible, sin reintentar en cada Pump (evita spam de logs) --
    /// mismo patrón que EnsurePmdgClientReady.
    /// </summary>
    private bool EnsureCalculatorCodeClientReady(string controlId)
    {
        if (_calculatorCodeClient is null)
        {
            if (!_calculatorCodeUnavailableWarned)
            {
                _calculatorCodeUnavailableWarned = true;
                _log.Warn("El perfil activo declara un control write.type=calculatorCode, pero el bridge no tiene ningún ICalculatorCodeClient inyectado (ver Program.cs). Esos controles no se sincronizarán.");
            }

            Broadcast(BridgeError.Build(controlId, "write", "ningún ejecutor de calculator code configurado en el bridge"));
            return false;
        }

        if (_calculatorCodeClient.IsConnected)
        {
            return true;
        }

        if (_calculatorCodeClient.TryConnect(_appName))
        {
            return true;
        }

        if (!_calculatorCodeUnavailableWarned)
        {
            _calculatorCodeUnavailableWarned = true;
            _log.Warn("No se pudo conectar el ejecutor de calculator code (¿FSUIPC7 no está corriendo?). Esos controles no se sincronizarán hasta la próxima reconexión.");
        }

        Broadcast(BridgeError.Build(controlId, "write", "no se pudo conectar el ejecutor de calculator code"));
        return false;
    }

    /// <summary>
    /// Marcador reconocido en control.Write.Name para write.type=inputEvent
    /// (separador '|'): algunos addons de terceros (ej. PMDG NG3, confirmado
    /// contra la implementación real de YourControls para el gear lever, ver
    /// aircraft-profiles/pmdg-737-900/EVENT_IDS_PENDIENTES.md) NO escuchan un
    /// único K:event *_SET parametrizable con 0/1 -- en su lugar solo hookean
    /// dos K:events NATIVOS de SimConnect legacy y deterministas por separado
    /// (ej. GEAR_UP / GEAR_DOWN), cada uno sin parámetro significativo. Un
    /// perfil puede declarar esto con 'write.name: "EVENTO_SI_TRUE|EVENTO_SI_FALSE"'
    /// (solo para dataType boolean); el bridge elige el evento según el valor
    /// ABSOLUTO que se está fijando (nunca alterna/toggle -- sigue siendo un
    /// SET_ON/SET_OFF explícito, solo que cada estado usa un K:event propio en
    /// vez de un parámetro numérico sobre el mismo evento). Sin '|' en el
    /// nombre, o para dataType distinto de boolean, se conserva el
    /// comportamiento histórico de un único evento con dwData derivado del
    /// valor.
    /// </summary>
    private static (string EventName, uint Data) ResolveInputEventPulse(string declaredName, ControlDataType dataType, object value)
    {
        if (dataType == ControlDataType.Boolean && declaredName.Contains('|'))
        {
            var parts = declaredName.Split('|', 2);
            var isTrue = value is bool b && b;
            // dwData=1 fijo para ambos casos: el K:event elegido ya codifica la
            // dirección/acción determinística (ej. K:GEAR_DOWN vs K:GEAR_UP), el
            // parámetro numérico no tiene semántica propia para este tipo de
            // evento legacy (mismo patrón usado por la implementación de
            // referencia de YourControls: "1 (>K:GEAR_UP)" / "1 (>K:GEAR_DOWN)").
            return (isTrue ? parts[0] : parts[1], 1u);
        }

        var dwData = value switch
        {
            bool b2 => b2 ? 1u : 0u,
            double d => unchecked((uint)Math.Round(d)),
            string => 0u,
            _ => 0u,
        };

        return (declaredName, dwData);
    }

    /// <summary>
    /// Resuelve el valor final de Control.Parameter para un control
    /// write.type=clientDataEvent. Ver DynamicParameterPlaceholder para la
    /// convención completa. SIEMPRE transmite el valor ABSOLUTO deseado (nunca
    /// un delta/pulso relativo), tanto en el caso dinámico como en el estático,
    /// preservando la regla anti-TOGGLE del proyecto.
    /// </summary>
    private static string? ResolveWriteEventParameter(string? declaredParameter, ControlDataType dataType, object value)
    {
        if (!string.Equals(declaredParameter, DynamicParameterPlaceholder, StringComparison.Ordinal))
        {
            // Comportamiento histórico: literal estático (o null) definido en el perfil.
            return declaredParameter;
        }

        var numeric = dataType switch
        {
            ControlDataType.Boolean => value is bool b ? (b ? 1 : 0) : 0,
            ControlDataType.Number => value is double d ? unchecked((int)Math.Round(d)) : 0,
            _ => 0,
        };

        return numeric.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private void OnConnected()
    {
        _log.Info("SimConnect conectado a MSFS.");
        ClearPendingWriteConfirmations();
        _matchedProfile = null;
        _lastTitle = null;
        _pmdgUnavailableWarned = false;
        _sim.SubscribeString(TitleKey, "TITLE", PollMode.OnChange);
        SubscribeFlightPoseVariables();
        Broadcast(BridgeStatus.Build(true, null, null, null, SimulatorVersionLabel));
    }

    private void OnDisconnected()
    {
        _log.Warn("SimConnect desconectado (¿se cerró MSFS?). Reintentando periódicamente.");
        ClearPendingWriteConfirmations();
        _matchedProfile = null;
        _lastTitle = null;
        _remoteFlightPoseTarget = null;
        Broadcast(BridgeStatus.Build(false, null, null, null, SimulatorVersionLabel));
    }

    private void OnSimConnectException(string message)
    {
        _log.Error($"SimConnect: {message}");
        Broadcast(BridgeError.Build("<simconnect>", "sim", message));
    }

    private void OnStringValueReceived(string key, string value)
    {
        if (key == TitleKey)
        {
            if (value == _lastTitle)
            {
                return;
            }

            _lastTitle = value;
            MatchAndSubscribe(value);
            return;
        }

        var control = _matchedProfile?.FindControl(key);
        if (control is null)
        {
            return;
        }

        ObserveConfirmedValue(control, value);
        EmitDebounced(control, value);
    }

    private void OnNumericValueReceived(string key, double value)
    {
        if (HandleFlightPoseNumeric(key, value))
        {
            return;
        }

        var control = _matchedProfile?.FindControl(key);
        if (control is null)
        {
            if (HandleWriteOnlyTriggerMirror(key, value))
            {
                return;
            }

            // Puede ocurrir brevemente tras un cambio de perfil (mensajes en vuelo de suscripciones viejas).
            return;
        }

        if (control.UsesFastChannel)
        {
            _lastObservedByControl[control.Id] = value;
            var axis = new ControlAxisMessage(LocalSessionId, control.Id, value, NextSequence(), NowMs());
            Broadcast(axis.ToJson());
            return;
        }

        object typedValue = control.DataType == ControlDataType.Boolean ? value != 0 : value;
        _lastObservedByControl[control.Id] = typedValue;
        ObserveConfirmedValue(control, typedValue);
        EmitDebounced(control, typedValue);
    }

    private void SubscribeFlightPoseVariables()
    {
        _sim.SubscribeNumeric(PoseLatKey, "PLANE LATITUDE", "degrees", PollMode.Continuous);
        _sim.SubscribeNumeric(PoseLonKey, "PLANE LONGITUDE", "degrees", PollMode.Continuous);
        _sim.SubscribeNumeric(PoseAltKey, "PLANE ALTITUDE", "feet", PollMode.Continuous);
        _sim.SubscribeNumeric(PosePitchKey, "PLANE PITCH DEGREES", "degrees", PollMode.Continuous);
        _sim.SubscribeNumeric(PoseBankKey, "PLANE BANK DEGREES", "degrees", PollMode.Continuous);
        _sim.SubscribeNumeric(PoseHeadingKey, "PLANE HEADING DEGREES TRUE", "degrees", PollMode.Continuous);
        _sim.SubscribeNumeric(PoseGroundSpeedKey, "GROUND VELOCITY", "knots", PollMode.Continuous);
        _sim.SubscribeNumeric(PoseIndicatedAirspeedKey, "AIRSPEED INDICATED", "knots", PollMode.Continuous);
        _sim.SubscribeNumeric(PoseVerticalSpeedKey, "VERTICAL SPEED", "feet per minute", PollMode.Continuous);
    }

    private bool HandleFlightPoseNumeric(string key, double value)
    {
        if (!IsFlightPoseKey(key))
        {
            return false;
        }

        _lastObservedPoseValues[key] = key == PoseHeadingKey ? NormalizeHeading(value) : value;
        EmitFlightPoseIfDue();
        return true;
    }

    private void EmitFlightPoseIfDue()
    {
        if (!TryBuildCurrentFlightPoseState(out var pose))
        {
            return;
        }

        var nowMs = NowMs();
        if (nowMs - _lastFlightPoseBroadcastAtMs < FlightPoseBroadcastIntervalMs)
        {
            return;
        }

        _lastFlightPoseBroadcastAtMs = nowMs;
        Broadcast(new FlightPoseMessage(
            LocalSessionId,
            NextSequence(),
            nowMs,
            pose!.Lat,
            pose.Lon,
            pose.Alt,
            pose.Pitch,
            pose.Bank,
            pose.Heading,
            pose.GroundSpeed,
            pose.IndicatedAirspeed,
            pose.VerticalSpeed).ToJson());
    }

    private void ProcessRemoteFlightPoseCorrection()
    {
        if (_remoteFlightPoseTarget is null)
        {
            return;
        }

        var nowMs = NowMs();
        if (nowMs - _lastFlightPoseCorrectionAtMs < FlightPoseCorrectionIntervalMs)
        {
            return;
        }
        _lastFlightPoseCorrectionAtMs = nowMs;

        if (!TryBuildCurrentFlightPoseState(out var current))
        {
            return;
        }

        var mode = ResolveFlightCorrectionMode(current!, _remoteFlightPoseTarget);
        var target = ExtrapolateFlightPose(_remoteFlightPoseTarget, mode, nowMs);
        if (PoseCloseEnough(current!, target, mode))
        {
            _remoteFlightPoseTarget = null;
            return;
        }

        if (_remoteFlightPoseTarget.RequiresSnap || ShouldSnapToPose(current!, target, mode))
        {
            ApplyFlightPose(target);
            _remoteFlightPoseTarget = _remoteFlightPoseTarget with { RequiresSnap = false };
            return;
        }

        ApplyFlightPose(InterpolatePose(current!, target, mode, nowMs));
    }

    private bool TryBuildCurrentFlightPoseState(out FlightPoseState? pose)
    {
        if (!_lastObservedPoseValues.TryGetValue(PoseLatKey, out var lat)
            || !_lastObservedPoseValues.TryGetValue(PoseLonKey, out var lon)
            || !_lastObservedPoseValues.TryGetValue(PoseAltKey, out var alt)
            || !_lastObservedPoseValues.TryGetValue(PosePitchKey, out var pitch)
            || !_lastObservedPoseValues.TryGetValue(PoseBankKey, out var bank)
            || !_lastObservedPoseValues.TryGetValue(PoseHeadingKey, out var heading)
            || !_lastObservedPoseValues.TryGetValue(PoseGroundSpeedKey, out var groundSpeed)
            || !_lastObservedPoseValues.TryGetValue(PoseIndicatedAirspeedKey, out var ias)
            || !_lastObservedPoseValues.TryGetValue(PoseVerticalSpeedKey, out var verticalSpeed))
        {
            pose = null;
            return false;
        }

        pose = new FlightPoseState(
            lat,
            lon,
            alt,
            pitch,
            bank,
            NormalizeHeading(heading),
            groundSpeed,
            ias,
            verticalSpeed);
        return true;
    }

    private static bool IsFlightPoseKey(string key) => key is
        PoseLatKey or
        PoseLonKey or
        PoseAltKey or
        PosePitchKey or
        PoseBankKey or
        PoseHeadingKey or
        PoseGroundSpeedKey or
        PoseIndicatedAirspeedKey or
        PoseVerticalSpeedKey;

    private static bool ShouldSnapToPose(FlightPoseState current, FlightPoseState target, FlightCorrectionMode mode)
    {
        var error = ComputeLocalPoseError(current, target);
        var altitude = Math.Abs(current.Alt - target.Alt);
        var attitude = Math.Max(
            Math.Max(Math.Abs(current.Pitch - target.Pitch), Math.Abs(current.Bank - target.Bank)),
            Math.Abs(ShortestAngleDegrees(current.Heading, target.Heading)));

        var horizontalThreshold = mode switch
        {
            FlightCorrectionMode.Ground => 25d,
            FlightCorrectionMode.Taxi => 40d,
            FlightCorrectionMode.Airborne => 120d,
            FlightCorrectionMode.Handoff => 160d,
            _ => 120d,
        };
        var altitudeThreshold = mode switch
        {
            FlightCorrectionMode.Ground => 40d,
            FlightCorrectionMode.Taxi => 75d,
            FlightCorrectionMode.Airborne => 250d,
            FlightCorrectionMode.Handoff => 320d,
            _ => 250d,
        };
        var attitudeThreshold = mode switch
        {
            FlightCorrectionMode.Ground => 4d,
            FlightCorrectionMode.Taxi => 6d,
            FlightCorrectionMode.Airborne => 12d,
            FlightCorrectionMode.Handoff => 16d,
            _ => 12d,
        };

        return error.HorizontalMeters >= horizontalThreshold
            || altitude >= altitudeThreshold
            || attitude >= attitudeThreshold;
    }

    private static bool PoseCloseEnough(FlightPoseState current, FlightPoseState target, FlightCorrectionMode mode)
    {
        var error = ComputeLocalPoseError(current, target);
        var altitude = Math.Abs(current.Alt - target.Alt);
        var attitude = Math.Max(
            Math.Max(Math.Abs(current.Pitch - target.Pitch), Math.Abs(current.Bank - target.Bank)),
            Math.Abs(ShortestAngleDegrees(current.Heading, target.Heading)));

        var horizontalThreshold = mode switch
        {
            FlightCorrectionMode.Ground => 0.6d,
            FlightCorrectionMode.Taxi => 1.2d,
            FlightCorrectionMode.Airborne => 2.5d,
            FlightCorrectionMode.Handoff => 3.5d,
            _ => 1.5d,
        };
        var altitudeThreshold = mode switch
        {
            FlightCorrectionMode.Ground => 3d,
            FlightCorrectionMode.Taxi => 5d,
            FlightCorrectionMode.Airborne => 10d,
            FlightCorrectionMode.Handoff => 14d,
            _ => 8d,
        };
        var attitudeThreshold = mode switch
        {
            FlightCorrectionMode.Ground => 0.25d,
            FlightCorrectionMode.Taxi => 0.4d,
            FlightCorrectionMode.Airborne => 0.8d,
            FlightCorrectionMode.Handoff => 1.2d,
            _ => 0.6d,
        };

        return error.HorizontalMeters <= horizontalThreshold
            && altitude <= altitudeThreshold
            && attitude <= attitudeThreshold;
    }

    private static FlightPoseState InterpolatePose(
        FlightPoseState current,
        FlightPoseState target,
        FlightCorrectionMode mode,
        long nowMs)
    {
        var dt = Math.Max(FlightPoseCorrectionIntervalMs / 1000d, 0.001d);
        var error = ComputeLocalPoseError(current, target);

        var horizontalRate = mode switch
        {
            FlightCorrectionMode.Ground => 1.5d,
            FlightCorrectionMode.Taxi => 4d,
            FlightCorrectionMode.Airborne => 18d,
            FlightCorrectionMode.Handoff => 28d,
            _ => 8d,
        };
        var verticalRate = mode switch
        {
            FlightCorrectionMode.Ground => 12d,
            FlightCorrectionMode.Taxi => 20d,
            FlightCorrectionMode.Airborne => 90d,
            FlightCorrectionMode.Handoff => 130d,
            _ => 40d,
        };
        var attitudeRate = mode switch
        {
            FlightCorrectionMode.Ground => 1.5d,
            FlightCorrectionMode.Taxi => 2.5d,
            FlightCorrectionMode.Airborne => 6d,
            FlightCorrectionMode.Handoff => 9d,
            _ => 4d,
        };

        var maxHorizontalStep = horizontalRate * dt;
        var errorMagnitude = Math.Sqrt(error.EastMeters * error.EastMeters + error.NorthMeters * error.NorthMeters);
        var horizontalScale = errorMagnitude > 0d ? Math.Min(1d, maxHorizontalStep / errorMagnitude) : 0d;
        var correctedEast = error.EastMeters * horizontalScale;
        var correctedNorth = error.NorthMeters * horizontalScale;
        var (lat, lon) = OffsetLatLonMeters(current.Lat, current.Lon, correctedEast, correctedNorth);

        var correctedAlt = MoveTowards(current.Alt, target.Alt, verticalRate * dt);
        var correctedPitch = MoveTowards(current.Pitch, target.Pitch, attitudeRate * dt);
        var correctedBank = MoveTowards(current.Bank, target.Bank, attitudeRate * dt);
        var correctedHeading = MoveTowardsAngle(current.Heading, target.Heading, attitudeRate * dt * 1.2d);

        var speedFactor = mode switch
        {
            FlightCorrectionMode.Ground => 0.12d,
            FlightCorrectionMode.Taxi => 0.18d,
            FlightCorrectionMode.Airborne => 0.28d,
            FlightCorrectionMode.Handoff => 0.35d,
            _ => 0.2d,
        };

        return new FlightPoseState(
            lat,
            lon,
            correctedAlt,
            correctedPitch,
            correctedBank,
            correctedHeading,
            Lerp(current.GroundSpeed, target.GroundSpeed, speedFactor),
            Lerp(current.IndicatedAirspeed, target.IndicatedAirspeed, speedFactor),
            Lerp(current.VerticalSpeed, target.VerticalSpeed, speedFactor));
    }

    private void ApplyFlightPose(FlightPoseState pose)
    {
        _sim.WriteNumeric(PoseLatKey, pose.Lat);
        _sim.WriteNumeric(PoseLonKey, pose.Lon);
        _sim.WriteNumeric(PoseAltKey, pose.Alt);
        _sim.WriteNumeric(PosePitchKey, pose.Pitch);
        _sim.WriteNumeric(PoseBankKey, pose.Bank);
        _sim.WriteNumeric(PoseHeadingKey, pose.Heading);
        _sim.WriteNumeric(PoseGroundSpeedKey, pose.GroundSpeed);
        _sim.WriteNumeric(PoseVerticalSpeedKey, pose.VerticalSpeed);
    }

    private static double NormalizeHeading(double heading)
    {
        var normalized = heading % 360d;
        return normalized < 0 ? normalized + 360d : normalized;
    }

    private static double ShortestAngleDegrees(double from, double to)
    {
        var delta = (to - from + 540d) % 360d - 180d;
        return delta < -180d ? delta + 360d : delta;
    }

    private static FlightCorrectionMode ResolveFlightCorrectionMode(FlightPoseState current, RemoteFlightPoseTarget target)
    {
        if (target.RequiresSnap)
        {
            return FlightCorrectionMode.Handoff;
        }

        var groundSpeed = Math.Max(current.GroundSpeed, target.Pose.GroundSpeed);
        var airborne = current.IndicatedAirspeed > 70d || target.Pose.IndicatedAirspeed > 70d || current.Alt > 250d || target.Pose.Alt > 250d;
        if (airborne)
        {
            return FlightCorrectionMode.Airborne;
        }

        if (groundSpeed > 8d)
        {
            return FlightCorrectionMode.Taxi;
        }

        return FlightCorrectionMode.Ground;
    }

    private static FlightPoseState ExtrapolateFlightPose(RemoteFlightPoseTarget target, FlightCorrectionMode mode, long nowMs)
    {
        var elapsedMs = Math.Clamp(nowMs - target.ReceivedAtMs, 0, FlightPoseMaxExtrapolationMs);
        var dt = elapsedMs / 1000d;
        if (dt <= 0d)
        {
            return target.Pose;
        }

        var speedScale = mode switch
        {
            FlightCorrectionMode.Ground => 0.15d,
            FlightCorrectionMode.Taxi => 0.65d,
            FlightCorrectionMode.Airborne => 1d,
            FlightCorrectionMode.Handoff => 0.85d,
            _ => 0.75d,
        };
        var heading = NormalizeHeading(target.Pose.Heading);
        var trackRadians = DegreesToRadians(heading);
        var speedMetersPerSecond = target.Pose.GroundSpeed * 0.514444d * speedScale;
        var eastMeters = Math.Sin(trackRadians) * speedMetersPerSecond * dt;
        var northMeters = Math.Cos(trackRadians) * speedMetersPerSecond * dt;
        var (lat, lon) = OffsetLatLonMeters(target.Pose.Lat, target.Pose.Lon, eastMeters, northMeters);
        var alt = target.Pose.Alt + (target.Pose.VerticalSpeed / 60d) * dt * speedScale;

        return target.Pose with
        {
            Lat = lat,
            Lon = lon,
            Alt = alt,
        };
    }

    private sealed record LocalPoseError(double EastMeters, double NorthMeters)
    {
        public double HorizontalMeters => Math.Sqrt(EastMeters * EastMeters + NorthMeters * NorthMeters);
    }

    private static LocalPoseError ComputeLocalPoseError(FlightPoseState current, FlightPoseState target)
    {
        var lat0 = DegreesToRadians((current.Lat + target.Lat) / 2d);
        var east = DegreesToRadians(target.Lon - current.Lon) * 6371000d * Math.Cos(lat0);
        var north = DegreesToRadians(target.Lat - current.Lat) * 6371000d;
        return new LocalPoseError(east, north);
    }

    private static (double Lat, double Lon) OffsetLatLonMeters(double originLat, double originLon, double eastMeters, double northMeters)
    {
        const double earthRadiusMeters = 6371000d;
        var lat = originLat + RadiansToDegrees(northMeters / earthRadiusMeters);
        var cosLat = Math.Cos(DegreesToRadians(originLat));
        var safeCosLat = Math.Abs(cosLat) < 0.000001d ? 0.000001d : cosLat;
        var lon = originLon + RadiansToDegrees(eastMeters / (earthRadiusMeters * safeCosLat));
        return (lat, lon);
    }

    private static double Lerp(double current, double target, double factor) => current + (target - current) * factor;

    private static double LerpAngle(double current, double target, double factor) =>
        NormalizeHeading(current + ShortestAngleDegrees(current, target) * factor);

    private static double MoveTowards(double current, double target, double maxDelta)
    {
        var delta = target - current;
        if (Math.Abs(delta) <= maxDelta)
        {
            return target;
        }
        return current + Math.Sign(delta) * maxDelta;
    }

    private static double MoveTowardsAngle(double current, double target, double maxDelta)
    {
        var delta = ShortestAngleDegrees(current, target);
        if (Math.Abs(delta) <= maxDelta)
        {
            return NormalizeHeading(target);
        }
        return NormalizeHeading(current + Math.Sign(delta) * maxDelta);
    }

    private static double HorizontalDistanceMeters(double latA, double lonA, double latB, double lonB)
    {
        const double earthRadiusMeters = 6371000d;
        var lat1 = DegreesToRadians(latA);
        var lat2 = DegreesToRadians(latB);
        var dLat = lat2 - lat1;
        var dLon = DegreesToRadians(lonB - lonA);
        var x = dLon * Math.Cos((lat1 + lat2) / 2d);
        return Math.Sqrt(x * x + dLat * dLat) * earthRadiusMeters;
    }

    private static double DegreesToRadians(double degrees) => degrees * Math.PI / 180d;
    private static double RadiansToDegrees(double radians) => radians * 180d / Math.PI;

    private static string WriteOnlyTriggerSyntheticKey(string triggerLVar) => $"__trigger__:{triggerLVar}";

    private static string WriteOnlyTriggerFieldAndCodeKey(string triggerLVar, int commandCode) =>
        $"{triggerLVar}|{commandCode.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    private bool HandleWriteOnlyTriggerMirror(string key, double value)
    {
        if (!_writeOnlyTriggerMirrorsBySyntheticKey.TryGetValue(key, out var mirrors))
        {
            return false;
        }

        var rounded = (int)Math.Round(value);
        if (rounded == 0)
        {
            return true;
        }

        var candidates = mirrors.Where(m => m.CommandCode == rounded).ToList();
        if (candidates.Count == 0)
        {
            return true;
        }

        var ambiguityKey = WriteOnlyTriggerFieldAndCodeKey(candidates[0].TriggerLVar, rounded);

        var suppressKey = ambiguityKey;
        if (_writeOnlyTriggerEchoesToSuppress.TryGetValue(suppressKey, out var pending) && pending > 0)
        {
            if (pending == 1)
            {
                _writeOnlyTriggerEchoesToSuppress.Remove(suppressKey);
            }
            else
            {
                _writeOnlyTriggerEchoesToSuppress[suppressKey] = pending - 1;
            }

            return true;
        }

        EmitControlEvent(candidates[0].Control, true);
        return true;
    }

    private void EmitDebounced(ControlDefinition control, object value)
    {
        // Un pulso que acabamos de escribir NOSOTROS por orden del otro piloto no
        // puede volver a salir como si fuera un cambio local: el otro lado lo
        // reescribiría (los pulsos no pasan por AlreadyAtValue, ver ahí) y su botón
        // se pulsaría de nuevo, realimentando el ciclo. Para los controles
        // posicionales este eco es inofensivo porque AlreadyAtValue lo descarta en
        // el otro extremo -- ese filtro hacía doble función. Los pulsos, al quedar
        // fuera de él, necesitan la supresión explícita.
        if (ShouldSuppressPulseEcho(control, value))
        {
            return;
        }

        // Los pulsos tampoco se debouncean. El debouncer existe para colapsar
        // interruptores ruidosos, pero en un momentáneo el pulsar y el soltar son
        // AMBOS significativos y por definición caen dentro de la misma ventana: con
        // debounceMs=50 (lo que declara el perfil para los 560 pulsos con read) un
        // doble toque rápido perdía la segunda pulsación, y el soltar salía siempre
        // con retraso. Cada transición de un pulso tiene que salir tal cual.
        var debounceMs = MomentaryPulse.IsPulseControl(control)
            ? 0
            : control.Synchronization.DebounceMs;

        var emittedNow = _debouncer.ShouldEmitNow(
            control.Id,
            value,
            debounceMs,
            laterValue => EmitControlEvent(control, laterValue));

        if (emittedNow)
        {
            EmitControlEvent(control, value);
        }
    }

    /// <summary>
    /// Lecturas de pulsos que corresponden a una escritura que hicimos por orden
    /// remota, y que por tanto NO deben reemitirse como cambio local. Se consume la
    /// primera lectura que coincida con el valor escrito.
    /// </summary>
    private readonly Dictionary<string, object> _pulseEchoToSuppress = new(StringComparer.Ordinal);

    private bool ShouldSuppressPulseEcho(ControlDefinition control, object value)
    {
        if (!_pulseEchoToSuppress.TryGetValue(control.Id, out var expected))
        {
            return false;
        }

        if (!ValuesEquivalent(control.DataType, expected, value))
        {
            return false;
        }

        // Se consume: si el botón vuelve a moverse después, ese cambio SÍ es local y
        // tiene que salir.
        _pulseEchoToSuppress.Remove(control.Id);
        return true;
    }

    private void EmitControlEvent(ControlDefinition control, object value)
    {
        var evt = new ControlEventMessage(LocalSessionId, control.Id, value, SimSource, NextSequence(), NowMs());
        Broadcast(evt.ToJson());
    }

    private void MatchAndSubscribe(string title)
    {
        var result = ProfileMatcher.Match(_allProfiles, title);
        if (result.Profile is null)
        {
            _matchedProfile = null;
            _log.Warn($"Ningún perfil de aircraft-profiles/ coincide con el título detectado: '{title}'");

            // Si además hay perfiles rotos, decirlo ACÁ y no solo al arrancar: este
            // es el momento en que el usuario mira, y "no matching" a secas manda a
            // revisar detection.yaml cuando el problema real puede ser que el perfil
            // correcto ni siquiera se cargó (ver ReportProfilesThatFailedToLoad).
            var error = _failedProfileIds.Count == 0
                ? "no matching aircraft profile"
                : $"no matching aircraft profile (ojo: estos perfiles no se pudieron cargar y por eso " +
                  $"nunca van a detectarse: {string.Join(", ", _failedProfileIds)})";

            Broadcast(BridgeStatus.Build(true, null, title, error, SimulatorVersionLabel));
            return;
        }

        _matchedProfile = result.Profile;
        ClearPendingWriteConfirmations();
        _log.Info($"Perfil detectado: '{result.Profile.ProfileId}' (partialMatch={result.IsPartialMatch}) para título '{title}'");
        Broadcast(BridgeStatus.Build(true, result.Profile.ProfileId, title, null, SimulatorVersionLabel));
        SubscribeControls(result.Profile);
    }

    private void SubscribeControls(AircraftProfile profile)
    {
        ResetExternalSubscriptions();
        IndexWriteOnlyTriggerMirrors(profile);

        foreach (var control in profile.Controls)
        {
            // Controles writeOnly (ej. botones momentáneos del CDU/MCDU en
            // controls/mcdu.yaml) no declaran 'read' en el perfil (control.Read es
            // null) -- nunca hay nada que suscribir/leer para ellos, simplemente se
            // omiten (igual que ya se omite 'write' para los readOnly).
            if (control.WriteOnly || control.Read is null)
            {
                continue;
            }

            var mode = control.UsesFastChannel ? PollMode.Continuous : PollMode.OnChange;

            switch (control.Read.Type)
            {
                case ReadType.Simvar when control.DataType == ControlDataType.String:
                    _sim.SubscribeString(control.Id, control.Read.Name, mode);
                    break;

                case ReadType.Simvar:
                {
                    // Ver limitación documentada en SimConnectNativeClient: el esquema de
                    // control no declara "units", se usa un default por dataType.
                    var units = control.DataType == ControlDataType.Boolean ? "Bool" : "Number";
                    _sim.SubscribeNumeric(control.Id, control.Read.Name, units, mode);
                    break;
                }

                case ReadType.Lvar:
                    SubscribeLvarControl(control);
                    break;

                case ReadType.Hvar:
                    _log.Warn($"control '{control.Id}': read.type={control.Read.Type} requiere ejecución de calculator code vía WASM, no soportado por este proceso SimConnect puro. Se omite la suscripción.");
                    break;

                case ReadType.ClientDataArea:
                    SubscribeClientDataAreaControl(control);
                    break;
            }
        }

        SubscribeWriteOnlyTriggerMirrors();
        SubscribeScreens(profile);
    }

    private void ResetExternalSubscriptions()
    {
        _pmdgClient?.ResetSubscriptions();
        if (!ReferenceEquals(_sharedCockpitWasmClient, _pmdgClient))
        {
            _sharedCockpitWasmClient?.ResetSubscriptions();
        }
    }

    private void SubscribeLvarControl(ControlDefinition control)
    {
        var read = control.Read;
        if (read is null)
        {
            return;
        }

        var lvarName = !string.IsNullOrWhiteSpace(read.Name) ? read.Name : read.Field;
        if (string.IsNullOrWhiteSpace(lvarName))
        {
            _log.Warn($"control '{control.Id}': read.type=lvar sin nombre de L-Var. Se omite la suscripción.");
            Broadcast(BridgeError.Build(control.Id, "read", $"control '{control.Id}' declara read.type=lvar pero no trae nombre de L-Var"));
            return;
        }

        var client = ResolveClientDataClient("SharedCockpitBridge_LVars");
        if (!EnsurePmdgClientReady(client, "SharedCockpitBridge_LVars", control.Id, "read"))
        {
            return;
        }

        client!.SubscribeField(control.Id, "SharedCockpitBridge_LVars", lvarName, arrayIndex: null, ClientDataNativeType.Float);
    }

    private void IndexWriteOnlyTriggerMirrors(AircraftProfile profile)
    {
        _writeOnlyTriggerMirrorsBySyntheticKey.Clear();
        _writeOnlyTriggerMirrorsByFieldAndCode.Clear();
        _writeOnlyTriggerEchoesToSuppress.Clear();
        _writeOnlyTriggerDuplicateWarnings.Clear();
        _writeOnlyTriggerAmbiguousKeys.Clear();

        foreach (var control in profile.Controls)
        {
            if (!control.WriteOnly || control.Write is not { Type: WriteType.CalculatorCode } write)
            {
                continue;
            }

            if (!MomentaryPulse.TryParseSinglePress(write.Name, out var triggerLVar, out var commandCode))
            {
                continue;
            }

            var syntheticKey = WriteOnlyTriggerSyntheticKey(triggerLVar);
            if (!_writeOnlyTriggerMirrorsBySyntheticKey.TryGetValue(syntheticKey, out var mirrorsForTrigger))
            {
                mirrorsForTrigger = new List<WriteOnlyTriggerMirror>();
                _writeOnlyTriggerMirrorsBySyntheticKey[syntheticKey] = mirrorsForTrigger;
            }

            var mirror = new WriteOnlyTriggerMirror(triggerLVar, commandCode, control);
            mirrorsForTrigger.Add(mirror);

            var fieldAndCodeKey = WriteOnlyTriggerFieldAndCodeKey(triggerLVar, commandCode);
            if (!_writeOnlyTriggerMirrorsByFieldAndCode.TryGetValue(fieldAndCodeKey, out var mirrorsForFieldAndCode))
            {
                mirrorsForFieldAndCode = new List<WriteOnlyTriggerMirror>();
                _writeOnlyTriggerMirrorsByFieldAndCode[fieldAndCodeKey] = mirrorsForFieldAndCode;
            }

            mirrorsForFieldAndCode.Add(mirror);
        }

        foreach (var (fieldAndCodeKey, mirrorsForFieldAndCode) in _writeOnlyTriggerMirrorsByFieldAndCode.ToArray())
        {
            if (mirrorsForFieldAndCode.Count <= 1)
            {
                continue;
            }

            _writeOnlyTriggerAmbiguousKeys.Add(fieldAndCodeKey);
            if (_writeOnlyTriggerDuplicateWarnings.Add(fieldAndCodeKey))
            {
                var trigger = mirrorsForFieldAndCode[0].TriggerLVar;
                var code = mirrorsForFieldAndCode[0].CommandCode;
                var controls = string.Join(", ", mirrorsForFieldAndCode.Select(c => c.Control.Id).OrderBy(id => id, StringComparer.Ordinal));
                _log.Warn(
                    $"trigger writeOnly ambiguo '{trigger}' con codigo {code}: varios controles comparten exactamente la misma señal ({controls}). " +
                    "Ese pulso local se reenviará usando un control canónico estable para no perder sincronización entre PCs.");
                Broadcast(BridgeError.Build(
                    string.Empty,
                    "read",
                    $"trigger ambiguo '{trigger}' codigo {code}: {controls}. Se reenviara usando un control canonico estable para conservar la sincronizacion"));
            }
        }
    }

    private void SubscribeWriteOnlyTriggerMirrors()
    {
        foreach (var triggerLVar in _writeOnlyTriggerMirrorsBySyntheticKey.Values
                     .Select(mirrors => mirrors[0].TriggerLVar)
                     .Distinct(StringComparer.Ordinal))
        {
            var client = ResolveClientDataClient("SharedCockpitBridge_LVars");
            var representative = _writeOnlyTriggerMirrorsBySyntheticKey[WriteOnlyTriggerSyntheticKey(triggerLVar)][0];
            if (!EnsurePmdgClientReady(client, "SharedCockpitBridge_LVars", representative.Control.Id, "read"))
            {
                continue;
            }

            client!.SubscribeField(
                WriteOnlyTriggerSyntheticKey(triggerLVar),
                "SharedCockpitBridge_LVars",
                triggerLVar,
                arrayIndex: null,
                ClientDataNativeType.Float);
        }
    }

    /// <summary>
    /// Suscribe un control read.type=clientDataArea (SDK de terceros, ej. PMDG NG3
    /// PMDG_NG3_Data). Ver SimConnectInterop/PmdgClientDataClient.cs para el
    /// estado de verificación honesto (NO probado contra MSFS/PMDG real). Si el
    /// cliente dedicado no está inyectado, no puede conectar, o el campo no está
    /// soportado todavía, se loggea un warning y se omite ese control SIN afectar
    /// el resto del perfil ni crashear el proceso.
    /// </summary>
    private void SubscribeClientDataAreaControl(ControlDefinition control)
    {
        // control.Read puede ser null si el control es writeOnly (ej. botones del
        // CDU); este método solo se alcanza desde SubscribeControls tras verificar
        // que no lo es, pero se re-verifica aquí (método separado, el compilador no
        // propaga el análisis de nulabilidad entre métodos) para evitar cualquier
        // NullReferenceException.
        var read = control.Read;
        if (read is null)
        {
            _log.Warn($"control '{control.Id}': read.type=clientDataArea sin bloque 'read' definido (writeOnly). Se ignora la suscripción.");
            return;
        }

        var areaName = read.AreaName ?? string.Empty;
        var client = ResolveClientDataClient(areaName);
        if (!EnsurePmdgClientReady(client, areaName, control.Id, "read"))
        {
            return;
        }

        var field = read.Field ?? string.Empty;
        var nativeType = read.NativeType ?? ClientDataNativeType.Bool;
        client!.SubscribeField(control.Id, areaName, field, read.ArrayIndex, nativeType);
    }

    private void SubscribeScreens(AircraftProfile profile)
    {
        foreach (var screen in profile.Screens)
        {
            var client = ResolveClientDataClient(screen.AreaName);
            if (!EnsurePmdgClientReady(client, screen.AreaName, screen.Id, "read"))
            {
                continue;
            }

            client!.SubscribeScreen(screen);
        }
    }

    /// <summary>
    /// Resuelve qué cliente de Client Data Area es dueño de un areaName dado.
    /// "PMDG_NG3_Data"/"PMDG_NG3_Control" → _pmdgClient (SDK oficial de PMDG).
    /// "SharedCockpitBridge_LVars" → _sharedCockpitWasmClient (módulo WASM propio
    /// del proyecto, ver simulator/wasm-bridge). Cualquier otro nombre no tiene
    /// cliente asignado todavía (null, se reporta como error estructurado más
    /// arriba en la cadena de llamadas, no aquí).
    /// </summary>
    private IPmdgClientDataClient? ResolveClientDataClient(string areaName) => areaName switch
    {
        "PMDG_NG3_Data" or "PMDG_NG3_Control" or "PMDG_NG3_CDU_0" or "PMDG_NG3_CDU_1" => _pmdgClient,
        "SharedCockpitBridge_LVars" => _sharedCockpitWasmClient,
        _ => null,
    };

    /// <summary>
    /// Verifica (y, si hace falta, intenta abrir) la conexión dedicada al SDK de
    /// terceros o al módulo WASM propio, según cuál área se está pidiendo.
    /// Reporta como warning/BridgeError la primera vez que no está disponible
    /// por perfil, sin reintentar en cada Pump (evita spam de logs).
    /// </summary>
    private bool EnsurePmdgClientReady(IPmdgClientDataClient? client, string areaName, string controlId, string direction)
    {
        if (client is null)
        {
            if (!_pmdgUnavailableWarned)
            {
                _pmdgUnavailableWarned = true;
                _log.Warn($"El perfil activo declara un control clientDataArea para '{areaName}', pero el bridge no tiene ningún cliente asignado a esa área (ver Program.cs / BridgeService.ResolveClientDataClient). Esos controles no se sincronizarán.");
            }

            Broadcast(BridgeError.Build(controlId, direction, $"ningún cliente Client Data Area configurado para el área '{areaName}'"));
            return false;
        }

        if (client.IsConnected)
        {
            return true;
        }

        if (client.TryConnect(_appName))
        {
            return true;
        }

        if (!_pmdgUnavailableWarned)
        {
            _pmdgUnavailableWarned = true;
            _log.Warn($"No se pudo conectar el cliente Client Data Area para '{areaName}' — ¿el addon/módulo correspondiente no está cargado? Esos controles no se sincronizarán hasta la próxima reconexión.");
        }

        Broadcast(BridgeError.Build(controlId, direction, $"no se pudo conectar el cliente Client Data Area para '{areaName}'"));
        return false;
    }

    private void OnPmdgWarning(string message)
    {
        _log.Warn($"[SDK terceros] {message}");

        // Estos avisos venían quedándose SOLO en bridge.log, y varios son
        // diagnósticos de primera importancia: el más claro es "se deja de leer ESE
        // control porque la L-Var no existe en esta aeronave", que significa que ese
        // control no va a sincronizar nunca en esta variante. Sin esto, el reporte
        // descargable no los vería y habría que volver a pedir el archivo de log a
        // mano. El controlId va vacío porque el aviso llega como texto plano desde
        // el cliente (la interfaz IPmdgClientDataClient.Warning no lo separa) y el
        // mensaje ya lo nombra -- preferible a parsearlo con una expresión regular
        // que se rompa al reescribir el texto.
        Broadcast(BridgeError.Build(string.Empty, "read", message));
    }

    private void OnScreenSnapshotReceived(ScreenSnapshotMessage message)
    {
        Broadcast(message.ToJson());
    }

    /// <summary>
    /// Publica bridge.diagnostics cada DiagnosticsIntervalMs. Alimenta el reporte
    /// descargable de la UI ("Download report" en la vista Cockpit): así el usuario
    /// no tiene que ir a buscar bridge.log en %APPDATA%, y el reporte trae los
    /// contadores agregados, que es lo que permite ver de un golpe si hay un fallo
    /// en masa en vez de leer líneas sueltas.
    /// </summary>
    private void EmitDiagnosticsIfDue()
    {
        var nowMs = NowMs();
        if (nowMs - _lastDiagnosticsAtMs < DiagnosticsIntervalMs)
        {
            return;
        }

        _lastDiagnosticsAtMs = nowMs;

        var activeProfileId = ActiveProfileId;
        var invertedForThisProfile = _polarity.InvertedKeys
            .Where(k => k.StartsWith($"{activeProfileId}:", StringComparison.Ordinal))
            .Select(k => k[(activeProfileId.Length + 1)..])
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();

        Broadcast(BridgeDiagnostics.Build(
            matchedProfileId: _matchedProfile?.ProfileId,
            detectedTitle: _lastTitle,
            controlsSubscribed: _matchedProfile?.Controls.Count ?? 0,
            controlsReporting: _lastObservedByControl.Count,
            writesAttempted: _writesAttempted,
            writesSkippedAlreadyAtValue: _writesSkippedAlreadyAtValue,
            writesConfirmed: _writesConfirmed,
            writesFailed: _writesFailed,
            polarityInversionsLearned: invertedForThisProfile.Length,
            pulsePressesWritten: _pulsePressesWritten,
            errorsReported: _errorsReported,
            polarityInvertedControls: invertedForThisProfile));
    }

    private long NextSequence() => Interlocked.Increment(ref _sequence);

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public async ValueTask DisposeAsync()
    {
        _sim.Connected -= OnConnected;
        _sim.Disconnected -= OnDisconnected;
        _sim.SimConnectException -= OnSimConnectException;
        _sim.NumericValueReceived -= OnNumericValueReceived;
        _sim.StringValueReceived -= OnStringValueReceived;
        _debouncer.Dispose();
        _sim.Dispose();

        if (_pmdgClient is not null)
        {
            _pmdgClient.Warning -= OnPmdgWarning;
            _pmdgClient.FieldValueReceived -= OnNumericValueReceived;
            _pmdgClient.StringFieldValueReceived -= OnStringValueReceived;
            _pmdgClient.ScreenSnapshotReceived -= OnScreenSnapshotReceived;
            _pmdgClient.Dispose();
        }

        if (_sharedCockpitWasmClient is not null)
        {
            _sharedCockpitWasmClient.Warning -= OnPmdgWarning;
            _sharedCockpitWasmClient.FieldValueReceived -= OnNumericValueReceived;
            _sharedCockpitWasmClient.StringFieldValueReceived -= OnStringValueReceived;
            _sharedCockpitWasmClient.ScreenSnapshotReceived -= OnScreenSnapshotReceived;
            _sharedCockpitWasmClient.Dispose();
        }

        await Task.CompletedTask;
    }
}
