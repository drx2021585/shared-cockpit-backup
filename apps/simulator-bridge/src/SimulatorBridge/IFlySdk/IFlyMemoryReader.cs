using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using SharedCockpit.Bridge.Infrastructure;

namespace SharedCockpit.Bridge.IFlySdk;

public sealed class IFlyMemoryReader
{
    private const uint Synchronize = 0x00100000;
    private const uint MutexModifyState = 0x0001;
    private const uint FileMapRead = 0x0004;

    private const uint WaitObject0 = 0x00000000;
    private const uint WaitAbandoned = 0x00000080;
    private const uint WaitTimeout = 0x00000102;
    private const uint WaitFailed = 0xFFFFFFFF;

    public IFlyMemoryConnection Open(IFlySdkSection config)
    {
        var mutex = NativeMethods.OpenMutex(Synchronize | MutexModifyState, false, config.MutexName);
        if (mutex.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"OpenMutex failed for '{config.MutexName}'.");
        }

        var mapping = NativeMethods.OpenFileMapping(FileMapRead, false, config.MappingName);
        if (mapping.IsInvalid)
        {
            mutex.Dispose();
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"OpenFileMapping failed for '{config.MappingName}'.");
        }

        var view = NativeMethods.MapViewOfFile(mapping, FileMapRead, 0, 0, UIntPtr.Zero);
        if (view.IsInvalid)
        {
            mapping.Dispose();
            mutex.Dispose();
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"MapViewOfFile failed for '{config.MappingName}'.");
        }

        return new IFlyMemoryConnection(mutex, mapping, view, ResolveMappedViewSize(view));
    }

    public IflyRawSnapshot ReadSnapshot(IFlyMemoryConnection connection, int mutexTimeoutMs, int maximumSnapshotBytes)
    {
        var wait = NativeMethods.WaitForSingleObject(connection.MutexHandle, (uint)mutexTimeoutMs);
        var lockTaken = wait is WaitObject0 or WaitAbandoned;
        if (!lockTaken)
        {
            if (wait == WaitTimeout)
            {
                throw new TimeoutException("Timed out waiting for hMutex_737MAXSDK.");
            }

            if (wait == WaitFailed)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed for hMutex_737MAXSDK.");
            }

            throw new InvalidOperationException($"Unexpected WaitForSingleObject result: 0x{wait:X8}.");
        }

        try
        {
            var bytesToCopy = Math.Min(connection.ViewSize, Math.Max(1, maximumSnapshotBytes));
            var bytes = new byte[bytesToCopy];
            Marshal.Copy(connection.ViewHandle.DangerousGetHandle(), bytes, 0, bytes.Length);
            return new IflyRawSnapshot(
                bytes,
                Convert.ToHexString(SHA256.HashData(bytes)),
                MutexWasAbandoned: wait == WaitAbandoned,
                CapturedAtMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }
        finally
        {
            if (!NativeMethods.ReleaseMutex(connection.MutexHandle))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ReleaseMutex failed for hMutex_737MAXSDK.");
            }
        }
    }

    private static int ResolveMappedViewSize(SafeMapViewHandle view)
    {
        if (NativeMethods.VirtualQuery(view.DangerousGetHandle(), out var info, (nuint)Marshal.SizeOf<MemoryBasicInformation>()) == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "VirtualQuery failed for iFly SDK mapping.");
        }

        return info.RegionSize > int.MaxValue ? int.MaxValue : (int)info.RegionSize;
    }

    public sealed class IFlyMemoryConnection : IDisposable
    {
        public IFlyMemoryConnection(
            SafeWaitHandle mutexHandle,
            SafeFileHandle mappingHandle,
            SafeMapViewHandle viewHandle,
            int viewSize)
        {
            MutexHandle = mutexHandle;
            MappingHandle = mappingHandle;
            ViewHandle = viewHandle;
            ViewSize = viewSize;
        }

        public SafeWaitHandle MutexHandle { get; }
        public SafeFileHandle MappingHandle { get; }
        public SafeMapViewHandle ViewHandle { get; }
        public int ViewSize { get; }

        public void Dispose()
        {
            ViewHandle.Dispose();
            MappingHandle.Dispose();
            MutexHandle.Dispose();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryBasicInformation
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public nuint RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    public sealed class SafeMapViewHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public SafeMapViewHandle() : base(true)
        {
        }

        protected override bool ReleaseHandle() => NativeMethods.UnmapViewOfFile(handle);
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafeWaitHandle OpenMutex(uint desiredAccess, bool inheritHandle, string name);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafeFileHandle OpenFileMapping(uint desiredAccess, bool inheritHandle, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern SafeMapViewHandle MapViewOfFile(
            SafeFileHandle fileMappingObject,
            uint desiredAccess,
            uint fileOffsetHigh,
            uint fileOffsetLow,
            UIntPtr numberOfBytesToMap);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UnmapViewOfFile(IntPtr baseAddress);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReleaseMutex(SafeWaitHandle handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern nuint VirtualQuery(
            IntPtr address,
            out MemoryBasicInformation buffer,
            nuint length);
    }
}
