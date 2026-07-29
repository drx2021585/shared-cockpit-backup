using System.Reflection;
using System.Text.Json.Nodes;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// Regresión de un fallo REAL visto en vivo el 2026-07-28: con el perfil del
/// iFly 737 MAX 8 cargado (982 L-Vars leídas ~30 veces por segundo), una sola
/// lectura que lanzaba una excepción no prevista se escapaba del ciclo de Pump,
/// subía hasta Program.cs y terminaba el proceso del bridge en pleno vuelo.
///
/// El bridge es un proceso de fondo: una etapa que falla debe degradarse y
/// reportarse, nunca tumbar el resto.
/// </summary>
public class BridgeServicePumpResilienceTests
{
    [Fact]
    public void PumpSafely_SwallowsUnexpectedException_AndReportsItOnce()
    {
        var broadcasts = new List<JsonObject>();
        var service = MakeService(broadcasts);

        var boom = 0;
        Action alwaysThrows = () =>
        {
            boom++;
            throw new InvalidOperationException("L-Var inexistente");
        };

        // Tres ciclos seguidos fallando: ninguno debe propagar la excepción...
        for (var i = 0; i < 3; i++)
        {
            InvokePumpSafely(service, "lvars", alwaysThrows);
        }

        Assert.Equal(3, boom);
        // ...y el fallo se reporta UNA sola vez, no 30 veces por segundo.
        Assert.Single(broadcasts, b => IsPumpError(b, "lvars"));
    }

    [Fact]
    public void PumpSafely_ReportsAgain_AfterStageRecoversAndFailsOnceMore()
    {
        var broadcasts = new List<JsonObject>();
        var service = MakeService(broadcasts);

        InvokePumpSafely(service, "lvars", () => throw new InvalidOperationException("primer fallo"));
        InvokePumpSafely(service, "lvars", () => { });               // se recupera
        InvokePumpSafely(service, "lvars", () => throw new InvalidOperationException("segundo fallo"));

        var pumpErrors = broadcasts.Count(b => IsPumpError(b, "lvars"));
        Assert.Equal(2, pumpErrors);
    }

    [Fact]
    public void PumpSafely_DoesNotReportAnything_WhenStageSucceeds()
    {
        var broadcasts = new List<JsonObject>();
        var service = MakeService(broadcasts);

        InvokePumpSafely(service, "simconnect", () => { });

        Assert.DoesNotContain(broadcasts, b => IsPumpError(b, "simconnect"));
    }


    /// <summary>
    /// Regresión del bug visto en vivo el 2026-07-28: un control con
    /// confirmAfterWrite:true pero SIN synchronization.timeoutMs declarado
    /// (1053 de 1053 controles del iFly, 524 de 646 del PMDG) caía en
    /// Math.Max(1, 0) = 1 ms de ventana y abortaba con "no convergió tras 1
    /// intento(s)" antes de que el simulador pudiera siquiera moverse.
    /// </summary>
    [Theory]
    [InlineData(0, 6000)]    // sin declarar -> default utilizable (~9 pasos a ~650ms cada uno)
    [InlineData(400, 400)]   // declarado -> se respeta tal cual
    public void ResolveConfirmTimeoutMs_UsesUsableDefault_WhenProfileDeclaresNone(int declared, int expected)
    {
        var control = new ControlDefinition
        {
            Id = "x.y",
            DataType = ControlDataType.Number,
            Synchronization = new ControlSynchronization { Mode = SyncMode.Event, TimeoutMs = declared },
        };

        var method = typeof(BridgeService).GetMethod(
            "ResolveConfirmTimeoutMs",
            BindingFlags.NonPublic | BindingFlags.Static,
            null,
            new[] { typeof(ControlDefinition) },
            null);
        Assert.NotNull(method);

        Assert.Equal(expected, (int)method!.Invoke(null, new object[] { control })!);
    }

    private static BridgeService MakeService(List<JsonObject> broadcasts) =>
        new(
            new FakeSim(),
            new ProfileRepository(Path.Combine(Path.GetTempPath(), "sharedcockpit-tests-no-profiles")),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020);

    private static bool IsPumpError(JsonObject msg, string stage) =>
        msg["type"]?.GetValue<string>() == "bridge.error"
        && msg["operation"]?.GetValue<string>() == "pump"
        && msg["controlId"]?.GetValue<string>() == stage;

    private static void InvokePumpSafely(BridgeService service, string stage, Action pump)
    {
        var method = typeof(BridgeService).GetMethod(
            "PumpSafely",
            BindingFlags.NonPublic | BindingFlags.Instance,
            null,
            new[] { typeof(string), typeof(Action) },
            null);
        Assert.NotNull(method);
        method!.Invoke(service, new object[] { stage, pump });
    }

    private sealed class FakeSim : ISimConnectClient
    {
        public bool IsConnected => true;
        public event Action? Connected;
        public event Action? Disconnected;
        public event Action<string>? SimConnectException;
        public event Action<string, double>? NumericValueReceived;
        public event Action<string, string>? StringValueReceived;

        public bool TryConnect(string appName) => true;
        public void Disconnect() { }
        public void Pump() { }
        public void SubscribeNumeric(string key, string simVarName, string units, PollMode mode) { }
        public void SubscribeString(string key, string simVarName, PollMode mode) { }
        public void TransmitSetEvent(string eventName, uint dwData) { }
        public void WriteNumeric(string key, double value) { }
        public void Dispose() { }
    }

    private sealed class FakeLog : ILog
    {
        public void Info(string message) { }
        public void Warn(string message) { }
        public void Error(string message) { }
        public void Debug(string message) { }
    }
}
