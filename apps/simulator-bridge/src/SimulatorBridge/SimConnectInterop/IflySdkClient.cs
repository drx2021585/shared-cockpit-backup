using System.Runtime.InteropServices;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Profiles;
using SharedCockpit.Bridge.Protocol;

namespace SharedCockpit.Bridge.SimConnectInterop;

/// <summary>
/// Cliente mínimo del SDK oficial de iFly 737 MAX para el canal de comandos.
/// El SDK no usa SimConnect Client Data Area para escribir: envía un
/// WM_COPYDATA a la ventana "iFly Plugin" / "iFly Plugin - MSFS2024", con un
/// payload { Command, Value1, Value2, Value3 } y los IDs simbólicos definidos
/// en key_command.h.
///
/// La lectura principal del perfil iFly sigue por FSUIPC/L-Vars
/// ("SharedCockpitBridge_LVars"), que hoy cubre TODO el perfil existente. Este
/// cliente se enfoca en la parte donde el SDK oficial sí aporta una mejora
/// inmediata y verificable: escritura determinística vía comandos nativos del
/// addon, sin depender de triggers L:VAR ni de la polaridad del RPN.
/// </summary>
public sealed class IflySdkClient : IPmdgClientDataClient
{
    public const string ControlAreaName = "iFly737MAX_SDK_Control";
    public const string DataAreaName = "iFly737MAX_SDK_Data";

