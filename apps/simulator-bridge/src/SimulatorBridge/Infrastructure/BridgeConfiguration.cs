using System.Text.Json;

namespace SharedCockpit.Bridge.Infrastructure;

public sealed class BridgeConfiguration
{
    public BridgeSection Bridge { get; init; } = new();

    public static BridgeConfiguration Load(string baseDirectory)
    {
        var path = DiscoverConfigPath(baseDirectory);
        if (path is null || !File.Exists(path))
        {
            return new BridgeConfiguration();
        }

        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<BridgeConfiguration>(
                   json,
                   new JsonSerializerOptions
                   {
                       PropertyNameCaseInsensitive = true,
                       ReadCommentHandling = JsonCommentHandling.Skip,
                       AllowTrailingCommas = true,
                   })
               ?? new BridgeConfiguration();
    }

    private static string? DiscoverConfigPath(string baseDirectory)
    {
        var direct = Path.Combine(baseDirectory, "config", "bridge.json");
        if (File.Exists(direct))
        {
            return direct;
        }

        var current = new DirectoryInfo(baseDirectory);
        while (current is not null)
        {
            var candidate = Path.Combine(current.FullName, "config", "bridge.json");
            if (File.Exists(candidate))
            {
                return candidate;
            }

            current = current.Parent;
        }

        return null;
    }
}

public sealed class BridgeSection
{
    public string Name { get; init; } = "WeConnect.IFlyBridge";
    public LocalWebSocketSection LocalWebSocket { get; init; } = new();
    public IFlySdkSection Ifly { get; init; } = new();
    public DiagnosticsSection Diagnostics { get; init; } = new();
}

public sealed class LocalWebSocketSection
{
    public string Host { get; init; } = "127.0.0.1";
    public int Port { get; init; } = 17481;
    public string[] AllowedOrigins { get; init; } = ["http://localhost", "http://127.0.0.1"];
}

public sealed class IFlySdkSection
{
    public string ExpectedSdkVersion { get; init; } = "REPLACE_WITH_REAL_IFLY_SDK_VERSION";
    public int PollIntervalMs { get; init; } = 20;
    public int MutexTimeoutMs { get; init; } = 250;
    public int ReconnectIntervalMs { get; init; } = 2000;
    public int MaximumSnapshotBytes { get; init; } = 262144;
    public string PluginProcessName { get; init; } = "737MAX_Plugin";
    public string[] SimulatorProcessNames { get; init; } = ["FlightSimulator2024", "FlightSimulator"];
    public string MutexName { get; init; } = "hMutex_737MAXSDK";
    public string MappingName { get; init; } = "REPLACE_WITH_REAL_IFLY_MAPPING_NAME";
    public bool CommandChannelAvailable { get; init; }
}

public sealed class DiagnosticsSection
{
    public bool LogEveryChange { get; init; } = true;
}
