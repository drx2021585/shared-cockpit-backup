using System.Diagnostics;

namespace SharedCockpit.Bridge.IFlySdk;

public interface IProcessDetector
{
    bool IsRunning(string processName);
    bool IsAnyRunning(IEnumerable<string> processNames);
}

public sealed class WindowsProcessDetector : IProcessDetector
{
    public bool IsRunning(string processName)
    {
        if (string.IsNullOrWhiteSpace(processName))
        {
            return false;
        }

        var normalized = processName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? processName[..^4]
            : processName;
        return Process.GetProcessesByName(normalized).Length > 0;
    }

    public bool IsAnyRunning(IEnumerable<string> processNames) => processNames.Any(IsRunning);
}
