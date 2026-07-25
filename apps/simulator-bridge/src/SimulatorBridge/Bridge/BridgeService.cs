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

    public BridgeService(
        ISimConnectClient sim,
        ProfileRepository profileRepo,
        ILog log,
        Action<JsonObject> broadcast,
        SimulatorVersion simVersion,
        string appName = "SharedCockpit.Bridge",
        TimeSpan? reconnectInterval = null,
        TimeSpan? pumpInterval = null)
    {
        _sim = sim;
        _profileRepo = profileRepo;
        _log = log;
        _broadcast = broadcast;
        _simVersion = simVersion;
        _appName = appName;
        _reconnectInterval = reconnectInterval ?? TimeSpan.FromSeconds(5);
        _pumpInterval = pumpInterval ?? TimeSpan.FromMilliseconds(33);

        _sim.Connected += OnConnected;
        _sim.Disconnected += OnDisconnected;
        _sim.SimConnectException += OnSimConnectException;
        _sim.NumericValueReceived += OnNumericValueReceived;
        _sim.StringValueReceived += OnStringValueReceived;
    }

    public AircraftProfile? MatchedProfile => _matchedProfile;

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
                    _broadcast(BridgeStatus.Build(false, null, null, null));
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
        }

        return control;
    }

    private void WriteControl(ControlDefinition control, object value)
    {
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
        }
    }

    private void OnConnected()
    {
        _log.Info("SimConnect conectado a MSFS.");
        _matchedProfile = null;
        _lastTitle = null;
        _sim.SubscribeString(TitleKey, "TITLE", PollMode.OnChange);
        _broadcast(BridgeStatus.Build(true, null, null, null));
    }

    private void OnDisconnected()
    {
        _log.Warn("SimConnect desconectado (¿se cerró MSFS?). Reintentando periódicamente.");
        _matchedProfile = null;
        _lastTitle = null;
        _broadcast(BridgeStatus.Build(false, null, null, null));
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
            _broadcast(BridgeStatus.Build(true, null, title, "no matching aircraft profile"));
            return;
        }

        _matchedProfile = result.Profile;
        _log.Info($"Perfil detectado: '{result.Profile.ProfileId}' (partialMatch={result.IsPartialMatch}) para título '{title}'");
        _broadcast(BridgeStatus.Build(true, result.Profile.ProfileId, title, null));
        SubscribeControls(result.Profile);
    }

    private void SubscribeControls(AircraftProfile profile)
    {
        foreach (var control in profile.Controls)
        {
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
            }
        }
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
        await Task.CompletedTask;
    }
}
