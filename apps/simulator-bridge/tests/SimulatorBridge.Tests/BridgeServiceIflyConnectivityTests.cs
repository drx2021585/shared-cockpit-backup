using System.Reflection;
using SharedCockpit.Bridge.Bridge;
using SharedCockpit.Bridge.Logging;
using SharedCockpit.Bridge.Profiles;
using SharedCockpit.Bridge.Protocol;
using Xunit;

namespace SimulatorBridge.Tests;

public class BridgeServiceIflyConnectivityTests
{
    [Fact]
    public void SubscribeExternalSources_ConnectsIflySdk_WhenProfileUsesItsWriteArea()
    {
        var iflyClient = new FakeClientDataClient();
        var service = new BridgeService(
            new FakeSim(),
            new ProfileRepository(Path.Combine(Path.GetTempPath(), "sharedcockpit-tests-no-profiles")),
            new FakeLog(),
            _ => { },
            SimulatorVersion.Msfs2020,
            iflyClient: iflyClient);

        var profile = new AircraftProfile
        {
            ProfileId = "ifly-737-max8",
            Controls =
            [
                new ControlDefinition
                {
                    Id = "autopilot.master",
                    DataType = ControlDataType.Boolean,
                    Authority = ControlAuthority.Shared,
                    Read = new ControlReadDefinition
                    {
                        Type = ReadType.Lvar,
                        Name = "L:VC_AP_MASTER"
                    },
                    Write = new ControlWriteDefinition
                    {
                        Type = WriteType.ClientDataEvent,
                        AreaName = "iFly737MAX_SDK_Control",
                        Event = "KEY_COMMAND_AP_MASTER"
                    }
                }
            ]
        };

        InvokeSubscribeExternalSources(service, profile);

        Assert.Equal(1, iflyClient.TryConnectCalls);
        Assert.True(iflyClient.IsConnected);
    }

    private static void InvokeSubscribeExternalSources(BridgeService service, AircraftProfile profile)
    {
        var method = typeof(BridgeService).GetMethod(
            "SubscribeExternalSources",
            BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotNull(method);
        method!.Invoke(service, [profile]);
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

    private sealed class FakeClientDataClient : IPmdgClientDataClient
    {
        public bool IsConnected { get; private set; }
        public int TryConnectCalls { get; private set; }

        public event Action? Connected;
        public event Action? Disconnected;
        public event Action<string>? Warning;
        public event Action<string, double>? FieldValueReceived;
        public event Action<string, string>? StringFieldValueReceived;
        public event Action<ScreenSnapshotMessage>? ScreenSnapshotReceived;

        public bool TryConnect(string appName)
        {
            TryConnectCalls++;
            IsConnected = true;
            Connected?.Invoke();
            return true;
        }

        public void Disconnect()
        {
            IsConnected = false;
            Disconnected?.Invoke();
        }

        public void Pump() { }
        public void ResetSubscriptions() { }
        public bool SubscribeField(string controlId, string areaName, string field, int? arrayIndex, ClientDataNativeType nativeType) => true;
        public bool SubscribeScreen(ScreenDefinition screen) => true;
        public bool WriteControlEvent(string areaName, string eventIdOrName, string? parameter) => true;
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
