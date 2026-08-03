using SharedCockpit.Bridge.Infrastructure;
using SharedCockpit.Bridge.Logging;

namespace SharedCockpit.Bridge.IFlySdk;

public sealed class IFlySdkMonitor : IIflySdkMonitor
{
    private readonly IFlySdkSection _config;
    private readonly IProcessDetector _processDetector;
    private readonly IFlyMemoryReader _reader;
    private readonly ILog _log;
    private readonly bool _logEveryChange;

    private IFlyMemoryReader.IFlyMemoryConnection? _connection;
    private string? _lastSnapshotHash;
    private long _lastPollAtMs;
    private int _rawChangesObserved;

    public IFlySdkMonitor(
        IFlySdkSection config,
        IProcessDetector processDetector,
        IFlyMemoryReader reader,
        ILog log,
        bool logEveryChange)
    {
        _config = config;
        _processDetector = processDetector;
        _reader = reader;
        _log = log;
        _logEveryChange = logEveryChange;
        CurrentStatus = IflySdkStatus.Stopped(_config.PluginProcessName, _config.ExpectedSdkVersion);
    }

    public IflySdkStatus CurrentStatus { get; private set; }

    public void Pump(bool simulatorConnected)
    {
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (nowMs - _lastPollAtMs < _config.ReconnectIntervalMs)
        {
            return;
        }

        _lastPollAtMs = nowMs;

        var simulatorDetected = simulatorConnected || _processDetector.IsAnyRunning(_config.SimulatorProcessNames);
        if (!simulatorDetected)
        {
            Disconnect();
            CurrentStatus = BuildStatus(IflyBridgeState.WaitingForSimulator, false, false, false, false, false, null, null);
            return;
        }

        var pluginDetected =
            _processDetector.IsRunning(_config.PluginProcessName)
            || _processDetector.HasAnyWindow(_config.PluginWindowTitles);
        if (!pluginDetected)
        {
            Disconnect();
            CurrentStatus = BuildStatus(IflyBridgeState.WaitingForIflyPlugin, true, false, false, false, false, null, null);
            return;
        }

        if (LooksPlaceholder(_config.MappingName))
        {
            Disconnect();
            CurrentStatus = BuildStatus(
                IflyBridgeState.WaitingForSdkMemory,
                true,
                true,
                mutexDetected: true,
                sharedMemoryDetected: false,
                readAccessAvailable: false,
                lastError: "SDK mapping name still uses a REPLACE_WITH_* marker. Attach SDK.h/SDK_Defines.h first.",
                snapshot: null);
            return;
        }

        try
        {
            _connection ??= _reader.Open(_config);
            var snapshot = _reader.ReadSnapshot(_connection, _config.MutexTimeoutMs, _config.MaximumSnapshotBytes);
            if (!string.Equals(snapshot.Sha256, _lastSnapshotHash, StringComparison.Ordinal))
            {
                _lastSnapshotHash = snapshot.Sha256;
                _rawChangesObserved++;
                if (_logEveryChange)
                {
                    _log.Info(
                        $"[iFly SDK] cambio crudo detectado: {snapshot.Bytes.Length} bytes, sha256={snapshot.Sha256[..12]}..., abandoned={snapshot.MutexWasAbandoned}");
                }
            }

            CurrentStatus = BuildStatus(
                _config.CommandChannelAvailable ? IflyBridgeState.ConnectedFull : IflyBridgeState.ConnectedReadOnly,
                true,
                true,
                mutexDetected: true,
                sharedMemoryDetected: true,
                readAccessAvailable: true,
                lastError: snapshot.MutexWasAbandoned ? "The iFly SDK mutex was abandoned by the producer once; reads continue." : null,
                snapshot);
        }
        catch (Exception ex)
        {
            Disconnect();
            CurrentStatus = BuildStatus(
                IflyBridgeState.WaitingForSdkMemory,
                true,
                true,
                mutexDetected: false,
                sharedMemoryDetected: false,
                readAccessAvailable: false,
                lastError: ex.Message,
                snapshot: null);
        }
    }

    public void Dispose() => Disconnect();

    private IflySdkStatus BuildStatus(
        IflyBridgeState state,
        bool simulatorDetected,
        bool pluginDetected,
        bool mutexDetected,
        bool sharedMemoryDetected,
        bool readAccessAvailable,
        string? lastError,
        IflyRawSnapshot? snapshot)
    {
        return new IflySdkStatus(
            state,
            SimulatorDetected: simulatorDetected,
            PluginProcessDetected: pluginDetected,
            MutexDetected: mutexDetected,
            SharedMemoryDetected: sharedMemoryDetected,
            ReadAccessAvailable: readAccessAvailable,
            CommandAccessAvailable: _config.CommandChannelAvailable,
            PluginProcessName: _config.PluginProcessName,
            ExpectedSdkVersion: _config.ExpectedSdkVersion,
            ReportedSdkVersion: null,
            StructureSizeBytes: snapshot?.Bytes.Length,
            SnapshotByteLength: snapshot?.Bytes.Length,
            LastSnapshotAtMs: snapshot?.CapturedAtMs,
            RawChangesObserved: _rawChangesObserved,
            LastError: lastError);
    }

    private static bool LooksPlaceholder(string value) =>
        string.IsNullOrWhiteSpace(value) || value.Contains("REPLACE_WITH_", StringComparison.Ordinal);

    private void Disconnect()
    {
        _connection?.Dispose();
        _connection = null;
        _lastSnapshotHash = null;
    }
}
