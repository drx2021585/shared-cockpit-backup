using System.Runtime.InteropServices;
using System.Text;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Profiles;

namespace SharedCockpit.Bridge.SimConnectInterop;

/// <summary>
/// ====================================================================================
/// ESTADO DE VERIFICACIÓN — LÉASE ANTES DE CONFIAR EN ESTE ARCHIVO
/// ====================================================================================
/// Este cliente implementa el flujo de "Client Data Area" del SDK de terceros de
/// PMDG 737 NG3 (apps/desktop-ui/Documentation/SDK/PMDG_NG3_SDK.h,
/// PMDG_NG3_ConnectionTest.cpp) traducido a P/Invoke en C#, siguiendo el mismo
/// patrón que SimConnectNativeClient.cs usa para SimConnect estándar.
///
/// NO se pudo compilar ni ejecutar en este entorno (no hay `dotnet` CLI
/// disponible, no hay MSFS instalado, no hay PMDG 737 instalado, no hay
/// SimConnect.dll accesible). Fue escrito y revisado a mano contra:
///   - El código C++ de referencia de PMDG (PMDG_NG3_ConnectionTest.cpp).
///   - El header PMDG_NG3_SDK.h (constantes de área/definición y structs).
///   - El patrón P/Invoke ya usado y presumiblemente probado en SimConnectNativeClient.cs.
///
/// Antes de confiar en este código hace falta, en la máquina de Darwin, con MSFS
/// y el PMDG 737 abiertos y `EnableDataBroadcast=1` en 737_Options.ini:
///   1. Confirmar que SimConnect_MapClientDataNameToID + AddToClientDataDefinition +
///      RequestClientData efectivamente entregan SIMCONNECT_RECV_ID_CLIENT_DATA
///      (dwID=10, ver SimConnectRecvId.ClientData) con el layout esperado.
///   2. Confirmar los offsets de PmdgNg3DataLayout contra los valores reales leídos
///      en cabina (ej. alternar el interruptor de taxi light en el simulador y
///      verificar que el bit leído en LTS_TaxiSw cambia).
///   3. Obtener de PMDG (o de ingeniería inversa autorizada) la tabla completa de
///      Event IDs válidos para PMDG_NG3_Control.Event — este archivo SOLO conoce
///      el único ejemplo publicado en el SDK (EVT_OH_LIGHTS_TAXI = 69749, ver
///      ResolveEventId). Cualquier otro nombre simbólico debe rechazarse
///      explícitamente hasta confirmarse, en vez de adivinar un ID.
///
/// LO QUE NO ESTÁ IMPLEMENTADO (fuera de alcance de esta tarea, ver instrucciones):
///   - PMDG_NG3_CDU_0 / PMDG_NG3_CDU_1 (pantallas de CDU): la Parte B del encargo
///     pidió priorizar PMDG_NG3_Data/Control. Streaming del CDU (24x14 celdas,
///     PMDG_NG3_CDU_Screen) es una decisión de arquitectura aparte (¿se expone
///     como bitmap? ¿como texto?) que no se tomó aquí.
///   - Reconexión automática de esta conexión SimConnect secundaria si se cae
///     (BridgeService reintenta la conexión principal, pero este cliente no
///     reintenta MapClientDataNameToID/AddToClientDataDefinition
///     automáticamente tras un Disconnect — queda para BridgeService decidir
///     cuándo reintentar TryConnect()).
///   - Todo el struct PMDG_NG3_Data más allá de "LTS_WheelWellSw" (ver
///     PmdgNg3DataLayout, comentario de clase) — SubscribeField devuelve false
///     con un Warning para cualquier campo no transcrito.
/// ====================================================================================
///
/// DECISIÓN DE ARQUITECTURA: esta clase abre su PROPIA conexión SimConnect
/// (handle independiente del de SimConnectNativeClient) en vez de compartir el
/// handle del cliente estándar. Es más simple de implementar y aislar (un fallo
/// en el SDK de PMDG no puede corromper el estado del cliente estándar), a
/// costa de una segunda conexión SimConnect abierta simultáneamente. MSFS
/// soporta múltiples conexiones SimConnect por proceso sin problema. Si en el
/// futuro se decide compartir una sola conexión, este cliente tendría que dejar
/// de manejar su propio SimConnect_Open/Close y recibir el handle inyectado.
/// </summary>
public sealed class PmdgClientDataClient : IPmdgClientDataClient
{
    private const string DataAreaName = "PMDG_NG3_Data";
    private const string ControlAreaName = "PMDG_NG3_Control";

