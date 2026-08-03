using SharedCockpit.Bridge.Infrastructure;
using Xunit;

namespace SimulatorBridge.Tests;

public class BridgeConfigurationTests
{
    [Fact]
    public void MissingConfig_FallsBackToExpectedDefaults()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        var config = BridgeConfiguration.Load(root);

        Assert.Equal(17481, config.Bridge.LocalWebSocket.Port);
        Assert.Equal("127.0.0.1", config.Bridge.LocalWebSocket.Host);
        Assert.Equal("iFly737MAX_SDK_Mutex", config.Bridge.Ifly.MutexName);
        Assert.Equal("737MAX_Plugin", config.Bridge.Ifly.PluginProcessName);
        Assert.Equal("iFly737MAX_SDK_FileMappingObject", config.Bridge.Ifly.MappingName);
        Assert.True(config.Bridge.Ifly.CommandChannelAvailable);
    }
}
