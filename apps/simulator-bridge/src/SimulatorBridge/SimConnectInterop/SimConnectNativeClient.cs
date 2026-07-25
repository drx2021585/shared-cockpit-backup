using System.Runtime.InteropServices;
using System.Text;
using SharedCockpit.Bridge.Bridge;

namespace SharedCockpit.Bridge.SimConnectInterop;

/// <summary>
/// Implementación real de ISimConnectClient usando P/Invoke directo contra
/// SimConnect.dll nativa (ver NativeMethods.cs para la justificación de por
/// qué no se usa el ensamblado administrado oficial). Traduce entre el
/// vocabulario de alto nivel del bridge (key string -> simvar) y las
/// estructuras/IDs numéricos crudos del API C de SimConnect.
///
/// LIMITACIÓN CONOCIDA: packages/profile-schema/control.schema.json no declara
/// un campo "units" por control. SimConnect requiere una cadena de unidad al
/// registrar cada simvar (ej. "Bool", "Number", "Percent", "Position",
/// "Frequency BCD16"). Este cliente usa un default razonable según el
/// dataType del control ("Bool" / "Number") que funciona para la mayoría de
/// las variables booleanas y numéricas simples usadas en Sprint 1
/// (beacon, parking brake), pero NO está garantizado para simvars que
/// requieren una unidad específica distinta (ej. frecuencias de radio). Ver
/// README.md de este proyecto — se recomienda pedir a aircraft-profiles-agent
/// / al orquestador que evalúen agregar "units" al esquema de control.
/// </summary>
public sealed class SimConnectNativeClient : ISimConnectClient
{
    private enum ValueKind
    {
        Double,
        String256,
    }

    private const uint NotificationGroupId = 1;
    private static readonly int SimObjectDataFixedSize = Marshal.SizeOf<SimConnectRecvSimObjectDataFixed>();

    private IntPtr _handle = IntPtr.Zero;
    private uint _nextDefineId = 1;
    private uint _nextEventId = 1;
    private bool _groupPrioritySet;

    private readonly Dictionary<string, uint> _keyToDefineId = new();
    private readonly Dictionary<uint, string> _defineIdToKey = new();
    private readonly Dictionary<uint, ValueKind> _defineIdToKind = new();
    private readonly Dictionary<string, uint> _eventNameToId = new();
    private readonly HashSet<uint> _eventsRegisteredInGroup = new();

    public bool IsConnected { get; private set; }

    public event Action? Connected;
    public event Action? Disconnected;
    public event Action<string>? SimConnectException;
    public event Action<string, double>? NumericValueReceived;
    public event Action<string, string>? StringValueReceived;

    public bool TryConnect(string appName)
    {
        if (IsConnected)
        {
            return true;
        }

        int hr;
        IntPtr handle;
        try
        {
            hr = NativeMethods.SimConnect_Open(
                out handle,
                appName,
                IntPtr.Zero,
                0,
                IntPtr.Zero,
                0);
        }
        catch (DllNotFoundException)
        {
            // SimConnect.dll no está presente en esta máquina (no hay MSFS
            // instalado, o no está en el PATH que MSFS registra). Mismo
            // tratamiento que "no se pudo conectar": se reintenta más tarde
            // en vez de crashear el proceso entero.
            SimConnectException?.Invoke("SimConnect.dll no encontrada — ¿MSFS está instalado en esta máquina?");
            return false;
        }
        catch (BadImageFormatException)
        {
            // Arquitectura de la DLL no coincide con el proceso (x86 vs x64).
            SimConnectException?.Invoke("SimConnect.dll tiene una arquitectura incompatible con este proceso.");
            return false;
        }

        if (hr != 0 || handle == IntPtr.Zero)
        {
            return false;
        }

        _handle = handle;
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

        if (_handle != IntPtr.Zero)
        {
            NativeMethods.SimConnect_Close(_handle);
        }

        _handle = IntPtr.Zero;
        IsConnected = false;
        Disconnected?.Invoke();
    }

