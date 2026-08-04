using System.Reflection;
using System.Diagnostics;
using System.Text.Json.Nodes;
using SharedCockpit.Bridge.IFlySdk;

namespace SharedCockpit.Bridge.Protocol;

/// <summary>
/// Espejo en C# de packages/protocol/types.ts. NO modificar la forma de estos
/// mensajes sin aprobación del orquestador (contrato compartido). Este archivo
/// solo produce/consume JSON compatible con messages.schema.json; no re-declara
/// el contrato, lo implementa.
/// </summary>
public static class MessageTypes
{
    public const string ControlEvent = "control.event";
    public const string ControlAxis = "control.axis";
    public const string AircraftSnapshot = "aircraft.snapshot";
    public const string FlightPose = "flight.pose";
    public const string ScreenSnapshot = "screen.snapshot";
    public const string AuthorityTransfer = "authority.transfer";
    public const string SessionJoin = "session.join";
    public const string SessionLeave = "session.leave";
    public const string SessionRoleChange = "session.role_change";
    public const string SessionPing = "session.ping";
}

/// <summary>Origen asignado internamente al recibir un mensaje. Nunca se serializa hacia afuera.</summary>
public enum MessageOrigin
{
    Local,
    Remote,
}

/// <summary>
/// Valor discreto de un control (booleano, número o string). El bridge nunca
/// construye un ControlEvent para representar un TOGGLE crudo: `Value` siempre
/// es el estado final explícito (SET_ON/SET_OFF/SET_VALUE).
/// </summary>
public sealed record ControlEventMessage(
    string SessionId,
    string ControlId,
    object Value,
    string Source,
    long Sequence,
    long Timestamp)
{
    public JsonObject ToJson()
    {
        var obj = new JsonObject
        {
            ["type"] = MessageTypes.ControlEvent,
            ["sessionId"] = SessionId,
            ["controlId"] = ControlId,
            ["source"] = Source,
            ["sequence"] = Sequence,
            ["timestamp"] = Timestamp,
        };
        obj["value"] = ValueToJson(Value);
        return obj;
    }

    internal static JsonNode? ValueToJson(object value) => value switch
    {
        bool b => JsonValue.Create(b),
        double d => JsonValue.Create(d),
        float f => JsonValue.Create((double)f),
        int i => JsonValue.Create((double)i),
        long l => JsonValue.Create((double)l),
        string s => JsonValue.Create(s),
        _ => JsonValue.Create(value.ToString()),
    };
}

/// <summary>Eje continuo, canal rápido, último valor gana.</summary>
public sealed record ControlAxisMessage(
    string SessionId,
    string ControlId,
    double Value,
    long Sequence,
    long Timestamp)
{
    public JsonObject ToJson() => new()
    {
        ["type"] = MessageTypes.ControlAxis,
        ["sessionId"] = SessionId,
        ["controlId"] = ControlId,
        ["value"] = Value,
        ["sequence"] = Sequence,
        ["timestamp"] = Timestamp,
    };
}

/// <summary>Estado persistente completo por sistema, usado para sync inicial / resincronización.</summary>
public sealed record AircraftSnapshotMessage(
    string SessionId,
    long Revision,
    string Profile,
    JsonObject Systems)
{
    public JsonObject ToJson() => new()
    {
        ["type"] = MessageTypes.AircraftSnapshot,
        ["sessionId"] = SessionId,
        ["revision"] = Revision,
        ["profile"] = Profile,
        ["systems"] = Systems.DeepClone(),
    };
}

public sealed record FlightPoseMessage(
    string SessionId,
    long Sequence,
    long Timestamp,
    double Lat,
    double Lon,
    double Alt,
    double Pitch,
    double Bank,
    double Heading,
    double GroundSpeed,
    double IndicatedAirspeed,
    double VerticalSpeed)
{
    public JsonObject ToJson() => new()
    {
        ["type"] = MessageTypes.FlightPose,
        ["sessionId"] = SessionId,
        ["sequence"] = Sequence,
        ["timestamp"] = Timestamp,
        ["lat"] = Lat,
        ["lon"] = Lon,
        ["alt"] = Alt,
        ["pitch"] = Pitch,
        ["bank"] = Bank,
        ["heading"] = Heading,
        ["groundSpeed"] = GroundSpeed,
        ["indicatedAirspeed"] = IndicatedAirspeed,
        ["verticalSpeed"] = VerticalSpeed,
    };
}