    // Constantes de PMDG_NG3_SDK.h (Copyright PMDG) — IDs arbitrarios pero
    // fijos elegidos por PMDG para su Client Data Area / Definition.
    private const uint DataClientDataId = 0x4E473331;
    private const uint DataDefinitionId = 0x4E473332;
    private const uint ControlClientDataId = 0x4E473333;
    private const uint ControlDefinitionId = 0x4E473334;

    private const uint DataRequestId = 1;
    private const uint ControlRequestId = 2;

    /// <summary>
    /// Únicos Event IDs de PMDG_NG3_Control.Event confirmados por el SDK/ejemplos
    /// públicos de PMDG. NO es una lista completa — PMDG no publica una tabla
    /// exhaustiva de estos IDs. Cualquier control que necesite un Event distinto
    /// debe declarar el valor numérico directo en el YAML (event: 12345) hasta
    /// que se confirme y documente su nombre simbólico aquí.
    /// </summary>
    private static readonly Dictionary<string, uint> KnownControlEventIds = new(StringComparer.OrdinalIgnoreCase)
    {
        // Ver PMDG_NG3_ConnectionTest.cpp: toggleTaxiLightSwitch() usa
        // Control.Event = EVT_OH_LIGHTS_TAXI (comentado como = 69749) junto con
        // Control.Parameter = 0/1 para fijar explícitamente el estado del taxi
        // light (NO es un toggle: el valor de Parameter determina el estado final).
        ["EVT_OH_LIGHTS_TAXI"] = 69749,
    };

    /// <summary>Campo suscrito: dónde cae dentro del payload que arma SimConnect al concatenar
    /// los AddToClientDataDefinition en el orden en que fueron agregados (NO es el offset
    /// dentro del struct C original -- ver PmdgNg3DataLayout para ese offset).</summary>
    private sealed record SubscribedField(string ControlId, int PayloadOffset, PmdgNg3DataLayout.FieldDescriptor Descriptor, int? ArrayIndex, ClientDataNativeType NativeType);

    private IntPtr _handle = IntPtr.Zero;
    private bool _dataDefinitionRequested;
    private bool _controlDefinitionRegistered;
    private int _nextPayloadOffset;

    private readonly List<SubscribedField> _subscribedFields = new();
    // Clave = (field, arrayIndex): dos controles pueden compartir el mismo campo array
    // (ej. IRS_ModeSelector[0] e IRS_ModeSelector[1]) siempre que apunten a índices
    // distintos -- solo es un choque real si (field, arrayIndex) coincide exactamente.
    private readonly HashSet<(string Field, int? ArrayIndex)> _subscribedFieldNames = new();

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

        int hr;
        IntPtr handle;
        try
        {
            hr = NativeMethods.SimConnect_Open(out handle, $"{appName}.Pmdg", IntPtr.Zero, 0, IntPtr.Zero, 0);
        }
        catch (DllNotFoundException)
        {
            Warning?.Invoke("SimConnect.dll no encontrada — no se puede abrir la conexión dedicada al SDK de PMDG.");
            return false;
        }
        catch (BadImageFormatException)
        {
            Warning?.Invoke("SimConnect.dll tiene una arquitectura incompatible con este proceso (SDK de PMDG).");
            return false;
        }

        if (hr != 0 || handle == IntPtr.Zero)
        {
            return false;
        }

        _handle = handle;
        IsConnected = true;

