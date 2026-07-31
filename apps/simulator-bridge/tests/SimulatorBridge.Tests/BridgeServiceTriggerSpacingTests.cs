using System.Reflection;
using System.Text.Json.Nodes;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using SharedCockpit.Bridge.Protocol;
using Xunit;

namespace SimulatorBridge.Tests;

/// <summary>
/// La L-Var de trigger del iFly es un buzon de UNA casilla por sistema: el WASM del
/// addon la lee una vez por frame, asi que dos codigos escritos en el mismo tick se
/// pisan y solo sobrevive el ultimo. Con 39 controles compartiendo
/// VC_Fuel_trigger_VAL eso se veia como "de las bombas solo sincroniza AFT".
/// </summary>
public class BridgeServiceTriggerSpacingTests
{
    [Theory]
    // El trigger es el destino del ULTIMO (>L:...) -- las recetas direccionales
    // llevan dos ramas (subir/bajar) y ambas apuntan al mismo buzon.
    [InlineData("(L:VC_Fuel_L_AFT_SW_VAL,number) $value < if{ 7 (>L:VC_Fuel_trigger_VAL,number) }", "VC_Fuel_trigger_VAL")]
    [InlineData("$value 0 > if{ 43 (>L:VC_Navigation_trigger_VAL,number) } els{ 44 (>L:VC_Navigation_trigger_VAL,number) }", "VC_Navigation_trigger_VAL")]
    // Sin escritura de L-Var no hay buzon compartido y no hace falta turno.
    [InlineData("(A:AUTOPILOT MASTER,bool) 1 (>K:AP_MASTER)", null)]
    public void ExtractTriggerLVar_FindsTheSharedMailbox(string code, string? expected)
    {
        Assert.Equal(expected, BridgeService.ExtractTriggerLVar(code));
    }

    [Fact]
    public void TwoControlsOnTheSameTrigger_DoNotWriteInTheSameTick()
    {
        var calculator = new FakeCalculatorCode();
        var service = NewService(calculator);
        SetMatchedProfile(service, FuelProfile());

        // Dos bombas distintas, ambas escriben VC_Fuel_trigger_VAL.
        SendRemote(service, "fuel.fuel_l_aft_sw", 10d);
        SendRemote(service, "fuel.fuel_l_fwd_sw", 10d);

        // Sin reparto de turnos las dos saldrian aqui y la primera se perderia.
        Assert.Single(calculator.ExecutedCodes);
        Assert.Contains("VC_Fuel_L_AFT_SW_VAL", calculator.ExecutedCodes[0]);
    }

    [Fact]
    public void TheDeferredWriteGoesOutOnceTheTriggerIsFree()
    {
        var calculator = new FakeCalculatorCode();
        var service = NewService(calculator);
        SetMatchedProfile(service, FuelProfile());

        SendRemote(service, "fuel.fuel_l_aft_sw", 10d);
        SendRemote(service, "fuel.fuel_l_fwd_sw", 10d);
        Assert.Single(calculator.ExecutedCodes);

        // Pasado el espaciado, el drenado del pump la despacha: NO se pierde.
        Thread.Sleep(60);
        InvokePrivate(service, "DrainDeferredTriggerWrites");

        Assert.Equal(2, calculator.ExecutedCodes.Count);
        Assert.Contains("VC_Fuel_L_FWD_SW_VAL", calculator.ExecutedCodes[1]);
    }

    [Fact]
    public void ControlsOnDifferentTriggers_DoNotBlockEachOther()
    {
        var calculator = new FakeCalculatorCode();
        var service = NewService(calculator);
        SetMatchedProfile(service, FuelProfile());

        // Buzones distintos (Fuel vs Miscellaneous): no compiten por el mismo frame.
        SendRemote(service, "fuel.fuel_l_aft_sw", 10d);
        SendRemote(service, "misc.taxi_light_sw", 10d);

        Assert.Equal(2, calculator.ExecutedCodes.Count);
    }

