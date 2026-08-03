using SharedCockpit.Bridge.Infrastructure;
using SharedCockpit.Bridge.Logging;

namespace SharedCockpit.Bridge.IFlySdk;

public sealed class IFlySdkInspector
{
    private readonly IFlySdkMonitor _monitor;
    private readonly IFlySdkSection _config;
    private readonly IProcessDetector _processDetector;
    private readonly ILog _log;

    public IFlySdkInspector(
        IFlySdkMonitor monitor,
        IFlySdkSection config,
        IProcessDetector processDetector,
        ILog log)
    {
        _monitor = monitor;
        _config = config;
        _processDetector = processDetector;
        _log = log;
    }

    public int Run()
    {
        var simulatorDetected = _processDetector.IsAnyRunning(_config.SimulatorProcessNames);
        _monitor.Pump(simulatorDetected);
        var status = _monitor.CurrentStatus;

        _log.Info($"[INFO] Simulator process: {(status.SimulatorDetected ? "FOUND" : "MISSING")}");
        _log.Info($"[INFO] iFly plugin process ({status.PluginProcessName}): {(status.PluginProcessDetected ? "FOUND" : "MISSING")}");
        _log.Info($"[INFO] SDK mutex ({_config.MutexName}): {(status.MutexDetected ? "FOUND" : "MISSING")}");
        _log.Info($"[INFO] Shared memory ({_config.MappingName}): {(status.SharedMemoryDetected ? "OPENED" : "UNAVAILABLE")}");
        _log.Info($"[INFO] SDK structure size: {(status.StructureSizeBytes is int size ? $"{size} bytes" : "UNKNOWN")}");
        _log.Info($"[INFO] SDK version: {status.ReportedSdkVersion ?? status.ExpectedSdkVersion ?? "UNKNOWN"}");
        _log.Info($"[INFO] Aircraft loaded: {(status.ReadAccessAvailable ? "RAW SNAPSHOT AVAILABLE" : "UNKNOWN")}");
        _log.Info($"[STATE] Bridge state: {status.State}");
        _log.Info($"[STATE] Raw changes observed: {status.RawChangesObserved}");

        if (!string.IsNullOrWhiteSpace(status.LastError))
        {
            _log.Warn($"[WARN] {status.LastError}");
        }

        if (status.ReadAccessAvailable)
        {
            _log.Info(
                "[NEXT] Raw shared-memory reads are working. To decode battery/beacon/MCP fields, attach SDK.h, SDK_Defines.h and key_command.h.");
            return 0;
        }

        return 1;
    }
}
