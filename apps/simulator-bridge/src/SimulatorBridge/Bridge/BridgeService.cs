using System.Text.Json.Nodes;
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
    private readonly ProfileRepository _profileRepo;
    private readonly ILog _log;
    private readonly Action<JsonObject> _broadcast;
    private readonly SimulatorVersion _simVersion;
    private readonly string _appName;
    private readonly TimeSpan _reconnectInterval;
    private readonly TimeSpan _pumpInterval;
    private readonly ControlValueDebouncer _debouncer = new();

    private IReadOnlyList<AircraftProfile> _allProfiles = Array.Empty<AircraftProfile>();
    private AircraftProfile? _matchedProfile;
    private string? _lastTitle;
    private long _sequence;
    private bool _pmdgUnavailableWarned;

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
        IPmdgClientDataClient? sharedCockpitWasmClient = null)
    {
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
        }

        if (_sharedCockpitWasmClient is not null)
        {
            _sharedCockpitWasmClient.Warning += OnPmdgWarning;
            _sharedCockpitWasmClient.FieldValueReceived += OnNumericValueReceived;
            _sharedCockpitWasmClient.StringFieldValueReceived += OnStringValueReceived;
        }
    }

    public AircraftProfile? MatchedProfile => _matchedProfile;
    private string SimulatorVersionLabel =>
        _simVersion == SimulatorVersion.Msfs2020 ? "msfs2020" : "msfs2024";

    public async Task RunAsync(CancellationToken ct)
    {
        _allProfiles = _profileRepo.LoadAll(_simVersion, _log);
        _log.Info($"Perfiles cargados: {string.Join(", ", _allProfiles.Select(p => p.ProfileId))}");

        while (!ct.IsCancellationRequested)
        {
            if (!_sim.IsConnected)
            {
                _log.Info("Buscando MSFS en ejecución...");
                var connected = _sim.TryConnect(_appName);
                if (!connected)
                {
                    _broadcast(BridgeStatus.Build(false, null, null, null, SimulatorVersionLabel));
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

            _sim.Pump();
            _pmdgClient?.Pump();
            _sharedCockpitWasmClient?.Pump();

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
            case IncomingUnknown unknown:
                _log.Debug($"Mensaje entrante de tipo no manejado por el bridge: '{unknown.RawType}'");
                break;
        }
    }

    private void HandleIncomingControlEvent(IncomingControlEvent ce)
    {
        var control = RequireControlForWrite(ce.ControlId);
        if (control is null)
        {
            return;
        }

        object value = control.DataType switch
        {
            ControlDataType.Boolean => ce.AsBool(),
            ControlDataType.Number => ce.AsNumber(),
            ControlDataType.String => ce.AsString(),
            _ => ce.AsString(),
        };

        WriteControl(control, value);
    }

    private void HandleIncomingControlAxis(IncomingControlAxis ca)
    {
        var control = RequireControlForWrite(ca.ControlId);
        if (control is null)
        {
            return;
        }

        WriteControl(control, ca.Value);
    }

    private ControlDefinition? RequireControlForWrite(string controlId)
    {
        if (_matchedProfile is null)
        {
            _log.Warn($"control recibido ('{controlId}') ignorado: no hay perfil de aeronave activo todavía");
            _broadcast(BridgeError.Build(controlId, "write", "no hay perfil de aeronave activo"));
            return null;
        }

        var control = _matchedProfile.FindControl(controlId);
        if (control is null)
        {
            _log.Warn($"control recibido ('{controlId}') no existe en el perfil activo '{_matchedProfile.ProfileId}'");
            _broadcast(BridgeError.Build(controlId, "write", $"control no declarado en el perfil '{_matchedProfile.ProfileId}'"));
            return null;
        }

        // Controles readOnly (ej. anunciadores del PMDG NG3 SDK) no declaran
        // 'write' en el perfil (control.Write es null) -- nunca se debe intentar
        // escribirlos, solo reportar el intento como error estructurado.
        if (control.ReadOnly || control.Write is null)
        {
            _log.Warn($"control recibido ('{controlId}') es readOnly en el perfil activo '{_matchedProfile.ProfileId}': se ignora la escritura");
            _broadcast(BridgeError.Build(controlId, "write", $"control '{controlId}' es de solo lectura (readOnly) en el perfil '{_matchedProfile.ProfileId}'"));
            return null;
        }

        return control;
    }

    private void WriteControl(ControlDefinition control, object value)
    {
        // RequireControlForWrite ya garantiza que control.Write no es null (controles
        // readOnly se descartan ahí), pero se deja explícito por robustez ante
        // futuros llamadores directos de WriteControl.
        if (control.Write is null)
        {
            _log.Warn($"control '{control.Id}': intento de escritura sin bloque 'write' definido (readOnly). Se ignora.");
            _broadcast(BridgeError.Build(control.Id, "write", $"control '{control.Id}' no tiene 'write' definido (readOnly)"));
            return;
        }

        switch (control.Write.Type)
        {
            case WriteType.InputEvent:
            {
                // SIEMPRE SET_ON/SET_OFF/SET_VALUE explícito -- nunca un pulso TOGGLE crudo
                // (regla de oro anti-toggle, ver CLAUDE.md raíz y packages/protocol/README.md).
                var dwData = value switch
                {
                    bool b => b ? 1u : 0u,
                    double d => unchecked((uint)Math.Round(d)),
                    string => 0u,
                    _ => 0u,
                };

                _sim.TransmitSetEvent(control.Write.Name, dwData);
                break;
            }

            case WriteType.Hvar:
            case WriteType.CalculatorCode:
                // No soportado por un bridge SimConnect "puro": H:vars y calculator code
                // (RPN) solo se pueden ejecutar dentro de un gauge/WASM module
                // (execute_calculator_code), no vía las funciones estándar de
                // SimConnect que usa este proceso. Esto es responsabilidad de
                // wasm-agent (ver docs/plan-maestro.md Fase 1: "Agentes:
                // simconnect-bridge-agent, wasm-agent"). Se reporta como error
                // estructurado en vez de fallar silenciosamente o hacer un TOGGLE.
                _log.Warn($"control '{control.Id}': write.type={control.Write.Type} requiere ejecución de calculator code vía WASM, no soportado por este proceso SimConnect puro.");
                _broadcast(BridgeError.Build(control.Id, "write", $"write.type={control.Write.Type} requiere el bridge WASM (no implementado en Sprint 1)"));
                break;

            case WriteType.ClientDataEvent:
                WriteClientDataEventControl(control);
                break;

            case WriteType.NativeEventValue:
                WriteNativeEventValueControl(control);
                break;
        }
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
    private void WriteNativeEventValueControl(ControlDefinition control)
    {
        var write = control.Write!;
        if (write.Parameter is null || !uint.TryParse(write.Parameter, out var dwData))
        {
            _log.Warn($"control '{control.Id}': write.type=nativeEventValue con 'parameter' inválido o ausente ('{write.Parameter}').");
            _broadcast(BridgeError.Build(control.Id, "write", $"control '{control.Id}': parameter inválido para nativeEventValue"));
            return;
        }

        _sim.TransmitSetEvent(write.Name, dwData);
    }

    /// <summary>
    /// Escribe un control write.type=clientDataEvent (SDK de terceros, ej. PMDG
    /// NG3). Regla anti-TOGGLE: control.Write.Semantics es obligatorio en el
    /// esquema (validado por tools/validate_profiles.py) precisamente para que un
    /// Event de PMDG quede tan auditable como un SET_ON/SET_OFF estándar. Nunca
    /// crashea si el SDK de terceros no está disponible: se loggea un warning y
    /// se reporta un BridgeError estructurado, sin afectar otros controles.
    /// </summary>
    private void WriteClientDataEventControl(ControlDefinition control)
    {
        // control.Write puede ser null si el control es readOnly; este método solo
        // se alcanza desde WriteControl tras verificar que no lo es, pero se
        // re-verifica aquí (método separado, el compilador no propaga el análisis
        // de nulabilidad entre métodos) para evitar cualquier NullReferenceException.
        var write = control.Write;
        if (write is null)
        {
            _log.Warn($"control '{control.Id}': write.type=clientDataEvent sin bloque 'write' definido (readOnly). Se ignora.");
            _broadcast(BridgeError.Build(control.Id, "write", $"control '{control.Id}' no tiene 'write' definido (readOnly)"));
            return;
        }

        var areaName = write.AreaName ?? string.Empty;
        if (!EnsurePmdgClientReady(_pmdgClient, areaName, control.Id, "write"))
        {
            return;
        }

        var eventIdOrName = write.Event ?? string.Empty;
        var ok = _pmdgClient!.WriteControlEvent(areaName, eventIdOrName, write.Parameter);
        if (!ok)
        {
            _broadcast(BridgeError.Build(control.Id, "write", $"clientDataEvent '{eventIdOrName}' en área '{areaName}' no se pudo escribir (ver logs del bridge para el motivo)"));
        }
    }

    private void OnConnected()
    {
        _log.Info("SimConnect conectado a MSFS.");
        _matchedProfile = null;
        _lastTitle = null;
        _pmdgUnavailableWarned = false;
        _sim.SubscribeString(TitleKey, "TITLE", PollMode.OnChange);
        _broadcast(BridgeStatus.Build(true, null, null, null, SimulatorVersionLabel));
    }

    private void OnDisconnected()
    {
        _log.Warn("SimConnect desconectado (¿se cerró MSFS?). Reintentando periódicamente.");
        _matchedProfile = null;
        _lastTitle = null;
        _broadcast(BridgeStatus.Build(false, null, null, null, SimulatorVersionLabel));
    }

    private void OnSimConnectException(string message)
    {
        _log.Error($"SimConnect: {message}");
        _broadcast(BridgeError.Build("<simconnect>", "sim", message));
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

        EmitDebounced(control, value);
    }

    private void OnNumericValueReceived(string key, double value)
    {
        var control = _matchedProfile?.FindControl(key);
        if (control is null)
        {
            // Puede ocurrir brevemente tras un cambio de perfil (mensajes en vuelo de suscripciones viejas).
            return;
        }

        if (control.UsesFastChannel)
        {
            var axis = new ControlAxisMessage(LocalSessionId, control.Id, value, NextSequence(), NowMs());
            _broadcast(axis.ToJson());
            return;
        }

        object typedValue = control.DataType == ControlDataType.Boolean ? value != 0 : value;
        EmitDebounced(control, typedValue);
    }

    private void EmitDebounced(ControlDefinition control, object value)
    {
        var emittedNow = _debouncer.ShouldEmitNow(
            control.Id,
            value,
            control.Synchronization.DebounceMs,
            laterValue => EmitControlEvent(control, laterValue));

        if (emittedNow)
        {
            EmitControlEvent(control, value);
        }
    }

    private void EmitControlEvent(ControlDefinition control, object value)
    {
        var evt = new ControlEventMessage(LocalSessionId, control.Id, value, SimSource, NextSequence(), NowMs());
        _broadcast(evt.ToJson());
    }

    private void MatchAndSubscribe(string title)
    {
        var result = ProfileMatcher.Match(_allProfiles, title);
        if (result.Profile is null)
        {
            _matchedProfile = null;
            _log.Warn($"Ningún perfil de aircraft-profiles/ coincide con el título detectado: '{title}'");
            _broadcast(BridgeStatus.Build(true, null, title, "no matching aircraft profile", SimulatorVersionLabel));
            return;
        }

        _matchedProfile = result.Profile;
        _log.Info($"Perfil detectado: '{result.Profile.ProfileId}' (partialMatch={result.IsPartialMatch}) para título '{title}'");
        _broadcast(BridgeStatus.Build(true, result.Profile.ProfileId, title, null, SimulatorVersionLabel));
        SubscribeControls(result.Profile);
    }

    private void SubscribeControls(AircraftProfile profile)
    {
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
                case ReadType.Hvar:
                    _log.Warn($"control '{control.Id}': read.type={control.Read.Type} requiere ejecución de calculator code vía WASM, no soportado por este proceso SimConnect puro. Se omite la suscripción.");
                    break;

                case ReadType.ClientDataArea:
                    SubscribeClientDataAreaControl(control);
                    break;
            }
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
        "PMDG_NG3_Data" or "PMDG_NG3_Control" => _pmdgClient,
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

            _broadcast(BridgeError.Build(controlId, direction, $"ningún cliente Client Data Area configurado para el área '{areaName}'"));
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

        _broadcast(BridgeError.Build(controlId, direction, $"no se pudo conectar el cliente Client Data Area para '{areaName}'"));
        return false;
    }

    private void OnPmdgWarning(string message)
    {
        _log.Warn($"[SDK terceros] {message}");
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
            _pmdgClient.Dispose();
        }

        if (_sharedCockpitWasmClient is not null)
        {
            _sharedCockpitWasmClient.Warning -= OnPmdgWarning;
            _sharedCockpitWasmClient.FieldValueReceived -= OnNumericValueReceived;
            _sharedCockpitWasmClient.StringFieldValueReceived -= OnStringValueReceived;
            _sharedCockpitWasmClient.Dispose();
        }

        await Task.CompletedTask;
    }
}
