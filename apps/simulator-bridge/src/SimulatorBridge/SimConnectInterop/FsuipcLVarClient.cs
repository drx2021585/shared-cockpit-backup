using FSUIPC;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Profiles;

namespace SharedCockpit.Bridge.SimConnectInterop;

/// <summary>
/// ====================================================================================
/// Lectura de L-Vars vía FSUIPC7 (FSUIPCClientDLL de Paul Henty, paquete NuGet
/// "FSUIPCClientDLL") -- reemplaza, para lectura, al módulo WASM propio
/// (SharedCockpitWasmClient.cs / simulator/wasm-bridge) que compilamos esta
/// misma noche pero nunca se probó cargando de verdad en MSFS.
///
/// Por qué el cambio: Darwin ya tiene FSUIPC7 instalado y corriendo en su
/// máquina, con su WAPI (módulo WASM propio de FSUIPC, maduro, usado por años
/// por la comunidad) ya conectado -- confirmado en vivo en
/// C:\FSUIPC7\FSUIPC7.log: "Lvars received: 4265 L:vars & 0 H:vars now
/// available". Usar esto es mucho menor riesgo que confiar en nuestro propio
/// módulo WASM recién escrito.
///
/// FSUIPCConnection es una clase ESTÁTICA (una sola conexión FSUIPC por
/// proceso) -- esta clase envuelve esa API estática detrás de la misma
/// interfaz IPmdgClientDataClient que ya usan PmdgClientDataClient y
/// SharedCockpitWasmClient, para que BridgeService pueda tratarlas de forma
/// intercambiable (ver BridgeService.ResolveClientDataClient).
///
/// areaName aceptado: "SharedCockpitBridge_LVars" (mismo nombre que usaba el
/// módulo WASM propio en los perfiles -- no hizo falta tocar
/// native-toggle-switches.yaml, 'field' ya era el nombre real de la L-Var,
/// ej. "L:switch_117_73X", que es exactamente lo que ReadLVar espera).
///
/// Requiere: FSUIPC7 instalado y corriendo junto a MSFS (ver
/// https://fsuipc.com/fsuipc7/), con el WAPI conectado (se confirma solo,
/// FSUIPC7 lo hace automáticamente al detectar la simulación). Si FSUIPC7 no
/// está corriendo, Open() lanza FSUIPCException -- se captura y se reporta
/// como warning/BridgeError, igual que el resto de los clientes opcionales
/// de este bridge (nunca crashea el resto del proceso).
/// ====================================================================================
/// </summary>
public sealed class FsuipcLVarClient : IPmdgClientDataClient, ICalculatorCodeClient
{
    private const string AreaName = "SharedCockpitBridge_LVars";

    private sealed record TrackedField(string ControlId, string LVarName, double LastValue);

    private readonly Dictionary<string, TrackedField> _tracked = new(StringComparer.Ordinal);

    /// <summary>
    /// True una vez que MSFSVariableServices.Init()/Start() se llamaron sin
    /// excepción (no implica que el módulo WASM/WAPI (FSUIPC_WAPID.dll) ya esté
    /// respondiendo dentro del sim -- eso se verifica por separado en cada
    /// ExecuteCalculatorCode vía MSFSVariableServices.IsRunning, porque el
    /// arranque del WASM module dentro de MSFS puede tardar unos segundos más
    /// que la apertura de la conexión FSUIPC7 misma).
    /// </summary>
    private bool _calculatorCodeInitAttempted;

    public bool IsConnected { get; private set; }

    public event Action? Connected;
    public event Action? Disconnected;
    public event Action<string>? Warning;
    public event Action<string, double>? FieldValueReceived;
    public event Action<string, string>? StringFieldValueReceived;

    public bool TryConnect(string appName)
    {
        if (IsConnected)
        {
            return true;
        }

        try
        {
            FSUIPCConnection.Open();
        }
        catch (FSUIPCException ex)
        {
            Warning?.Invoke($"No se pudo conectar a FSUIPC7 (¿está instalado y corriendo?): {ex.Message}");
            return false;
        }
        catch (Exception ex)
        {
            Warning?.Invoke($"Error inesperado abriendo la conexión a FSUIPC7: {ex.Message}");
            return false;
        }

        IsConnected = true;
        Connected?.Invoke();

        // Best-effort: arranca también el módulo WASM/WAPI de FSUIPC7 (John
        // Dowson's WASM module, FSUIPC_WAPID.dll) para poder ejecutar calculator
        // code (ver ICalculatorCodeClient). Si falla (ej. FSUIPC_WAPID.dll no
        // está junto al .exe del bridge, o el WASM module no está en el sim), se
        // reporta como warning y los controles calculatorCode simplemente no se
        // sincronizan -- NO afecta la lectura de L-Vars (_tracked), que sigue
        // funcionando igual que antes por el mecanismo clásico de FSUIPC7.
        if (!_calculatorCodeInitAttempted)
        {
            _calculatorCodeInitAttempted = true;
            try
            {
                MSFSVariableServices.Init();

                // Frecuencia de actualización del WAPI, en Hz. Es la cadencia REAL a
                // la que se pueden observar los cambios de cabina, así que decide si
                // una pulsación de botón se ve o no: un clic de ratón dura 60-150 ms.
                MSFSVariableServices.LVARUpdateFrequency = LVarUpdateFrequencyHz;

                // Suscripción al empuje de cambios ANTES de Start(), para no perder
                // los primeros.
                MSFSVariableServices.OnValuesChanged += OnWapiValuesChanged;
                MSFSVariableServices.Start();
                _wapiPushActive = true;
            }
            catch (Exception ex)
            {
                Warning?.Invoke(
                    "No se pudo iniciar MSFSVariableServices (módulo WASM/WAPI de FSUIPC7): " +
                    $"{ex.Message}. ¿Está FSUIPC_WAPID.dll junto a SharedCockpit.Bridge.exe? Se cae al sondeo " +
                    "clásico con ReadLVar, que funciona pero es MUCHO más lento (ver la nota de Pump).");
            }
        }

        return true;
    }