        // Asociar los nombres de área conocidos del SDK de PMDG a sus IDs. Esto NO
        // falla de forma síncrona si PMDG todavía no creó el área (ej. la
        // aeronave no es un PMDG 737, o EnableDataBroadcast=0): SimConnect solo
        // reporta el error como una excepción asíncrona más adelante (ver
        // HandleMessage / SimConnectRecvId.Exception), que se traduce en un
        // Warning en vez de crashear.
        var hrData = NativeMethods.SimConnect_MapClientDataNameToID(_handle, DataAreaName, DataClientDataId);
        var hrControl = NativeMethods.SimConnect_MapClientDataNameToID(_handle, ControlAreaName, ControlClientDataId);
        if (hrData != 0 || hrControl != 0)
        {
            Warning?.Invoke($"MapClientDataNameToID falló para el SDK de PMDG (hrData=0x{hrData:X8}, hrControl=0x{hrControl:X8}). " +
                "¿MSFS/PMDG 737 NG3 no está cargado todavía?");
        }

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
        _dataDefinitionRequested = false;
        _controlDefinitionRegistered = false;
        Disconnected?.Invoke();
    }

    public void Pump()
    {
        if (!IsConnected)
        {
            return;
        }

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

    // SIMCONNECT_RECV_CLIENT_DATA reusa exactamente el layout de
    // SIMCONNECT_RECV_SIMOBJECT_DATA en el SDK oficial (mismos campos:
    // dwRequestID/dwObjectID/dwDefineID/dwFlags/dwentrynumber/dwoutof/
    // dwDefineCount, seguido del payload variable) — reutilizamos la misma
    // struct de SimConnectStructs.cs en vez de declarar un duplicado.
    private static readonly int ClientDataFixedSize = Marshal.SizeOf<SimConnectRecvSimObjectDataFixed>();

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
                Warning?.Invoke($"SimConnect exception (SDK PMDG) code={exc.DwException} sendId={exc.DwSendId} index={exc.DwIndex}. " +
                    "Causas típicas: PMDG 737 no cargado, o EnableDataBroadcast=0 en 737_Options.ini.");
                break;
            }

            case SimConnectRecvId.ClientData:
            {
                var fixedPart = Marshal.PtrToStructure<SimConnectRecvSimObjectDataFixed>(pData);
                if (fixedPart.DwRequestId == DataRequestId)
                {
                    HandleDataPayload(IntPtr.Add(pData, ClientDataFixedSize));
                }

                // ControlRequestId (echo del área de control tras un SetClientData externo)
                // no se procesa en Sprint 1: el bridge no necesita leer de vuelta lo que él
                // mismo escribió, y otro cliente externo escribiendo control simultáneamente
                // está fuera de alcance.
                break;
            }

            default:
                break;
        }
    }

    private void HandleDataPayload(IntPtr payloadPtr)
    {
        foreach (var sub in _subscribedFields)
        {
            var fieldPtr = IntPtr.Add(payloadPtr, sub.PayloadOffset);
            switch (sub.NativeType)
            {
                case ClientDataNativeType.Bool:
                {
                    var raw = Marshal.ReadByte(fieldPtr);
                    FieldValueReceived?.Invoke(sub.ControlId, raw != 0 ? 1d : 0d);
                    break;
                }

                case ClientDataNativeType.UChar:
                {
                    // NOTA: NO se vuelve a aplicar aquí el desplazamiento por arrayIndex —
                    // SubscribeField ya pidió únicamente el byte del elemento correcto
                    // (effectiveOffset) al construir la definición, así que fieldPtr ya
                    // apunta exactamente a ese byte dentro del payload concatenado.
                    var raw = Marshal.ReadByte(fieldPtr);
                    FieldValueReceived?.Invoke(sub.ControlId, raw);
                    break;
                }

                case ClientDataNativeType.UInt:
                {
                    var raw = unchecked((uint)Marshal.ReadInt32(fieldPtr));
                    FieldValueReceived?.Invoke(sub.ControlId, raw);
                    break;
                }

                case ClientDataNativeType.CharArray:
                {
                    var text = ReadFixedAnsiString(fieldPtr, sub.Descriptor.ArrayLength);
                    StringFieldValueReceived?.Invoke(sub.ControlId, text);
                    break;
                }
            }
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

    public bool SubscribeField(string controlId, string areaName, string field, int? arrayIndex, ClientDataNativeType nativeType)
    {
        if (!IsConnected)
        {
            Warning?.Invoke($"control '{controlId}': SubscribeField ignorado, la conexión SimConnect dedicada al SDK de PMDG no está abierta.");
            return false;
        }

        if (!string.Equals(areaName, DataAreaName, StringComparison.Ordinal))
        {
            // Sprint actual solo implementa PMDG_NG3_Data (ver comentario de archivo:
            // CDU_0/CDU_1 quedan fuera de alcance).
            Warning?.Invoke($"control '{controlId}': areaName '{areaName}' no soportado todavía por PmdgClientDataClient (solo '{DataAreaName}').");
            return false;
        }

        if (!PmdgNg3DataLayout.TryGetField(field, out var offset, out var descriptor))
        {
            Warning?.Invoke($"control '{controlId}': campo '{field}' de {DataAreaName} no está transcrito todavía en PmdgNg3DataLayout (ver comentario de esa clase para el alcance).");
            return false;
        }

        if (descriptor.Kind == PmdgNg3DataLayout.LayoutFieldKind.Float || descriptor.Kind == PmdgNg3DataLayout.LayoutFieldKind.Int)
        {
            Warning?.Invoke($"control '{controlId}': campo '{field}' es de tipo interno {descriptor.Kind} (float/int), no soportado todavía como nativeType de perfil (solo bool|uchar|uint|char_array).");
            return false;
        }

        if (!NativeTypeMatchesLayoutKind(nativeType, descriptor.Kind))
        {
            Warning?.Invoke($"control '{controlId}': nativeType declarado ({nativeType}) no coincide con el tipo real de '{field}' en PmdgNg3DataLayout ({descriptor.Kind}). Revisar el perfil o PMDG_NG3_SDK.h.");
            return false;
        }

        if (_subscribedFieldNames.Contains((field, arrayIndex)))
        {
            // Choque real: dos controles apuntan exactamente al mismo (campo, índice) --
            // p.ej. un error de transcripción en el perfil, no el caso legítimo de
            // IRS_ModeSelector[0] vs IRS_ModeSelector[1] (arrayIndex distinto, no choca).
            Warning?.Invoke($"control '{controlId}': el campo '{field}'{(arrayIndex is int i ? $"[{i}]" : string.Empty)} ya fue suscrito por otro control; dos controles no pueden apuntar exactamente al mismo (campo, índice).");
            return false;
        }

        var sizeToRequest = descriptor.ElementSize; // Para arrays, se pide un único elemento (arrayIndex) o el array completo si es char_array.
        var effectiveOffset = offset;
        if (nativeType == ClientDataNativeType.CharArray)
        {
            sizeToRequest = descriptor.TotalSize;
        }
        else if (arrayIndex is int idx)
        {
            if (idx < 0 || idx >= descriptor.ArrayLength)
            {
                Warning?.Invoke($"control '{controlId}': arrayIndex {idx} fuera de rango para '{field}' (longitud {descriptor.ArrayLength}).");
                return false;
            }

            effectiveOffset += idx * descriptor.ElementSize;
        }

        var hrAdd = NativeMethods.SimConnect_AddToClientDataDefinition(
            _handle,
            DataDefinitionId,
            (uint)effectiveOffset,
            (uint)sizeToRequest,
            0f,
            SimConnectConst.Unused);

        if (hrAdd != 0)
        {
            Warning?.Invoke($"control '{controlId}': AddToClientDataDefinition falló para '{field}' (offset={effectiveOffset}), hr=0x{hrAdd:X8}");
            return false;
        }

        _subscribedFields.Add(new SubscribedField(controlId, _nextPayloadOffset, descriptor, arrayIndex, nativeType));
        _subscribedFieldNames.Add((field, arrayIndex));
        _nextPayloadOffset += sizeToRequest;

        if (!_dataDefinitionRequested)
        {
            // Primera suscripción: registra la request de datos completa. Suscripciones
            // posteriores solo agregan más entradas a la MISMA definición (DataDefinitionId);
            // SimConnect no requiere volver a llamar RequestClientData por cada campo nuevo
            // si se re-emite después de agregar todos los campos conocidos al inicio del
            // matching de perfil (ver BridgeService.SubscribeControls: agrega todos los
            // controles del perfil antes de dejar correr el loop principal).
            var hrRequest = NativeMethods.SimConnect_RequestClientData(
                _handle,
                DataClientDataId,
                DataRequestId,
                DataDefinitionId,
                (uint)SimConnectClientDataPeriod.OnSet,
                (uint)SimConnectDataRequestFlag.Changed,
                0,
                0,
                0);

            if (hrRequest != 0)
            {
                Warning?.Invoke($"RequestClientData falló para {DataAreaName}, hr=0x{hrRequest:X8}");
                return false;
            }

            _dataDefinitionRequested = true;
        }

        return true;
    }

    public bool WriteControlEvent(string areaName, string eventIdOrName, string? parameter)
    {
        if (!IsConnected)
        {
            Warning?.Invoke($"WriteControlEvent('{eventIdOrName}') ignorado: la conexión SimConnect dedicada al SDK de PMDG no está abierta.");
            return false;
        }

        if (!string.Equals(areaName, ControlAreaName, StringComparison.Ordinal))
        {
            Warning?.Invoke($"areaName '{areaName}' no soportado todavía por PmdgClientDataClient (solo '{ControlAreaName}').");
            return false;
        }

        if (!TryResolveEventId(eventIdOrName, out var eventId))
        {
            Warning?.Invoke($"Event ID desconocido: '{eventIdOrName}'. PMDG no publica una tabla completa de Event IDs de {ControlAreaName} — " +
                "usar el valor numérico confirmado directamente en el perfil (write.event: <entero>) o agregarlo a PmdgClientDataClient.KnownControlEventIds " +
                "una vez confirmado contra el SDK real.");
            return false;
        }

        var parameterValue = ParseParameter(parameter);

        if (!_controlDefinitionRegistered)
        {
            // struct PMDG_NG3_Control { unsigned int Event; unsigned int Parameter; } -- 8 bytes, sin padding.
            var hrDef = NativeMethods.SimConnect_AddToClientDataDefinition(
                _handle,
                ControlDefinitionId,
                0,
                8,
                0f,
                SimConnectConst.Unused);

            if (hrDef != 0)
            {
                Warning?.Invoke($"AddToClientDataDefinition falló para {ControlAreaName}, hr=0x{hrDef:X8}");
                return false;
            }

            _controlDefinitionRegistered = true;
        }

        var buffer = Marshal.AllocHGlobal(8);
        try
        {
            Marshal.WriteInt32(buffer, 0, unchecked((int)eventId));
            Marshal.WriteInt32(buffer, 4, unchecked((int)parameterValue));

            var hrSet = NativeMethods.SimConnect_SetClientData(
                _handle,
                ControlClientDataId,
                ControlDefinitionId,
                0,
                0,
                8,
                buffer);

            if (hrSet != 0)
            {
                Warning?.Invoke($"SetClientData('{eventIdOrName}') falló, hr=0x{hrSet:X8}");
                return false;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        return true;
    }

    private static bool NativeTypeMatchesLayoutKind(ClientDataNativeType nativeType, PmdgNg3DataLayout.LayoutFieldKind kind) => nativeType switch
    {
        ClientDataNativeType.Bool => kind == PmdgNg3DataLayout.LayoutFieldKind.Bool,
        ClientDataNativeType.UChar => kind == PmdgNg3DataLayout.LayoutFieldKind.UChar,
        ClientDataNativeType.UInt => kind == PmdgNg3DataLayout.LayoutFieldKind.UInt,
        ClientDataNativeType.CharArray => kind == PmdgNg3DataLayout.LayoutFieldKind.Char,
        _ => false,
    };

    private static bool TryResolveEventId(string eventIdOrName, out uint eventId)
    {
        if (uint.TryParse(eventIdOrName, out eventId))
        {
            return true;
        }

        return KnownControlEventIds.TryGetValue(eventIdOrName, out eventId);
    }

    private static uint ParseParameter(string? parameter)
    {
        if (parameter is null)
        {
            return 0;
        }

        return uint.TryParse(parameter, out var value) ? value : 0;
    }

    public void Dispose()
    {
        Disconnect();
    }
}