public sealed record ScreenCellMessage(
    string Char,
    int ColorId,
    int Flags)
{
    public JsonObject ToJson() => new()
    {
        ["char"] = Char,
        ["colorId"] = ColorId,
        ["flags"] = Flags,
    };
}

public sealed record ScreenSnapshotMessage(
    string SessionId,
    string ScreenId,
    int Rows,
    int Cols,
    IReadOnlyList<ScreenCellMessage> Cells,
    long Revision,
    bool? Powered,
    long Timestamp)
{
    public JsonObject ToJson()
    {
        var cells = new JsonArray();
        foreach (var cell in Cells)
        {
            cells.Add(cell.ToJson());
        }

        return new JsonObject
        {
            ["type"] = MessageTypes.ScreenSnapshot,
            ["sessionId"] = SessionId,
            ["screenId"] = ScreenId,
            ["rows"] = Rows,
            ["cols"] = Cols,
            ["cells"] = cells,
            ["powered"] = Powered,
            ["revision"] = Revision,
            ["timestamp"] = Timestamp,
        };
    }
}

/// <summary>
/// Mensaje interno (no protocolo de red) usado por el bridge para reportar su
/// propio estado de conexión/deteccion a la UI local. No forma parte de
/// packages/protocol porque describe el bridge en sí, no un cambio de control.
/// El campo "type" usa el prefijo "bridge." para no colisionar nunca con los
/// tipos reales de SharedCockpitMessage.
/// </summary>
public static class BridgeStatus
{
    public const int BridgeApiVersion = 2;

    private static string ResolveBridgeBuildVersion()
    {
        var assembly = typeof(BridgeStatus).Assembly;
        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            return informational.Split('+')[0];
        }

        var executablePath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(executablePath))
        {
            var fileVersion = FileVersionInfo.GetVersionInfo(executablePath).FileVersion;
            if (!string.IsNullOrWhiteSpace(fileVersion))
            {
                return fileVersion;
            }
        }

        return assembly.GetName().Version?.ToString() ?? "0.1.65";
    }

    public static JsonObject Build(
        bool simConnected,
        string? matchedProfileId,
        string? detectedTitle,
        string? error,
        string simulatorVersion,
        IflySdkStatus? iflyStatus = null,
        JsonObject? backends = null)
    {
        var json = new JsonObject
        {
            ["type"] = "bridge.status",
            ["simConnected"] = simConnected,
            ["matchedProfileId"] = matchedProfileId,
            ["detectedTitle"] = detectedTitle,
            ["simulatorVersion"] = simulatorVersion,
            ["bridgeApiVersion"] = BridgeApiVersion,
            ["bridgeBuildVersion"] = ResolveBridgeBuildVersion(),
            ["error"] = error,
            ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };

        json["ifly"] = BuildIflyStatusJson(iflyStatus);
        json["backends"] = backends?.DeepClone();
        return json;
    }

    internal static JsonObject? BuildIflyStatusJson(IflySdkStatus? status)
    {
        if (status is null)
        {
            return null;
        }

        return new JsonObject
        {
            ["state"] = status.State.ToString(),
            ["simulatorDetected"] = status.SimulatorDetected,
            ["pluginProcessDetected"] = status.PluginProcessDetected,
            ["mutexDetected"] = status.MutexDetected,
            ["sharedMemoryDetected"] = status.SharedMemoryDetected,
            ["readAccessAvailable"] = status.ReadAccessAvailable,
            ["commandAccessAvailable"] = status.CommandAccessAvailable,
            ["pluginProcessName"] = status.PluginProcessName,
            ["expectedSdkVersion"] = status.ExpectedSdkVersion,
            ["reportedSdkVersion"] = status.ReportedSdkVersion,
            ["structureSizeBytes"] = status.StructureSizeBytes,
            ["snapshotByteLength"] = status.SnapshotByteLength,
            ["lastSnapshotAtMs"] = status.LastSnapshotAtMs,
            ["rawChangesObserved"] = status.RawChangesObserved,
            ["lastError"] = status.LastError,
        };
    }
}