    public void Disconnect()
    {
        if (!IsConnected)
        {
            return;
        }

        try
        {
            FSUIPCConnection.Close();
        }
        catch
        {
            // Cierre best-effort -- no hay nada más que hacer si falla al cerrar.
        }

        IsConnected = false;
        Disconnected?.Invoke();
    }

    /// <summary>
    /// Cadencia de actualización del WAPI, en Hz.
    ///
    /// Importa mucho más de lo que parece: es el ritmo al que se puede OBSERVAR la
    /// cabina, y un clic de ratón dura 60-150 ms. Medido en vivo el 2026-07-30, el
    /// sondeo anterior daba un ciclo real de 624 ms (1.6 Hz) y con eso se perdían
    /// 4 de cada 6 pulsaciones de una tecla del CDU -- no se perdían "por el
    /// camino": nadie estaba mirando cuando ocurrieron.
    ///
    /// 25 Hz (40 ms) deja ver cualquier pulsación humana con margen, y como el WAPI
    /// solo notifica lo que CAMBIÓ, subir la frecuencia no multiplica el trabajo:
    /// en una cabina quieta no llega nada.
    /// </summary>
    private const int LVarUpdateFrequencyHz = 25;

    /// <summary>
    /// True cuando la suscripción a OnValuesChanged está activa, o sea cuando los
    /// cambios LLEGAN EMPUJADOS y no hay que sondear.
    /// </summary>
    private bool _wapiPushActive;

    /// <summary>
    /// FSUIPC avisa de que hubo cambios y deja SOLO los que cambiaron en
    /// LVarsChanged. Esto reemplaza al sondeo de 982 ReadLVar por ciclo.
    ///
    /// El coste del sondeo estaba escondido: no producía ningún error, así que se
    /// dio por bueno. Pero cada ReadLVar es una ida y vuelta a FSUIPC (~0.6 ms), y
    /// 982 de ellas por ciclo tardaban 624 ms. Con este camino no se pide nada: el
    /// módulo WASM de FSUIPC ya mantiene el caché y notifica las diferencias.
    /// </summary>
    private void OnWapiValuesChanged(object? sender, EventArgs e)
    {
        try
        {
            foreach (var name in MSFSVariableServices.LVarsChanged.Names)
            {
                // El perfil nombra las L-Vars con el prefijo "L:" (ej.
                // "L:VC_APU_SW_VAL"); el WAPI las lista sin él.
                if (!_tracked.TryGetValue($"L:{name}", out var tracked)
                    && !_tracked.TryGetValue(name, out tracked))
                {
                    continue; // L-Var del avión que este perfil no declara
                }

                var value = MSFSVariableServices.LVarsChanged[name].Value;
                if (value == tracked.LastValue)
                {
                    continue;
                }

                _tracked[tracked.LVarName] = tracked with { LastValue = value };
                FieldValueReceived?.Invoke(tracked.ControlId, value);
            }
        }
        catch (Exception ex)
        {
            // Este handler lo invoca FSUIPC desde su propio hilo: una excepción que
            // se escape puede tumbar el proceso entero. Igual que PumpSafely en
            // BridgeService, se aísla y se reporta.
            Warning?.Invoke($"Error procesando cambios de L-Vars empujados por FSUIPC: {ex.Message}");
        }
    }

