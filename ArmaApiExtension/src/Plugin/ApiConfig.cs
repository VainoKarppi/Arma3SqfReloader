using System;
using System.Collections.Generic;
using System.IO;

namespace ArmaApi;

/// <summary>
/// Persisted REST settings: <c>%LOCALAPPDATA%\ArmaApi\config.json</c>. The installer
/// writes this file so the API binds to the right port without touching SQF.
/// </summary>
internal sealed class ApiConfig {
    public const int DefaultPort = 8765;
    public const string DefaultHost = "127.0.0.1";

    public string Host { get; init; } = DefaultHost;
    public int Port { get; init; } = DefaultPort;
    public bool AutoStart { get; init; } = true;

    /// <summary>Folder with the plain fn_*.sqf sources (written by the installer).</summary>
    public string SourceDirectory { get; init; } = string.Empty;

    public static string Directory { get; } = ResolveDirectory();

    public static string FilePath => Path.Combine(Directory, "config.json");

    public static ApiConfig Load() {
        var defaults = new ApiConfig();

        try {
            if (!File.Exists(FilePath)) {
                defaults.Save();
                return defaults;
            }

            if (!SimpleJson.TryParse(File.ReadAllText(FilePath), out var map) || map == null)
                return defaults;

            return new ApiConfig {
                Host = map.TryGetValue("host", out object? host) && host is string { Length: > 0 } hostText ? hostText : DefaultHost,
                Port = map.TryGetValue("port", out object? port) && port is long portNumber ? (int)portNumber : DefaultPort,
                AutoStart = !(map.TryGetValue("autoStart", out object? autoStart) && autoStart is false),
                SourceDirectory = map.TryGetValue("sourceDirectory", out object? source) && source is string sourceText ? sourceText : string.Empty
            };
        } catch (Exception ex) {
            ArmaLog.Warning($"Could not read {FilePath}: {ex.Message}");
            return defaults;
        }
    }

    public void Save() {
        try {
            System.IO.Directory.CreateDirectory(Directory);

            File.WriteAllText(FilePath, SimpleJson.Serialize(new Dictionary<string, object?> {
                ["host"] = Host,
                ["port"] = (long)Port,
                ["autoStart"] = AutoStart,
                ["sourceDirectory"] = SourceDirectory
            }));
        } catch (Exception ex) {
            ArmaLog.Warning($"Could not write {FilePath}: {ex.Message}");
        }
    }

    private static string ResolveDirectory() {
        string? localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return string.IsNullOrEmpty(localAppData)
            ? Path.Combine(Path.GetTempPath(), "ArmaApi")
            : Path.Combine(localAppData, "ArmaApi");
    }
}
