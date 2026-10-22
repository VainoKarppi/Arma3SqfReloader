using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace SqfReloader;

/// <summary>
/// Methods exposed to SQF: <c>"SqfReloader" callExtension ["Name", [args]]</c>.
/// </summary>
internal static class ApiMethods {
    [ArmaMethod]
    public static string Version() => ExtensionHost.Version;

    /// <summary>Round-trip probe used by <c>SqfReloader_fnc_diagnose</c> to detect a loaded DLL.</summary>
    [ArmaMethod]
    public static string Ping(string nonce = "") => "pong:" + nonce;

    [ArmaMethod]
    public static string ApiUrl() => RestApiServer.Url;

    [ArmaMethod]
    public static bool ApiIsRunning() => RestApiServer.IsRunning;

    /// <summary>Starts the REST API synchronously so SQF knows the real outcome.</summary>
    [ArmaMethod]
    public static string ApiStart(double port = 8764, string host = "127.0.0.1") =>
        RestApiServer.Start((int)port, string.IsNullOrWhiteSpace(host) ? ApiConfig.DefaultHost : host);

    [ArmaMethod]
    public static string ApiStartFromConfig() => RestApiServer.Start();

    [ArmaMethod]
    public static string ApiStop() => RestApiServer.Stop();

    /// <summary>Publishes a JSON-encoded SQF execution result to the waiting REST client.</summary>
    [ArmaMethod]
    public static string ApiPublishResult(string requestId, string resultJson, string error = "") =>
        RestApiServer.PublishExecutionResult(requestId, resultJson, error);

    [ArmaMethod]
    public static long ApiPort() => RestApiServer.Port;

    /// <summary>
    /// $PBOPREFIX$ of every workspace addon (from config.json), so SQF can resolve a function
    /// tag such as "example" to its addon folder ("@ExampleMod\addons\example" -> "example").
    /// </summary>
    [ArmaMethod]
    public static object?[] ApiPboPrefixes() => RestApiServer.ConfiguredPboPrefixes.Cast<object?>().ToArray();

    /// <summary>Workspace functions to compile into the current mission namespace.</summary>
    [ArmaMethod]
    public static object?[] ApiWorkspaceFunctions() => RestApiServer.ConfiguredWorkspaceFunctions.Cast<object?>().ToArray();

    [ArmaMethod]
    public static string ApiLogLevel(string level = "info") {
        ArmaLog.CurrentLogLevel = level.ToLowerInvariant() switch {
            "debug" => ArmaLog.LogLevel.Debug,
            "warning" or "warn" => ArmaLog.LogLevel.Warning,
            "error" => ArmaLog.LogLevel.Error,
            _ => ArmaLog.LogLevel.Info
        };
        return ArmaLog.CurrentLogLevel.ToString();
    }

    [ArmaMethod]
    public static string ApiLogDirectory() => ArmaLog.LogDirectory;

    /// <summary>
    /// Tells the DLL which mod folder holds the plain SQF sources
    /// (<c>@SqfReloader\source</c>), e.g. when the mod is not installed next to arma3_x64.exe.
    /// </summary>
    [ArmaMethod]
    public static string SetSourceDirectory(string directory) {
        ReloadPlugin.SourceDirectory = directory;
        return ReloadPlugin.SourceDirectory;
    }

    /// <summary>Information SQF needs to reload this mod's own functions.</summary>
    [ArmaMethod]
    public static object?[] FunctionIndex(string addonPath) => ReloadPlugin.BuildIndex(addonPath);

    /// <summary>Names of every method currently callable from SQF.</summary>
    [ArmaMethod]
    public static object?[] Methods() => ExtensionHost.MethodIndex();

    [ArmaMethod]
    public static string Log(string message = "") {
        ArmaLog.Log("[SQF] " + message);
        return "ok";
    }
}

/// <summary>
/// The REST <c>recompile</c> command needs the <c>fn_*.sqf</c> files of the mod. The PBO
/// cannot be read back, so the installer also drops the plain sources into
/// <c>@SqfReloader\source</c>; those are what get compiled at runtime.
/// </summary>
internal static class ReloadPlugin {
    /// <summary>Overrides discovery, set from SQF or the installer config.</summary>
    public static string? SourceDirectory { get; set; }

    [ArmaMethod(Name = "Reload")]
    public static string Reload(string functionName = "") {
        ExtensionHost.SendToArma("RELOAD", new object?[] {
            functionName.Length == 0 ? Array.Empty<object?>() : new object?[] { functionName }
        });

        return functionName.Length == 0 ? "all" : functionName;
    }

    /// <summary>
    /// Returns <c>[functionName, family, absolutePath]</c> for every <c>fn_*.sqf</c> in the
    /// source folder. <paramref name="addonPath"/> is optional; it is a PBO path such as
    /// <c>z\sqfreloader\addons\sqfreloader</c>.
    /// </summary>
    public static object?[] BuildIndex(string addonPath) {
        foreach (string root in CandidateRoots(addonPath)) {
            if (!Directory.Exists(root)) continue;

            object?[] entries = Directory
                .EnumerateFiles(root, "fn_*.sqf", SearchOption.AllDirectories)
                .OrderBy(file => file, StringComparer.OrdinalIgnoreCase)
                .Select(file => (object?)new object?[] {
                    Path.GetFileNameWithoutExtension(file)[3..],
                    Path.GetFileName(Path.GetDirectoryName(file) ?? string.Empty),
                    file
                })
                .ToArray();

            if (entries.Length > 0) return entries;
        }

        return [];
    }

    public static object?[] ListFunctions() => BuildIndex(string.Empty);

    private static IEnumerable<string> CandidateRoots(string addonPath) {
        if (!string.IsNullOrWhiteSpace(SourceDirectory)) {
            yield return SourceDirectory;
        }

        // Modules (@SqfReloader) live next to the game executable.
        string? armaDirectory = ArmaInstallation.Directory;
        if (armaDirectory != null) yield return Path.Combine(armaDirectory, "@SqfReloader", "source");

        if (!string.IsNullOrWhiteSpace(addonPath)) {
            string relative = addonPath.Replace('/', '\\').TrimStart('\\');

            if (armaDirectory != null) yield return Path.Combine(armaDirectory, relative, "source");

            yield return Path.Combine(relative, "source");
        }

        // The DLL ships inside @SqfReloader\dll, so the sibling source folder is one hop away.
        string baseDirectory = AppContext.BaseDirectory.TrimEnd('\\');
        yield return Path.Combine(Path.GetDirectoryName(baseDirectory) ?? baseDirectory, "source");
        yield return baseDirectory;
    }
}

internal static class ArmaInstallation {
    private static readonly Lazy<string?> LazyDirectory = new(Resolve);

    public static string? Directory => LazyDirectory.Value;

    private static string? Resolve() {
        try {
            string? processPath = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
            if (processPath == null) return null;

            // Only a game/server process makes the executable folder the Arma directory.
            string fileName = Path.GetFileNameWithoutExtension(processPath);
            if (fileName.Contains("arma", StringComparison.OrdinalIgnoreCase))
                return Path.GetDirectoryName(processPath);

            return null;
        } catch (Exception) {
            return null;
        }
    }
}
