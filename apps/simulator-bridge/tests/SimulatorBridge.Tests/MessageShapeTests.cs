using SharedCockpit.Bridge.Protocol;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// Verifica que los mensajes salientes del bridge calzan exactamente con
/// packages/protocol/types.ts / messages.schema.json (nombres de campo, forma),
/// que es el contrato que apps/desktop-ui/src/lib/bridgeClient.ts espera del
/// otro lado del WebSocket.
/// </summary>
public class MessageShapeTests
{
    [Fact]
    public void ControlEvent_SerializesExpectedFieldNames_AndNeverIncludesOrigin()
    {
        var msg = new ControlEventMessage("sess-1", "lights.beacon", true, "bridge:sim", 1, 1_700_000_000_000);
        var json = msg.ToJson();

        Assert.Equal("control.event", json["type"]!.GetValue<string>());
        Assert.Equal("sess-1", json["sessionId"]!.GetValue<string>());
        Assert.Equal("lights.beacon", json["controlId"]!.GetValue<string>());
        Assert.True(json["value"]!.GetValue<bool>());
        Assert.Equal("bridge:sim", json["source"]!.GetValue<string>());
        Assert.Equal(1, json["sequence"]!.GetValue<long>());
        Assert.Equal(1_700_000_000_000, json["timestamp"]!.GetValue<long>());

        // origin lo asigna el RECEPTOR, nunca se serializa hacia la red (regla de oro anti-ciclos).
        Assert.Null(json["origin"]);
    }

    [Fact]
    public void ControlEvent_NumberValue_SerializesAsNumberNotString()
    {
        var msg = new ControlEventMessage("sess-1", "fuel.selector", 2.0, "bridge:sim", 2, 1);
        var json = msg.ToJson();

        Assert.True(json["value"]!.GetValue<double>() == 2.0);
    }

    [Fact]
    public void ControlAxis_SerializesExpectedFieldNames()
    {
        var msg = new ControlAxisMessage("sess-1", "flight.yoke.pitch", 0.42, 7, 123);
        var json = msg.ToJson();

        Assert.Equal("control.axis", json["type"]!.GetValue<string>());
        Assert.Equal("flight.yoke.pitch", json["controlId"]!.GetValue<string>());
        Assert.Equal(0.42, json["value"]!.GetValue<double>());
        Assert.Equal(7, json["sequence"]!.GetValue<long>());
        Assert.Equal(123, json["timestamp"]!.GetValue<long>());
    }

    [Fact]
    public void ScreenSnapshot_SerializesExpectedFieldNames()
    {
        var msg = new ScreenSnapshotMessage(
            "sess-1",
            "cdu_captain",
            14,
            24,
            new[]
            {
                new ScreenCellMessage("A", 2, 0),
                new ScreenCellMessage(string.Empty, 0, 1),
            },
            3,
            true,
            1_700_000_000_123);

        var json = msg.ToJson();

        Assert.Equal("screen.snapshot", json["type"]!.GetValue<string>());
        Assert.Equal("sess-1", json["sessionId"]!.GetValue<string>());
        Assert.Equal("cdu_captain", json["screenId"]!.GetValue<string>());
        Assert.Equal(14, json["rows"]!.GetValue<int>());
        Assert.Equal(24, json["cols"]!.GetValue<int>());
        Assert.Equal(3, json["revision"]!.GetValue<long>());
        Assert.True(json["powered"]!.GetValue<bool>());
        Assert.Equal(1_700_000_000_123, json["timestamp"]!.GetValue<long>());

        var cells = Assert.IsType<System.Text.Json.Nodes.JsonArray>(json["cells"]);
        Assert.Equal(2, cells.Count);
        Assert.Equal("A", cells[0]!["char"]!.GetValue<string>());
        Assert.Equal(2, cells[0]!["colorId"]!.GetValue<int>());
        Assert.Equal(0, cells[0]!["flags"]!.GetValue<int>());
    }

    [Fact]
    public void IncomingControlEvent_IsAlwaysMarkedRemote()
    {
        var json = """{"type":"control.event","sessionId":"s","controlId":"lights.beacon","value":true,"source":"peer-1","sequence":1,"timestamp":1}""";

        var parsed = IncomingMessageParser.TryParse(json);

        var evt = Assert.IsType<IncomingControlEvent>(parsed);
        Assert.Equal(MessageOrigin.Remote, evt.Origin);
        Assert.Equal("lights.beacon", evt.ControlId);
        Assert.True(evt.AsBool());
    }

    [Fact]
    public void IncomingControlAxis_ParsesNumberValue()
    {
        var json = """{"type":"control.axis","controlId":"flight.rudder","value":-0.5,"sequence":9,"timestamp":42}""";

        var parsed = IncomingMessageParser.TryParse(json);

        var axis = Assert.IsType<IncomingControlAxis>(parsed);
        Assert.Equal(MessageOrigin.Remote, axis.Origin);
        Assert.Equal(-0.5, axis.Value);
    }

    [Fact]
    public void MalformedJson_ReturnsNull_DoesNotThrow()
    {
        var parsed = IncomingMessageParser.TryParse("{not valid json");
        Assert.Null(parsed);
    }

    [Fact]
    public void UnknownMessageType_IsPreservedButMarkedUnknown()
    {
        var json = """{"type":"session.ping","sessionId":"s"}""";
        var parsed = IncomingMessageParser.TryParse(json);

        var unknown = Assert.IsType<IncomingUnknown>(parsed);
        Assert.Equal("session.ping", unknown.RawType);
    }
}
