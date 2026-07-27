using System.Runtime.InteropServices;

namespace SharedCockpit.Bridge.SimConnectInterop;

/// <summary>
/// P/Invoke directo contra la API C nativa de SimConnect.dll (NO el ensamblado
/// administrado Microsoft.FlightSimulator.SimConnect.dll que Microsoft
/// distribuye únicamente junto con la SDK de MSFS, fuera de NuGet).
///
/// SimConnect.dll nativa es la misma DLL que usan add-ons en C/C++; se
/// encuentra:
///   - Dentro de la instalación de MSFS (usada por el propio sim y sus add-ons), o
///   - En la carpeta "SimConnect SDK/lib" de la SDK oficial de MSFS.
/// Debe copiarse junto al ejecutable del bridge (o quedar en el PATH) para que
/// estos [DllImport] se resuelvan en tiempo de ejecución. La firma de estas
/// funciones es pública y estable desde FSX (documentada por Microsoft/Asobo);
/// no requiere ingeniería inversa, solo reproducir el prototipo en C#.
///
/// Este archivo compila sin la DLL presente (DllImport solo se resuelve en
/// tiempo de ejecución) — ver README.md de este proyecto para el estado
/// honesto de qué se pudo y no se pudo verificar sin MSFS instalado.
/// </summary>
internal static class NativeMethods
{
    private const string DllName = "SimConnect.dll";

    [DllImport(DllName, CharSet = CharSet.Ansi, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_Open(
        out IntPtr phSimConnect,
        string szName,
        IntPtr hWnd,
        uint userEventWin32,
        IntPtr hEventHandle,
        uint configIndex);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_Close(IntPtr hSimConnect);

    [DllImport(DllName, CharSet = CharSet.Ansi, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_MapClientEventToSimEvent(
        IntPtr hSimConnect,
        uint eventId,
        string eventName);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_TransmitClientEvent(
        IntPtr hSimConnect,
        uint objectId,
        uint eventId,
        uint dwData,
        uint groupId,
        uint flags);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_AddClientEventToNotificationGroup(
        IntPtr hSimConnect,
        uint groupId,
        uint eventId,
        [MarshalAs(UnmanagedType.I4)] int bMaskable);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_SetNotificationGroupPriority(
        IntPtr hSimConnect,
        uint groupId,
        uint priority);

    [DllImport(DllName, CharSet = CharSet.Ansi, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_AddToDataDefinition(
        IntPtr hSimConnect,
        uint defineId,
        string datumName,
        string? unitsName,
        uint datumType,
        float fEpsilon,
        uint datumId);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_RequestDataOnSimObject(
        IntPtr hSimConnect,
        uint requestId,
        uint defineId,
        uint objectId,
        uint period,
        uint flags,
        uint origin,
        uint interval,
        uint limit);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_SetDataOnSimObject(
        IntPtr hSimConnect,
        uint defineId,
        uint objectId,
        uint flags,
        uint arrayCount,
        uint cbUnitSize,
        IntPtr pDataSet);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_GetNextDispatch(
        IntPtr hSimConnect,
        out IntPtr ppData,
        out uint pcbData);

    [DllImport(DllName, CharSet = CharSet.Ansi, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_RequestSystemState(
        IntPtr hSimConnect,
        uint requestId,
        string state);

    // --- Client Data Area API (usada por PmdgClientDataClient para leer/escribir
    // el SDK de terceros de PMDG NG3, ver PMDG_NG3_ConnectionTest.cpp de referencia).
    // Firmas reproducidas del SimConnect.h público de la SDK de MSFS (estables
    // desde FSX), NO específicas de PMDG: cualquier addon que publique un Client
    // Data Area usa esta misma API.

    [DllImport(DllName, CharSet = CharSet.Ansi, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_MapClientDataNameToID(
        IntPtr hSimConnect,
        string szClientDataName,
        uint clientDataId);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_AddToClientDataDefinition(
        IntPtr hSimConnect,
        uint defineId,
        uint dwOffset,
        uint dwSizeOrType,
        float fEpsilon,
        uint datumId);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_RequestClientData(
        IntPtr hSimConnect,
        uint clientDataId,
        uint requestId,
        uint defineId,
        uint period,
        uint flags,
        uint origin,
        uint interval,
        uint limit);

    [DllImport(DllName, CallingConvention = CallingConvention.StdCall)]
    public static extern int SimConnect_SetClientData(
        IntPtr hSimConnect,
        uint clientDataId,
        uint defineId,
        uint flags,
        uint dwReserved,
        uint cbUnitSize,
        IntPtr pDataSet);
}
