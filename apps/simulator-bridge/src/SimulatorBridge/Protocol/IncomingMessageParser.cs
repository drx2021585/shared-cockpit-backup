using System.Text.Json;
using System.Text.Json.Nodes;

namespace SharedCockpit.Bridge.Protocol;

public abstract record IncomingMessage(MessageOrigin Origin);

public sealed record IncomingControlEvent(
    string SessionId,
    string ControlId,
    JsonNode? RawValue,
    string Source,
    long Sequence,
    long Timestamp,
    MessageOrigin Origin) : IncomingMessage(Origin)
{
    /// <summary>Convierte el valor JSON crudo al tipo declarado por el control (dataType del perfil).</summary>
    public bool AsBool() => RawValue?.GetValue<bool>() ?? false;
    public double AsNumber() => RawValue?.GetValue<double>() ?? 0d;
    public string AsString() => RawValue?.GetValue<string>() ?? string.Empty;
}

public sealed record IncomingControlAxis(
    string ControlId,
    double Value,
    long Sequence,
    long Timestamp,
    MessageOrigin Origin) : IncomingMessage(Origin);

public sealed record IncomingFlightPose(
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
    double VerticalSpeed,
    MessageOrigin Origin) : IncomingMessage(Origin);

public sealed record IncomingUnknown(string RawType, MessageOrigin Origin) : IncomingMessage(Origin);

/// <summary>
/// Parsea mensajes entrantes por el WebSocket local siguiendo
/// packages/protocol/messages.schema.json. Todo mensaje que llega por esta vía
/// (proceso externo, ej. sync-engine o la UI) se marca como origin=remote antes
/// de aplicarse — nunca se reenvía como si fuera un cambio local nuevo (regla
/// de oro anti-ciclos, ver packages/protocol/README.md y CLAUDE.md raíz).
/// </summary>
public static class IncomingMessageParser
{
    public static IncomingMessage? TryParse(string json)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return null;
        }

        if (node is not JsonObject obj || obj["type"] is not JsonValue typeValue)
        {
            return null;
        }

        var type = typeValue.GetValue<string>();

        switch (type)
        {
            case MessageTypes.ControlEvent:
            {
                if (obj["controlId"] is not JsonValue controlIdNode || obj["value"] is null)
                {
                    return null;
                }

                return new IncomingControlEvent(
                    SessionId: obj["sessionId"]?.GetValue<string>() ?? string.Empty,
                    ControlId: controlIdNode.GetValue<string>(),
                    RawValue: obj["value"],
                    Source: obj["source"]?.GetValue<string>() ?? "unknown",
                    Sequence: obj["sequence"]?.GetValue<long>() ?? 0,
                    Timestamp: obj["timestamp"]?.GetValue<long>() ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    Origin: MessageOrigin.Remote);
            }
            case MessageTypes.ControlAxis:
            {
                if (obj["controlId"] is not JsonValue controlIdNode || obj["value"] is not JsonValue valueNode)
                {
                    return null;
                }

                return new IncomingControlAxis(
                    ControlId: controlIdNode.GetValue<string>(),
                    Value: valueNode.GetValue<double>(),
                    Sequence: obj["sequence"]?.GetValue<long>() ?? 0,
                    Timestamp: obj["timestamp"]?.GetValue<long>() ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    Origin: MessageOrigin.Remote);
            }
            case MessageTypes.FlightPose:
            {
                return new IncomingFlightPose(
                    SessionId: obj["sessionId"]?.GetValue<string>() ?? string.Empty,
                    Sequence: obj["sequence"]?.GetValue<long>() ?? 0,
                    Timestamp: obj["timestamp"]?.GetValue<long>() ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    Lat: obj["lat"]?.GetValue<double>() ?? 0d,
                    Lon: obj["lon"]?.GetValue<double>() ?? 0d,
                    Alt: obj["alt"]?.GetValue<double>() ?? 0d,
                    Pitch: obj["pitch"]?.GetValue<double>() ?? 0d,
                    Bank: obj["bank"]?.GetValue<double>() ?? 0d,
                    Heading: obj["heading"]?.GetValue<double>() ?? 0d,
                    GroundSpeed: obj["groundSpeed"]?.GetValue<double>() ?? 0d,
                    IndicatedAirspeed: obj["indicatedAirspeed"]?.GetValue<double>() ?? 0d,
                    VerticalSpeed: obj["verticalSpeed"]?.GetValue<double>() ?? 0d,
                    Origin: MessageOrigin.Remote);
            }
            default:
                return new IncomingUnknown(type, MessageOrigin.Remote);
        }
    }
}
