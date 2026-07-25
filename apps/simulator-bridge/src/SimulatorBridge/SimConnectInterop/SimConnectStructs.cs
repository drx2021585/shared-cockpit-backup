using System.Runtime.InteropServices;

namespace SharedCockpit.Bridge.SimConnectInterop;

/// <summary>
/// Cabecera común a todas las estructuras SIMCONNECT_RECV_*. El payload
/// variable (ej. el valor de dato de un SIMOBJECT_DATA) empieza inmediatamente
/// después de esta cabecera en el buffer nativo devuelto por
/// SimConnect_GetNextDispatch; se lee manualmente con Marshal en
/// SimConnectClient.cs en vez de declarar structs de layout fijo, porque
/// SIMCONNECT_RECV_SIMOBJECT_DATA termina con un array de tamaño variable
/// (dwData[1] en el header C, un patrón "struct hack").
/// </summary>
[StructLayout(LayoutKind.Sequential)]
internal struct SimConnectRecvHeader
{
    public uint DwSize;
    public uint DwVersion;
    public uint DwId;
}

[StructLayout(LayoutKind.Sequential)]
internal struct SimConnectRecvException
{
    public SimConnectRecvHeader Header;
    public uint DwException;
    public uint DwSendId;
    public uint DwIndex;
}

[StructLayout(LayoutKind.Sequential)]
internal struct SimConnectRecvEvent
{
    public SimConnectRecvHeader Header;
    public uint UGroupId;
    public uint UEventId;
    public uint DwData;
}

/// <summary>Campos fijos de SIMCONNECT_RECV_SIMOBJECT_DATA antes del payload variable.</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct SimConnectRecvSimObjectDataFixed
{
    public SimConnectRecvHeader Header;
    public uint DwRequestId;
    public uint DwObjectId;
    public uint DwDefineId;
    public uint DwFlags;
    public uint DwEntryNumber;
    public uint DwOutOf;
    public uint DwDefineCount;
}
