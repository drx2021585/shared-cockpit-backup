using System.Reflection;
using System.Text.Json.Nodes;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using SharedCockpit.Bridge.Protocol;
using Xunit;

namespace SimulatorBridge.Tests;

public class BridgeServiceConfirmAfterWriteTests
{
    [Fact]
    public void ConfirmAfterWrite_RetriesUntilObservedValueConverges()
    {
        var sim = new FakeSimConnectClient();
        var calculator = new FakeCalculatorCodeClient();
        var service = new BridgeService(
            sim,
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithConfirmAfterWriteControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1",
            ControlId: "gear.autobrake_sw",
            RawValue: JsonValue.Create(2d),
            Source: "test",
            Sequence: 1,
            Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Single(calculator.ExecutedCodes);

        // El sim todavía no llegó al valor pedido; al vencer el intervalo de
        // reintento debe volver a escribir.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 1d);
        Thread.Sleep(120);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");

        Assert.Equal(2, calculator.ExecutedCodes.Count);

        // Una vez que el sim confirma el valor objetivo, no deben emitirse más reintentos.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 2d);
        Thread.Sleep(120);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");

        Assert.Equal(2, calculator.ExecutedCodes.Count);
    }


    /// <summary>
    /// Los controles del iFly no aceptan un SET absoluto: cada escritura avanza UN
    /// paso y la dirección la decide el RPN del perfil. Si ese RPN tuviera los
    /// códigos de subir/bajar cruzados, cada reintento alejaría el control un paso
    /// más del destino. La convergencia tiene que cortarse apenas se detecta eso,
    /// en vez de gastar toda la ventana empujando para el lado equivocado.
    /// </summary>
    [Fact]
    public void ConfirmAfterWrite_AbortsAndReportsPolarity_WhenValueMovesAwayFromTarget()
    {
        var calculator = new FakeCalculatorCodeClient();
        var broadcasts = new List<JsonObject>();
        var service = new BridgeService(
            new FakeSimConnectClient(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            broadcasts.Add,
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

        SetMatchedProfile(service, MakeProfileWithConfirmAfterWriteControl());

        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1",
            ControlId: "gear.autobrake_sw",
            RawValue: JsonValue.Create(5d),
            Source: "test",
            Sequence: 1,
            Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

        Assert.Single(calculator.ExecutedCodes);

        // Se acerca (4 -> distancia 1)...
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 4d);
        // ...y de pronto se ALEJA (2 -> distancia 3): polaridad invertida.
        InvokePrivate(service, "OnNumericValueReceived", "gear.autobrake_sw", 2d);

        var polarityError = broadcasts.SingleOrDefault(b =>
            b["type"]?.GetValue<string>() == "bridge.error"
            && b["operation"]?.GetValue<string>() == "confirmAfterWrite");
        Assert.NotNull(polarityError);
        Assert.Contains("polaridad invertida", polarityError!["message"]?.GetValue<string>());

        // Y sobre todo: no se siguen mandando pasos en la dirección equivocada.
        Thread.Sleep(120);
        InvokePrivate(service, "ProcessPendingWriteConfirmations");
        Assert.Single(calculator.ExecutedCodes);
    }

    private static AircraftProfile MakeProfileWithConfirmAfterWriteControl()
    {
        var control = new ControlDefinition
        {
            Id = "gear.autobrake_sw",
            DataType = ControlDataType.Number,
            Authority = ControlAuthority.Shared,
            ReadOnly = false,
            WriteOnly = false,
            Read = new ControlReadDefinition
            {
                Type = ReadType.ClientDataArea,
                AreaName = "SharedCockpitBridge_LVars",
                Field = "L:VC_Autobrake_SW_VAL",
                NativeType = ClientDataNativeType.Float,
            },
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = "(L:VC_Autobrake_SW_VAL,number) $value < if{ 2 (>L:VC_Gear_trigger_VAL,number) }",
            },
            Synchronization = new ControlSynchronization
            {
                Mode = SyncMode.Event,
                DebounceMs = 0,
                ConfirmAfterWrite = true,
                TimeoutMs = 400,
            },
        };

        return new AircraftProfile
        {
            ProfileId = "ifly-737-max8",
            Manifest = new AircraftManifest(),
            Detection = new DetectionRule(),
            Controls = new[] { control },
        };
    }

    private static void SetMatchedProfile(BridgeService service, AircraftProfile profile)
    {
        var field = typeof(BridgeService).GetField("_matchedProfile", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(field);
        field!.SetValue(service, profile);
    }

    private static void InvokePrivate(BridgeService service, string methodName, params object[] args)
    {
        var argTypes = args.Select(a => a.GetType()).ToArray();
        var method = typeof(BridgeService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Instance, null, argTypes, null);
        Assert.NotNull(method);
        method!.Invoke(service, args);
    }

    private sealed class FakeCalculatorCodeClient : ICalculatorCodeClient
    {
        public bool IsConnected => true;
        public List<string> ExecutedCodes { get; } = new();

        public bool TryConnect(string appName) => true;

        public bool ExecuteCalculatorCode(string code)
        {
            ExecutedCodes.Add(code);
            return true;
        }
    }

    private sealed class FakeSimConnectClient : ISimConnectClient
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
