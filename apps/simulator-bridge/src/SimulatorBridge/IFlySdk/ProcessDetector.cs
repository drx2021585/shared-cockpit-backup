using System.Diagnostics;
using System.Runtime.InteropServices;

namespace SharedCockpit.Bridge.IFlySdk;

public interface IProcessDetector
{
    bool IsRunning(string processName);
    bool IsAnyRunning(IEnumerable<string> processNames);
    bool HasWindow(string windowTitle);
    bool HasAnyWindow(IEnumerable<string> windowTitles);
}

public sealed class WindowsProcessDetector : IProcessDetector
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string? lpClassName, string? lpWindowName);

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

    public bool HasWindow(string windowTitle)
    {
        if (string.IsNullOrWhiteSpace(windowTitle))
        {
            return false;
        }

        return FindWindow(null, windowTitle) != IntPtr.Zero;
    }

    public bool HasAnyWindow(IEnumerable<string> windowTitles) => windowTitles.Any(HasWindow);
}