    public void Pump()
    {
        if (!IsConnected)
        {
            return;
        }

        // SimConnect_Open se llamó sin hWnd ni event handle (modo "polling
        // manual", el más simple para un proceso de consola sin bucle de
        // mensajes Win32). En ese modo el consumidor DEBE llamar
        // GetNextDispatch repetidamente para vaciar la cola; se recomienda
        // invocar Pump() cada 20-50ms desde BridgeService.
        while (IsConnected)
        {
            var hr = NativeMethods.SimConnect_GetNextDispatch(_handle, out var pData, out _);
            if (hr != 0 || pData == IntPtr.Zero)
            {
                break;
            }

            HandleMessage(pData);
        }
    }

    private void HandleMessage(IntPtr pData)
    {
        var header = Marshal.PtrToStructure<SimConnectRecvHeader>(pData);
        switch ((SimConnectRecvId)header.DwId)
        {
            case SimConnectRecvId.Quit:
                Disconnect();
                break;

            case SimConnectRecvId.Exception:
            {
                var exc = Marshal.PtrToStructure<SimConnectRecvException>(pData);
                SimConnectException?.Invoke(
                    $"SimConnect exception code={exc.DwException} sendId={exc.DwSendId} index={exc.DwIndex}");
                break;
            }

            case SimConnectRecvId.SimObjectData:
            {
                var fixedPart = Marshal.PtrToStructure<SimConnectRecvSimObjectDataFixed>(pData);
                if (!_defineIdToKey.TryGetValue(fixedPart.DwDefineId, out var key))
                {
                    break;
                }

                var dataPtr = IntPtr.Add(pData, SimObjectDataFixedSize);
                var kind = _defineIdToKind.GetValueOrDefault(fixedPart.DwDefineId, ValueKind.Double);
                if (kind == ValueKind.Double)
                {
                    var value = Marshal.PtrToStructure<double>(dataPtr);
                    NumericValueReceived?.Invoke(key, value);
                }
                else
                {
                    var text = ReadFixedAnsiString(dataPtr, 256);
                    StringValueReceived?.Invoke(key, text);
                }

                break;
            }

            // Open, Event y otros IDs no usados en Sprint 1 se ignoran
            // deliberadamente (no afectan el estado que expone el bridge).
            default:
                break;
        }
    }

    private static string ReadFixedAnsiString(IntPtr ptr, int maxLength)
    {
        var buffer = new byte[maxLength];
        Marshal.Copy(ptr, buffer, 0, maxLength);
        var nullIndex = Array.IndexOf<byte>(buffer, 0);
        var length = nullIndex >= 0 ? nullIndex : maxLength;
        return Encoding.ASCII.GetString(buffer, 0, length);
    }

    public void SubscribeNumeric(string key, string simVarName, string units, PollMode mode)
    {
        var defineId = RegisterDefinition(key, ValueKind.Double);
        var hr = NativeMethods.SimConnect_AddToDataDefinition(
            _handle,
            defineId,
            simVarName,
            units,
            (uint)SimConnectDataType.Float64,
            0f,
            SimConnectConst.Unused);

        if (hr != 0)
        {
            SimConnectException?.Invoke($"AddToDataDefinition falló para '{simVarName}' (key={key}), hr=0x{hr:X8}");
            return;
        }

        RequestData(defineId, mode);
    }

    public void SubscribeString(string key, string simVarName, PollMode mode)
    {
        var defineId = RegisterDefinition(key, ValueKind.String256);
        var hr = NativeMethods.SimConnect_AddToDataDefinition(
            _handle,
            defineId,
            simVarName,
            null,
            (uint)SimConnectDataType.String256,
            0f,
            SimConnectConst.Unused);

        if (hr != 0)
        {
            SimConnectException?.Invoke($"AddToDataDefinition falló para '{simVarName}' (key={key}), hr=0x{hr:X8}");
            return;
        }

        RequestData(defineId, mode);
    }

