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
public sealed class FsuipcLVarClient : IPmdgClientDataClient
{
    private const string AreaName = "SharedCockpitBridge_LVars";

    private sealed record TrackedField(string ControlId, string LVarName, double LastValue);

    private readonly Dictionary<string, TrackedField> _tracked = new(StringComparer.Ordinal);

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

    public void Pump()
    {
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
                Warning?.Invoke($"control '{tracked.ControlId}': ReadLVar('{lvarName}') falló ({ex.Message}). ¿Se cerró FSUIPC7?");
                IsConnected = false;
                Disconnected?.Invoke();
                return;
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

    public void Dispose()
    {
        Disconnect();
    }
}
