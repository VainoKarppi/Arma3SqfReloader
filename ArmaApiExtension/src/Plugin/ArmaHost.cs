using System;
using System.Runtime.InteropServices;

namespace ArmaApi;

/// <summary>
/// The five entry points Arma 3 resolves inside an <c>_x64.dll</c> extension.
/// They are exported as unmanaged stdcall/function-pointer targets, so the
/// signatures here are part of the ABI and must not change.
/// </summary>
internal static unsafe class ArmaHost {
    internal const int ReturnCodeSuccess = 0;
    internal const int ReturnCodeError = 1;
    internal const int ReturnCodeInvalidParameters = 3;

    /// <summary>
    /// Pointer Arma hands over in RVExtensionRegisterCallback. Signature:
    /// <c>int callback(string extensionName, string function, string data)</c>.
    /// </summary>
    internal static delegate* unmanaged<string, string, string, int> Callback;

    /// <summary>The script file/line/stack information of the current call, if any.</summary>
    internal static ExtensionCallContext? Context;

    [UnmanagedCallersOnly(EntryPoint = "RVExtensionRegisterCallback")]
    private static void RegisterCallback(delegate* unmanaged<string, string, string, int> callback) {
        Callback = callback;
    }

    [UnmanagedCallersOnly(EntryPoint = "RVExtensionContext")]
    private static void SetContext(IntPtr* args, uint argsCount) {
        string Arg(int index) => index < argsCount && args[index] != IntPtr.Zero
            ? Marshal.PtrToStringAnsi(args[index]) ?? string.Empty
            : string.Empty;

        int index = 0;
        _ = Arg(index++); // caption text

        var context = new ExtensionCallContext {
            SteamId = ulong.TryParse(Arg(index++), out var steamId) ? steamId : 0,
            FileSource = Arg(index++),
            MissionName = Arg(index++),
            ServerName = Arg(index++),
            RemoteExecutedOwner = short.TryParse(Arg(index++), out var owner) ? owner : (short)0
        };

        if (index < argsCount && int.TryParse(Arg(index++), out int stackDepth)) {
            for (int i = 0; i < stackDepth && index + 4 < argsCount; i++) {
                context.StackTrace.Add(new ExtensionCallContext.StackLine {
                    Line = uint.TryParse(Arg(index++), out var line) ? line : 0,
                    FileOffset = uint.TryParse(Arg(index++), out var offset) ? offset : 0,
                    SourceFile = Arg(index++),
                    Scope = Arg(index++)
                });
                // The last field of a stack frame is the raw file content (may contain |),
                // keep it out of the captured prototype to stay cheap.
                index++;
            }
        }

        Context = context;
    }

    [UnmanagedCallersOnly(EntryPoint = "RVExtensionVersion")]
    private static void Version(nint output, int outputSize) {
        ExtensionHost.Initialize();

        Write(output, outputSize, ExtensionResult.Success(ExtensionHost.Version));
    }

    [UnmanagedCallersOnly(EntryPoint = "RVExtension")]
    private static int Call(nint output, int outputSize, nint function) {
        string request = Marshal.PtrToStringAnsi(function) ?? string.Empty;
        return Dispatch(output, outputSize, request, []);
    }

    [UnmanagedCallersOnly(EntryPoint = "RVExtensionArgs")]
    private static int CallArgs(nint output, int outputSize, nint function, nint args, int argsCount) {
        string request = Marshal.PtrToStringAnsi(function) ?? string.Empty;

        var argArray = new string[argsCount];
        for (int i = 0; i < argsCount; i++)
            argArray[i] = Marshal.PtrToStringAnsi(Marshal.ReadIntPtr(args, i * IntPtr.Size)) ?? string.Empty;

        return Dispatch(output, outputSize, request, argArray);
    }

    private static int Dispatch(nint output, int outputSize, string request, string[] args) {
        ExtensionHost.Initialize();

        try {
            var (payload, returnCode) = ExtensionHost.Execute(request, args);
            Write(output, outputSize, payload);
            return returnCode;
        } catch (Exception ex) {
            ArmaLog.Error($"Unhandled extension error: {ex}");
            Write(output, outputSize, ExtensionResult.Error(ex.Message));
            return ReturnCodeError;
        }
    }

    private static void Write(nint output, int outputSize, string payload) {
        if (output == IntPtr.Zero || outputSize <= 0) return;

        byte[] bytes = System.Text.Encoding.UTF8.GetBytes(payload);
        int length = Math.Min(bytes.Length, outputSize - 1);

        Marshal.Copy(bytes, 0, output, length);
        Marshal.WriteByte(output, length, 0);
    }
}

/// <summary>Information about the script call that reached the extension.</summary>
internal sealed class ExtensionCallContext {
    public string MethodName { get; set; } = string.Empty;
    public int? AsyncKey { get; set; }
    public ulong SteamId { get; init; }
    public string FileSource { get; init; } = string.Empty;
    public string MissionName { get; init; } = string.Empty;
    public string ServerName { get; init; } = string.Empty;
    public short RemoteExecutedOwner { get; init; }
    public System.Collections.Generic.List<StackLine> StackTrace { get; init; } = [];

    public sealed class StackLine {
        public uint Line { get; init; }
        public uint FileOffset { get; init; }
        public string SourceFile { get; init; } = string.Empty;
        public string Scope { get; init; } = string.Empty;
    }
}
