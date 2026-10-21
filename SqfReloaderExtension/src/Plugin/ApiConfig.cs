using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace SqfReloader;

/// <summary>
/// Persisted REST settings: <c>%LOCALAPPDATA%\SqfReloader\config.json</c>. The installer
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

    /// <summary>
    /// $PBOPREFIX$ of every addon in the VS Code workspace (written by the extension). SQF uses it
    /// to map a function tag to the addon folder name; "" when the config has none.
    /// </summary>
    public IReadOnlyList<string> PboPrefixes { get; init; } = Array.Empty<string>();

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
                SourceDirectory = map.TryGetValue("sourceDirectory", out object? source) && source is string sourceText ? sourceText : string.Empty,
                PboPrefixes = ReadPrefixes(map.TryGetValue("pboPrefixes", out object? prefixes) ? prefixes : null)
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
                ["sourceDirectory"] = SourceDirectory,
                ["pboPrefixes"] = PboPrefixes.Cast<object?>().ToList()
            }));
        } catch (Exception ex) {
            ArmaLog.Warning($"Could not write {FilePath}: {ex.Message}");
        }
    }

    private static IReadOnlyList<string> ReadPrefixes(object? value) {
        if (value is not IEnumerable<object> items)
            return Array.Empty<string>();

        var result = new List<string>();

        foreach (object? item in items) {
            if (item is string text && !string.IsNullOrWhiteSpace(text))
                result.Add(text.Trim());
        }

        return result;
    }

    private static string ResolveDirectory() {
        string? localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return string.IsNullOrEmpty(localAppData)
            ? Path.Combine(Path.GetTempPath(), "SqfReloader")
            : Path.Combine(localAppData, "SqfReloader");
    }
}