    [Fact]
    public void ANewerValueForAWaitingControlReplacesTheOldOne()
    {
        var calculator = new FakeCalculatorCode();
        var service = NewService(calculator);
        SetMatchedProfile(service, FuelProfile());

        SendRemote(service, "fuel.fuel_l_aft_sw", 10d);   // toma el turno
        SendRemote(service, "fuel.fuel_l_fwd_sw", 10d);   // espera
        SendRemote(service, "fuel.fuel_l_fwd_sw", 20d);   // reemplaza a la anterior

        Thread.Sleep(60);
        InvokePrivate(service, "DrainDeferredTriggerWrites");

        // Solo sale UNA escritura del control que esperaba, con el valor mas nuevo:
        // mandar dos posiciones seguidas del mismo switch no tiene sentido.
        Assert.Equal(2, calculator.ExecutedCodes.Count);
        Assert.Contains("20", calculator.ExecutedCodes[1]);
    }

    // --- andamiaje -----------------------------------------------------------

    private static BridgeService NewService(FakeCalculatorCode calculator) =>
        new(new FakeSim(),
            new ProfileRepository(Path.GetTempPath()),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            calculatorCodeClient: calculator);

    private static void SendRemote(BridgeService service, string controlId, double value) =>
        service.HandleIncoming(new IncomingControlEvent(
            SessionId: "s1", ControlId: controlId, RawValue: JsonValue.Create(value),
            Source: "peer", Sequence: 1, Timestamp: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Origin: MessageOrigin.Remote));

    private static ControlDefinition Positional(string id, string lvar, string trigger, int up, int down) =>
        new()
        {
            Id = id,
            DataType = ControlDataType.Number,
            Authority = ControlAuthority.Shared,
            Read = new ControlReadDefinition
            {
                Type = ReadType.ClientDataArea,
                AreaName = "SharedCockpitBridge_LVars",
                Field = $"L:{lvar}",
                NativeType = ClientDataNativeType.Float,
            },
            Write = new ControlWriteDefinition
            {
                Type = WriteType.CalculatorCode,
                Name = $"(L:{lvar},number) $value < if{{ {up} (>L:{trigger},number) }} " +
                       $"(L:{lvar},number) $value > if{{ {down} (>L:{trigger},number) }}",
            },
            Synchronization = new ControlSynchronization { Mode = SyncMode.Event, DebounceMs = 0 },
        };

    private static AircraftProfile FuelProfile() => new()
    {
        ProfileId = "ifly-737-max8",
        Manifest = new AircraftManifest(),
        Detection = new DetectionRule(),
        Controls = new[]
        {
            Positional("fuel.fuel_l_aft_sw", "VC_Fuel_L_AFT_SW_VAL", "VC_Fuel_trigger_VAL", 7, 6),
            Positional("fuel.fuel_l_fwd_sw", "VC_Fuel_L_FWD_SW_VAL", "VC_Fuel_trigger_VAL", 9, 8),
            Positional("misc.taxi_light_sw", "VC_Taxi_Light_SW_VAL", "VC_Miscellaneous_trigger_VAL", 26, 27),
        },
    };

    private static void SetMatchedProfile(BridgeService service, AircraftProfile profile)
    {
        var field = typeof(BridgeService).GetField("_matchedProfile", BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(field);
        field!.SetValue(service, profile);
    }

    private static void InvokePrivate(BridgeService service, string methodName)
    {
        var method = typeof(BridgeService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Instance,
            null, Type.EmptyTypes, null);
        Assert.NotNull(method);
        method!.Invoke(service, null);
    }

    private sealed class FakeCalculatorCode : ICalculatorCodeClient
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

    private sealed class FakeSim : ISimConnectClient
    {
        public bool IsConnected => true;
#pragma warning disable CS0067
        public event Action? Connected;
        public event Action? Disconnected;
        public event Action<string>? SimConnectException;
        public event Action<string, double>? NumericValueReceived;
        public event Action<string, string>? StringValueReceived;
#pragma warning restore CS0067
        public bool TryConnect(string appName) => true;
        public void Connect() { }
        public void Disconnect() { }
        public void Pump() { }
        public void SubscribeNumeric(string key, string name, string unit, PollMode mode) { }
        public void SubscribeString(string key, string name, PollMode mode) { }
        public void TransmitSetEvent(string eventName, uint data) { }
        public void WriteNumeric(string key, double value) { }
        public void Dispose() { }
    }

    private sealed class FakeLog : ILog
    {
        public void Debug(string message) { }
        public void Info(string message) { }
        public void Warn(string message) { }
        public void Error(string message) { }
    }
}
