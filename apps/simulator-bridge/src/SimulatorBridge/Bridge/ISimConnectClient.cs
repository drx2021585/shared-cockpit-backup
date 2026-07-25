namespace SharedCockpit.Bridge.Bridge;

public enum PollMode
{
    /// <summary>El sim solo nos avisa cuando el valor cambia (control.event, canal confiable).</summary>
    OnChange,

    /// <summary>Se pide el valor a un ritmo continuo (control.axis, canal rápido).</summary>
    Continuous,
}

/// <summary>
/// Abstracción sobre la conexión a SimConnect, para que el resto del bridge
/// (BridgeService, tests) no dependa directamente de P/Invoke / del SDK nativo.
/// Esto permite:
///   1. Probar la lógica de negocio (matching de perfiles, armado de mensajes)
///      sin una conexión real a MSFS.
///   2. Sustituir la implementación el día que se disponga del ensamblado
///      administrado oficial de Microsoft, sin tocar BridgeService.
/// La implementación real (SimConnectNativeClient) vive en SimConnectInterop/ y
/// usa P/Invoke directo contra SimConnect.dll nativa — ver README.md para el
/// estado de verificación honesto (no probado contra MSFS real en este entorno).
/// </summary>
public interface ISimConnectClient : IDisposable
{
    bool IsConnected { get; }

    event Action? Connected;
    event Action? Disconnected;

    /// <summary>Error estructurado de SimConnect (excepción nativa, dwException traducido a texto).</summary>
    event Action<string>? SimConnectException;

    /// <summary>(key, value) numérico recibido para la key suscrita vía SubscribeNumeric.</summary>
    event Action<string, double>? NumericValueReceived;

    /// <summary>(key, value) string recibido para la key suscrita vía SubscribeString (ej. título de aeronave).</summary>
    event Action<string, string>? StringValueReceived;

    /// <summary>Intenta abrir la conexión. No bloquea reintentando: devuelve false de inmediato si MSFS no está corriendo.</summary>
    bool TryConnect(string appName);

    void Disconnect();

    /// <summary>Procesa mensajes pendientes de SimConnect. Debe llamarse periódicamente (ej. cada 20-50ms) mientras IsConnected.</summary>
    void Pump();

    void SubscribeNumeric(string key, string simVarName, string units, PollMode mode);

    void SubscribeString(string key, string simVarName, PollMode mode);

    /// <summary>Ejecuta un Input Event (K:EVENT) con un valor explícito (SET_ON/SET_OFF/SET_VALUE). NUNCA usar para un TOGGLE crudo.</summary>
    void TransmitSetEvent(string eventName, uint dwData);

    /// <summary>Escribe directo un simvar previamente suscrito vía SubscribeNumeric (SimConnect_SetDataOnSimObject).</summary>
    void WriteNumeric(string key, double value);
}
