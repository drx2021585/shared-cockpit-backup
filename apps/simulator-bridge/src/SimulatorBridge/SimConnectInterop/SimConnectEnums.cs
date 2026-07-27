namespace SharedCockpit.Bridge.SimConnectInterop;

/// <summary>
/// Constantes y enums del API C nativo de SimConnect (SimConnect.h de la SDK de
/// MSFS). Estos valores son estables desde FSX y documentados públicamente por
/// Microsoft/Asobo; se reproducen aquí a mano porque el ensamblado administrado
/// oficial (Microsoft.FlightSimulator.SimConnect.dll) no se distribuye por
/// NuGet — ver README.md de este proyecto para la explicación completa.
/// </summary>
internal static class SimConnectConst
{
    public const uint ObjectIdUser = 0;
    public const uint Unused = 0xFFFFFFFF;
    public const uint GroupPriorityHighest = 1;
    public const uint GroupPriorityStandard = 1_900_000_000;
}

internal enum SimConnectRecvId : uint
{
    Null = 0,
    Exception = 1,
    Open = 2,
    Quit = 3,
    Event = 4,
    EventObjectAddRemove = 5,
    EventFilename = 6,
    EventFrame = 7,
    SimObjectData = 8,
    SimObjectDataByType = 9,
    ClientData = 10,
    SystemState = 15,
}

/// <summary>Periodo de envío de un Client Data Area (SIMCONNECT_CLIENT_DATA_PERIOD_*).</summary>
internal enum SimConnectClientDataPeriod : uint
{
    Never = 0,
    Once = 1,
    VisualFrame = 2,
    OnSet = 3,
    Second = 4,
}

internal enum SimConnectDataType : uint
{
    Invalid = 0,
    Int32 = 1,
    Int64 = 2,
    Float32 = 3,
    Float64 = 4,
    String8 = 5,
    String32 = 6,
    String64 = 7,
    String128 = 8,
    String256 = 9,
    String260 = 10,
    StringV = 11,
}

internal enum SimConnectPeriod : uint
{
    Never = 0,
    Once = 1,
    VisualFrame = 2,
    SimFrame = 3,
    Second = 4,
}

[Flags]
internal enum SimConnectDataRequestFlag : uint
{
    Default = 0,
    Changed = 1,
    Tagged = 2,
}

[Flags]
internal enum SimConnectEventFlag : uint
{
    Default = 0,
    FastRepeatTimer = 1,
    SlowRepeatTimer = 2,
    GroupIdIsPriority = 16,
}
