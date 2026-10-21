using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Microsoft.Extensions.Logging;

namespace SqfReloader;

/// <summary>
/// Main log plus the small Microsoft.Extensions.Logging facade used across the plugin.
/// Output goes to <c>%LOCALAPPDATA%\SqfReloader\logs</c> so the mod folder (usually inside
/// the Arma installation) is never written to; the DLL folder and TEMP are fallbacks.
/// </summary>
public static class ArmaLog {
    public enum LogLevel {
        Debug,
        Info,
        Warning,
        Error
    }

    private static readonly object InitGate = new();
    private static bool _initialized;

    private static ILoggerFactory _factory = Microsoft.Extensions.Logging.Abstractions.NullLoggerFactory.Instance;
    private static ILogger _logger = Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;

    public static bool Enabled { get; set; } = true;

    public static LogLevel CurrentLogLevel { get; set; } = LogLevel.Info;

    public static string LogDirectory { get; private set; } = string.Empty;

    public static void Initialize() {
        lock (InitGate) {
            if (_initialized) return;
            _initialized = true;

            LogDirectory = ResolveLogDirectory();

            try {
                Directory.CreateDirectory(LogDirectory);
                _factory = LoggerFactory.Create(builder => {
                    builder.SetMinimumLevel(Microsoft.Extensions.Logging.LogLevel.Trace);
                    builder.AddProvider(new FileLoggerProvider(Path.Combine(LogDirectory, "SqfReloader.log")));
                });
                _logger = _factory.CreateLogger("SqfReloader");
            } catch (Exception) {
                LogDirectory = string.Empty;
            }

            Log($"SqfReloader {ExtensionHost.Version} initialized. Logs: {(LogDirectory.Length == 0 ? "(disabled)" : LogDirectory)}");
        }
    }

    public static void Log(object? text = null, LogLevel level = LogLevel.Info) {
        if (text == null || !Enabled || level < CurrentLogLevel) return;

        _logger.Log(ToMel(level), "{Message}", text.ToString() ?? string.Empty);
    }

    public static void Debug(object? text) => Log(text, LogLevel.Debug);
    public static void Warning(object? text) => Log(text, LogLevel.Warning);
    public static void Error(object? text) => Log(text, LogLevel.Error);

    private static Microsoft.Extensions.Logging.LogLevel ToMel(LogLevel level) => level switch {
        LogLevel.Debug => Microsoft.Extensions.Logging.LogLevel.Debug,
        LogLevel.Info => Microsoft.Extensions.Logging.LogLevel.Information,
        LogLevel.Warning => Microsoft.Extensions.Logging.LogLevel.Warning,
        LogLevel.Error => Microsoft.Extensions.Logging.LogLevel.Error,
        _ => Microsoft.Extensions.Logging.LogLevel.Information
    };

    private static string ResolveLogDirectory() {
        string dllFolder = AppContext.BaseDirectory;
        string? localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        string[] candidates = [
            string.IsNullOrEmpty(localAppData) ? "" : Path.Combine(localAppData, "SqfReloader", "logs"),
            Path.Combine(dllFolder, "SqfReloader_Logs"),
            Path.Combine(Path.GetTempPath(), "SqfReloader", "logs")
        ];

        foreach (string candidate in candidates) {
            if (string.IsNullOrEmpty(candidate)) continue;

            try {
                Directory.CreateDirectory(candidate);
                string probe = Path.Combine(candidate, ".probe");
                File.WriteAllText(probe, string.Empty);
                File.Delete(probe);
                return candidate;
            } catch (Exception) {
                // Try the next candidate.
            }
        }

        return string.Empty;
    }
}