    public void Pump()
    {
        // Con el empuje activo no hay nada que sondear: los cambios llegan por
        // OnWapiValuesChanged. Sondear ADEMÁS sería pagar los 624 ms del recorrido
        // completo para no enterarse de nada nuevo.
        if (_wapiPushActive)
        {
            return;
        }

        if (!IsConnected || _tracked.Count == 0)
        {
            return;
        }

        foreach (var (lvarName, tracked) in _tracked.ToArray())
        {
            double value;
            try
            {
                value = FSUIPCConnection.ReadLVar(lvarName);
            }
            catch (FSUIPCException ex)
            {
                // FSUIPCException = problema de la CONEXIÓN, no de esta L-Var en
                // particular: no tiene sentido seguir leyendo las demás.
                Warning?.Invoke($"control '{tracked.ControlId}': ReadLVar('{lvarName}') falló ({ex.Message}). ¿Se cerró FSUIPC7?");
                IsConnected = false;
                Disconnected?.Invoke();
                return;
            }
            catch (Exception ex)
            {
                // Cualquier otra excepción es problema de ESTA L-Var, típicamente
                // que no existe en el avión cargado (un perfil generado desde el
                // modelo puede nombrar variables que el addon registra tarde o
                // directamente nunca). Antes esto se escapaba hasta el loop
                // principal y mataba el bridge entero -- con 982 L-Vars leídas 30
                // veces por segundo, una sola mala bastaba.
                //
                // Se descarta esa L-Var del seguimiento (si no, el warning se
                // repetiría 30 veces por segundo) y se sigue con las demás: el
                // resto del perfil funciona igual.
                _tracked.Remove(lvarName);
                Warning?.Invoke(
                    $"control '{tracked.ControlId}': ReadLVar('{lvarName}') falló ({ex.GetType().Name}: {ex.Message}). " +
                    "Se deja de leer ESE control (probablemente la L-Var no existe en esta aeronave); " +
                    "el resto del perfil sigue funcionando.");
                continue;
            }

            if (value != tracked.LastValue)
            {
                _tracked[lvarName] = tracked with { LastValue = value };
                FieldValueReceived?.Invoke(tracked.ControlId, value);
            }
        }
    }

    public bool SubscribeField(string controlId, string areaName, string field, int? arrayIndex, ClientDataNativeType nativeType)
    {
        if (!IsConnected)
        {
            Warning?.Invoke($"control '{controlId}': SubscribeField ignorado, la conexión a FSUIPC7 no está abierta.");
            return false;
        }

        if (!string.Equals(areaName, AreaName, StringComparison.Ordinal))
        {
            Warning?.Invoke($"control '{controlId}': areaName '{areaName}' no soportado por FsuipcLVarClient (solo '{AreaName}').");
            return false;
        }

        if (string.IsNullOrEmpty(field))
        {
            Warning?.Invoke($"control '{controlId}': 'field' vacío -- se esperaba el nombre real de la L-Var (ej. \"L:switch_117_73X\").");
            return false;
        }

        _tracked[field] = new TrackedField(controlId, field, double.NaN);
        return true;
    }

    public bool WriteControlEvent(string areaName, string eventIdOrName, string? parameter)
    {
        // Solo lectura por ahora -- la escritura de los switches del 737 sigue
        // yendo por el camino ya confirmado en vivo esta noche (ROTOR_BRAKE vía
        // write.type: nativeEventValue, ver BridgeService.WriteNativeEventValueControl).
        // FSUIPCConnection.SendControlToFS(PMDG_737_NGX_Control, ...) existe y
        // tiene ~1049 Event IDs con nombre real -- candidato real para migrar la
        // escritura más adelante, pero no se tocó hoy para no arriesgar lo que
        // ya está probado funcionando.
        Warning?.Invoke($"FsuipcLVarClient: WriteControlEvent no soportado todavía (área '{areaName}').");
        return false;
    }

    /// <summary>
    /// Ejecuta un RPN de calculator code a través del módulo WASM/WAPI de
    /// FSUIPC7 (MSFSVariableServices.ExecuteCalculatorCode). Confirmado EN VIVO
    /// (ver ICalculatorCodeClient) contra MSFS 2024 + PMDG 737-900 real: el
    /// mecanismo funciona invocado desde este proceso EXTERNO, sin necesitar la
    /// opción "Enable calculator code execution..." de MSFS ni un módulo WASM
    /// propio del proyecto. Nunca lanza -- cualquier fallo se reporta por
    /// Warning y devuelve false, igual que el resto de los métodos de escritura
    /// del bridge.
    /// </summary>
    public bool ExecuteCalculatorCode(string code)
    {
        if (!IsConnected)
        {
            Warning?.Invoke($"ExecuteCalculatorCode('{code}') ignorado: la conexión a FSUIPC7 no está abierta.");
            return false;
        }

        if (!MSFSVariableServices.IsRunning)
        {
            Warning?.Invoke(
                $"ExecuteCalculatorCode('{code}') ignorado: el módulo WASM/WAPI de FSUIPC7 todavía no está listo " +
                "(MSFSVariableServices.IsRunning=false). Verifique que FSUIPC_WAPID.dll esté junto al ejecutable " +
                "del bridge y que el módulo WASM WAPI se haya cargado dentro del sim (puede tardar unos segundos " +
                "tras iniciar MSFS/el bridge).");
            return false;
        }

        try
        {
            MSFSVariableServices.ExecuteCalculatorCode(code);
            return true;
        }
        catch (Exception ex)
        {
            Warning?.Invoke($"ExecuteCalculatorCode('{code}') falló: {ex.Message}");
            return false;
        }
    }

    public void Dispose()
    {
        Disconnect();
    }
}