    private uint RegisterDefinition(string key, ValueKind kind)
    {
        if (_keyToDefineId.TryGetValue(key, out var existing))
        {
            return existing;
        }

        var defineId = _nextDefineId++;
        _keyToDefineId[key] = defineId;
        _defineIdToKey[defineId] = key;
        _defineIdToKind[defineId] = kind;
        return defineId;
    }

    private void RequestData(uint defineId, PollMode mode)
    {
        var flags = mode == PollMode.OnChange
            ? (uint)SimConnectDataRequestFlag.Changed
            : (uint)SimConnectDataRequestFlag.Default;

        // requestId == defineId (mapeo 1:1, ver comentario de diseño en ISimConnectClient).
        var hr = NativeMethods.SimConnect_RequestDataOnSimObject(
            _handle,
            defineId,
            defineId,
            SimConnectConst.ObjectIdUser,
            (uint)SimConnectPeriod.SimFrame,
            flags,
            0,
            0,
            0);

        if (hr != 0)
        {
            SimConnectException?.Invoke($"RequestDataOnSimObject falló para defineId={defineId}, hr=0x{hr:X8}");
        }
    }

    public void TransmitSetEvent(string eventName, uint dwData)
    {
        if (!IsConnected)
        {
            SimConnectException?.Invoke($"TransmitSetEvent('{eventName}') ignorado: SimConnect no está conectado");
            return;
        }

        var eventId = GetOrMapEvent(eventName);
        var hr = NativeMethods.SimConnect_TransmitClientEvent(
            _handle,
            SimConnectConst.ObjectIdUser,
            eventId,
            dwData,
            NotificationGroupId,
            (uint)SimConnectEventFlag.GroupIdIsPriority);

        if (hr != 0)
        {
            SimConnectException?.Invoke($"TransmitClientEvent('{eventName}') falló, hr=0x{hr:X8}");
        }
    }

    private uint GetOrMapEvent(string eventName)
    {
        if (_eventNameToId.TryGetValue(eventName, out var existing))
        {
            return existing;
        }

        var eventId = _nextEventId++;
        NativeMethods.SimConnect_MapClientEventToSimEvent(_handle, eventId, eventName);
        NativeMethods.SimConnect_AddClientEventToNotificationGroup(_handle, NotificationGroupId, eventId, 0);

        if (!_groupPrioritySet)
        {
            NativeMethods.SimConnect_SetNotificationGroupPriority(_handle, NotificationGroupId, SimConnectConst.GroupPriorityHighest);
            _groupPrioritySet = true;
        }

        _eventNameToId[eventName] = eventId;
        _eventsRegisteredInGroup.Add(eventId);
        return eventId;
    }

    public void WriteNumeric(string key, double value)
    {
        if (!IsConnected)
        {
            SimConnectException?.Invoke($"WriteNumeric('{key}') ignorado: SimConnect no está conectado");
            return;
        }

        if (!_keyToDefineId.TryGetValue(key, out var defineId))
        {
            SimConnectException?.Invoke($"WriteNumeric('{key}') falló: no hay data definition registrada para esa key (¿faltó SubscribeNumeric?)");
            return;
        }

        var buffer = Marshal.AllocHGlobal(sizeof(double));
        try
        {
            Marshal.StructureToPtr(value, buffer, false);
            var hr = NativeMethods.SimConnect_SetDataOnSimObject(
                _handle,
                defineId,
                SimConnectConst.ObjectIdUser,
                0,
                0,
                sizeof(double),
                buffer);

            if (hr != 0)
            {
                SimConnectException?.Invoke($"SetDataOnSimObject('{key}') falló, hr=0x{hr:X8}");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public void Dispose()
    {
        Disconnect();
    }
}
