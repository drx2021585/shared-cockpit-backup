namespace SharedCockpit.Bridge.IFlySdk;

public enum IflyBridgeState
{
    Stopped,
    WaitingForSimulator,
    WaitingForIflyPlugin,
    WaitingForSdkMemory,
    ConnectedReadOnly,
    ConnectedFull,
    AircraftReady,
    Error,
}

public sealed record IflySdkStatus(
    IflyBridgeState State,
    bool SimulatorDetected,
    bool PluginProcessDetected,
    bool MutexDetected,
    bool SharedMemoryDetected,
    bool ReadAccessAvailable,
    bool CommandAccessAvailable,
    string PluginProcessName,
    string? ExpectedSdkVersion,
    string? ReportedSdkVersion,
    int? StructureSizeBytes,
    int? SnapshotByteLength,
    long? LastSnapshotAtMs,
    int RawChangesObserved,
    string? LastError)
{
    public static IflySdkStatus Stopped(string pluginProcessName, string? expectedSdkVersion) =>
        new(
            IflyBridgeState.Stopped,
            SimulatorDetected: false,
            PluginProcessDetected: false,
            MutexDetected: false,
            SharedMemoryDetected: false,
            ReadAccessAvailable: false,
            CommandAccessAvailable: false,
            pluginProcessName,
            expectedSdkVersion,
            ReportedSdkVersion: null,
            StructureSizeBytes: null,
            SnapshotByteLength: null,
            LastSnapshotAtMs: null,
            RawChangesObserved: 0,
            LastError: null);
}

public sealed record IflyRawSnapshot(
    byte[] Bytes,
    string Sha256,
    bool MutexWasAbandoned,
    long CapturedAtMs);

public interface IIflySdkMonitor : IDisposable
{
    IflySdkStatus CurrentStatus { get; }
    void Pump(bool simulatorConnected);
}
