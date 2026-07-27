using SharedCockpit.Bridge.Profiles;

namespace SharedCockpit.Bridge.Bridge;

/// <summary>
/// Abstracción sobre el cliente de Client Data Area de un SDK de terceros (ej.
/// PMDG NG3), en el mismo espíritu que ISimConnectClient: permite a
/// BridgeService orquestar sin acoplarse al P/Invoke real, y facilita simular
/// "SDK de PMDG no disponible" en tests sin tocar SimConnect. La implementación
/// real (PmdgClientDataClient) vive en SimConnectInterop/ — ver ese archivo
/// para el estado de verificación honesto (NO probado contra MSFS/PMDG real en
/// este entorno).
/// </summary>
public interface IPmdgClientDataClient : IDisposable
{
    bool IsConnected { get; }

    event Action? Connected;
    event Action? Disconnected;

    /// <summary>Warning/error estructurado no fatal (SDK no disponible, EnableDataBroadcast=0, campo desconocido, etc.).</summary>
    event Action<string>? Warning;

    /// <summary>(controlId, value numérico) para un campo bool/uchar/uint suscrito vía SubscribeField.</summary>
    event Action<string, double>? FieldValueReceived;

    /// <summary>(controlId, value string) para un campo char_array suscrito vía SubscribeField.</summary>
    event Action<string, string>? StringFieldValueReceived;

    /// <summary>Intenta abrir una conexión SimConnect dedicada para el SDK de terceros. No bloquea: false si no puede conectar ahora mismo.</summary>
    bool TryConnect(string appName);

    void Disconnect();

    /// <summary>Debe llamarse periódicamente (igual que ISimConnectClient.Pump) mientras IsConnected.</summary>
    void Pump();

    /// <summary>
    /// Suscribe un control cuyo read.type=clientDataArea. areaName/field/nativeType
    /// vienen de ControlReadDefinition. Devuelve false (y emite Warning) si el área o
    /// el campo no están soportados todavía por este cliente — ver
    /// PmdgNg3DataLayout para el alcance exacto de campos transcritos.
    /// </summary>
    bool SubscribeField(string controlId, string areaName, string field, int? arrayIndex, ClientDataNativeType nativeType);

    /// <summary>
    /// Escribe un evento determinístico contra un Client Data Area de control (ej.
    /// PMDG_NG3_Control). areaName/event/parameter vienen de ControlWriteDefinition.
    /// NUNCA debe representar un TOGGLE crudo — ver "semantics" obligatorio en el
    /// esquema y ResolveEventId en la implementación.
    /// </summary>
    bool WriteControlEvent(string areaName, string eventIdOrName, string? parameter);
}