/// <summary>
/// Mensaje interno (no protocolo de red, igual que BridgeStatus) con el estado
/// acumulado del bridge en esta sesión: contadores de escritura/lectura, la
/// polaridad que aprendió, y los controles que tuvo que descartar.
///
/// Existe para alimentar el reporte descargable de la UI ("Download report" en la
/// vista Cockpit). Antes, todo este diagnóstico solo existía como texto en
/// bridge.log, lo que obligaba a pedirle al usuario que buscara un archivo en
/// %APPDATA% y lo mandara a mano -- y ni siquiera contenía los contadores, que son
/// lo que permite ver de un golpe si la avalancha de escrituras volvió o si un
/// perfil está fallando en masa.
///
/// Se emite periódicamente (no bajo petición) para que la UI siempre tenga el
/// último sin necesidad de un canal de request/response.
/// </summary>
public static class BridgeDiagnostics
{
    public static JsonObject Build(
        string? matchedProfileId,
        string? detectedTitle,
        int controlsSubscribed,
        int controlsReporting,
        int writesAttempted,
        int writesSkippedAlreadyAtValue,
        int writesConfirmed,
        int writesFailed,
        int polarityInversionsLearned,
        int pulsePressesWritten,
        int errorsReported,
        IEnumerable<string> polarityInvertedControls,
        IflySdkStatus? iflyStatus = null)
    {
        var json = new JsonObject
        {
            ["type"] = "bridge.diagnostics",
            ["matchedProfileId"] = matchedProfileId,
            ["detectedTitle"] = detectedTitle,
            ["controlsSubscribed"] = controlsSubscribed,
            // Cuántas de esas suscripciones han entregado AL MENOS UNA lectura.
            // Suscribirse no garantiza recibir: si la L-Var no existe en la
            // variante cargada (o el sistema no la ha creado todavía), FSUIPC
            // acepta la suscripción y no publica nada nunca. Sin este contador,
            // "controlsSubscribed: 1063" se lee como "1063 controles vivos"
            // cuando podrían estar casi todos mudos -- y un control mudo no
            // sincroniza en NINGUNA dirección: ni se envía lo que hace este
            // piloto, ni se puede confirmar lo que escribe el otro.
            ["controlsReporting"] = controlsReporting,
            ["writesAttempted"] = writesAttempted,
            ["writesSkippedAlreadyAtValue"] = writesSkippedAlreadyAtValue,
            ["writesConfirmed"] = writesConfirmed,
            ["writesFailed"] = writesFailed,
            ["polarityInversionsLearned"] = polarityInversionsLearned,
            ["pulsePressesWritten"] = pulsePressesWritten,
            ["errorsReported"] = errorsReported,
            ["polarityInvertedControls"] = new JsonArray(
                polarityInvertedControls.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };

        json["ifly"] = BridgeStatus.BuildIflyStatusJson(iflyStatus);
        return json;
    }
}

/// <summary>
/// Mensaje estructurado de error de lectura/escritura, para que la UI pueda
/// mostrar diagnóstico (requisito explícito del bridge: "Reportar errores de
/// escritura/lectura de forma estructurada").
/// </summary>
public static class BridgeError
{
    public static JsonObject Build(string controlId, string operation, string message)
    {
        return new JsonObject
        {
            ["type"] = "bridge.error",
            ["controlId"] = controlId,
            ["operation"] = operation,
            ["message"] = message,
            ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
    }
}