    private const string MessageName = "iFly737MAX_MSG_GAU";
    private readonly string _baseDirectory;
    private readonly Dictionary<string, int> _commandIds = new(StringComparer.Ordinal);
    private bool _commandsLoaded;
    private IntPtr _pluginWindow;
    private uint _registeredMessage;

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    private struct Ifly737MaxMessage
    {
        public int Command;
        public double Value1;
        public double Value2;
        public double Value3;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CopyDataStruct
    {
        public nuint DwData;
        public int CbData;
        public IntPtr LpData;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterWindowMessage(string lpString);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, ref CopyDataStruct lParam);

    public IflySdkClient(string baseDirectory)
    {
        _baseDirectory = baseDirectory;
    }

    public bool IsConnected { get; private set; }

    public event Action? Connected;
    public event Action? Disconnected;
    public event Action<string>? Warning;
    public event Action<string, double>? FieldValueReceived;
    public event Action<string, string>? StringFieldValueReceived;
    public event Action<ScreenSnapshotMessage>? ScreenSnapshotReceived;

    public bool TryConnect(string appName)
    {
        if (TryResolvePluginWindow(out var window))
        {
            _pluginWindow = window;
            _registeredMessage = RegisterWindowMessage(MessageName);
            if (_registeredMessage == 0)
            {
                Warning?.Invoke("No se pudo registrar el mensaje iFly737MAX_MSG_GAU.");
                return false;
            }

            if (!EnsureCommandsLoaded())
            {
                return false;
            }

            if (!IsConnected)
            {
                IsConnected = true;
                Connected?.Invoke();
            }

            return true;
        }

        if (IsConnected)
        {
            IsConnected = false;
            _pluginWindow = IntPtr.Zero;
            Disconnected?.Invoke();
        }

        Warning?.Invoke("No se encontró la ventana del plugin de iFly (\"iFly Plugin\" / \"iFly Plugin - MSFS2024\").");
        return false;
    }

    public void Disconnect()
    {
        if (!IsConnected)
        {
            return;
        }

        IsConnected = false;
        _pluginWindow = IntPtr.Zero;
        Disconnected?.Invoke();
    }

    public void Pump()
    {
        if (!IsConnected)
        {
            return;
        }

        if (!TryResolvePluginWindow(out var window))
        {
            Disconnect();
            return;
        }

        _pluginWindow = window;
    }

    public void ResetSubscriptions()
    {
    }

    public bool SubscribeField(string controlId, string areaName, string field, int? arrayIndex, ClientDataNativeType nativeType)
    {
        Warning?.Invoke($"IflySdkClient: SubscribeField no soportado todavía para área '{areaName}'. La lectura iFly sigue por FSUIPC/L-Vars.");
        return false;
    }

    public bool SubscribeScreen(ScreenDefinition screen)
    {
        Warning?.Invoke($"IflySdkClient: SubscribeScreen no soportado todavía para área '{screen.AreaName}'.");
        return false;
    }

    public bool WriteControlEvent(string areaName, string eventIdOrName, string? parameter)
    {
        if (!string.Equals(areaName, ControlAreaName, StringComparison.Ordinal))
        {
            Warning?.Invoke($"IflySdkClient: área '{areaName}' no soportada (solo '{ControlAreaName}').");
            return false;
        }

        if (!IsConnected && !TryConnect("SharedCockpit.Bridge"))
        {
            return false;
        }

        if (!TryResolveCommandId(eventIdOrName, out var commandId))
        {
            Warning?.Invoke($"IflySdkClient: comando iFly desconocido '{eventIdOrName}'.");
            return false;
        }

        if (!TryParseValues(parameter, out var value1, out var value2, out var value3))
        {
            Warning?.Invoke($"IflySdkClient: parámetro inválido '{parameter}' para comando '{eventIdOrName}'. Use formato 'v1|v2|v3'.");
            return false;
        }

        var payload = new Ifly737MaxMessage
        {
            Command = commandId,
            Value1 = value1,
            Value2 = value2,
            Value3 = value3,
        };

        var payloadSize = Marshal.SizeOf<Ifly737MaxMessage>();
        var payloadPtr = Marshal.AllocHGlobal(payloadSize);
        try
        {
            Marshal.StructureToPtr(payload, payloadPtr, fDeleteOld: false);
            var copyData = new CopyDataStruct
            {
                DwData = _registeredMessage,
                // El SDK de ejemplo suma 2 bytes al tamaño del struct; se replica
                // ese contrato literal para no cambiar el payload observado por el plugin.
                CbData = payloadSize + 2,
                LpData = payloadPtr,
            };

            SendMessage(_pluginWindow, 0x004A, IntPtr.Zero, ref copyData);
            return true;
        }
        finally
        {
            Marshal.FreeHGlobal(payloadPtr);
        }
    }

    public void Dispose() => Disconnect();

    private bool TryResolvePluginWindow(out IntPtr window)
    {
        window = FindWindow(null, "iFly Plugin - MSFS2024");
        if (window != IntPtr.Zero)
        {
            return true;
        }

        window = FindWindow(null, "iFly Plugin");
        return window != IntPtr.Zero;
    }

    private bool EnsureCommandsLoaded()
    {
        if (_commandsLoaded)
        {
            return true;
        }

        var commandHeader = DiscoverKeyCommandHeader();
        if (commandHeader is null)
        {
            Warning?.Invoke("No se encontró key_command.h del SDK de iFly en el output del bridge (esperado en ifly-sdk\\key_command.h).");
            return false;
        }

        var nextId = 0;
        foreach (var rawLine in File.ReadLines(commandHeader))
        {
            var line = rawLine.Trim();
            if (!line.StartsWith("KEY_COMMAND_", StringComparison.Ordinal))
            {
                continue;
            }

            var comma = line.IndexOf(',');
            var commandName = comma >= 0 ? line[..comma].Trim() : line;
            if (_commandIds.ContainsKey(commandName))
            {
                continue;
            }

            _commandIds[commandName] = nextId++;
        }

        _commandsLoaded = _commandIds.Count > 0;
        if (!_commandsLoaded)
        {
            Warning?.Invoke($"No se pudo cargar ningún KEY_COMMAND_* desde '{commandHeader}'.");
        }

        return _commandsLoaded;
    }

    private string? DiscoverKeyCommandHeader()
    {
        var direct = Path.Combine(_baseDirectory, "ifly-sdk", "key_command.h");
        if (File.Exists(direct))
        {
            return direct;
        }

        var nested = Path.Combine(_baseDirectory, "ifly-sdk", "sdk", "key_command.h");
        if (File.Exists(nested))
        {
            return nested;
        }

        return null;
    }

    private bool TryResolveCommandId(string eventIdOrName, out int commandId)
    {
        if (int.TryParse(eventIdOrName, out commandId))
        {
            return true;
        }

        return _commandIds.TryGetValue(eventIdOrName, out commandId);
    }

    private static bool TryParseValues(string? parameter, out double value1, out double value2, out double value3)
    {
        value1 = 0;
        value2 = 0;
        value3 = 0;

        if (string.IsNullOrWhiteSpace(parameter))
        {
            return true;
        }

        var parts = parameter.Split('|');
        if (parts.Length > 3)
        {
            return false;
        }

        var values = new[] { 0d, 0d, 0d };
        for (var i = 0; i < parts.Length; i++)
        {
            if (!double.TryParse(parts[i], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out values[i]))
            {
                return false;
            }
        }

        value1 = values[0];
        value2 = values[1];
        value3 = values[2];
        return true;
    }
}
