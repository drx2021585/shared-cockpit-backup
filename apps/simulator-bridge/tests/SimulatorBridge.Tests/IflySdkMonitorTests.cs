using SharedCockpit.Bridge.IFlySdk;
using SharedCockpit.Bridge.Infrastructure;
using SharedCockpit.Bridge.Logging;
using Xunit;

namespace SimulatorBridge.Tests;

public class IflySdkMonitorTests
{
    [Fact]
    public void Pump_WithoutSimulator_TransitionsToWaitingForSimulator()
    {
        using var monitor = new IFlySdkMonitor(
            new IFlySdkSection(),
            new FakeProcessDetector(),
            new IFlyMemoryReader(),
            new ConsoleLog(),
            logEveryChange: false);

        monitor.Pump(simulatorConnected: false);

        Assert.Equal(IflyBridgeState.WaitingForSimulator, monitor.CurrentStatus.State);
    }

    [Fact]
    public void Pump_WithPluginButPlaceholderMapping_StaysWaitingForSdkMemory()
    {
        using var monitor = new IFlySdkMonitor(
            new IFlySdkSection(),
            new FakeProcessDetector("FlightSimulator", "737MAX_Plugin"),
            new IFlyMemoryReader(),
            new ConsoleLog(),
            logEveryChange: false);

        monitor.Pump(simulatorConnected: true);

        Assert.Equal(IflyBridgeState.WaitingForSdkMemory, monitor.CurrentStatus.State);
        Assert.Contains("REPLACE_WITH_", monitor.CurrentStatus.LastError);
    }

    private sealed class FakeProcessDetector : IProcessDetector
    {
        private readonly HashSet<string> _running;

        public FakeProcessDetector(params string[] running)
        {
            _running = new HashSet<string>(running, StringComparer.OrdinalIgnoreCase);
        }

        public bool IsRunning(string processName)
        {
            if (_running.Contains(processName))
            {
                return true;
            }

            return processName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                && _running.Contains(processName[..^4]);
        }

        public bool IsAnyRunning(IEnumerable<string> processNames) => processNames.Any(IsRunning);
    }
}
