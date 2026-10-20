using System;
using System.IO;
using System.Text;
using Microsoft.Extensions.Logging;

namespace ArmaApi;

/// <summary>Minimal, allocation-light, thread-safe file logger provider (NativeAOT friendly).</summary>
internal sealed class FileLoggerProvider : ILoggerProvider {
    private readonly string _filePath;
    private readonly object _gate = new();
    private StreamWriter? _writer;
    private long _written;

    private const long MaxFileSize = 8 * 1024 * 1024;

    public FileLoggerProvider(string filePath) {
        _filePath = filePath;
    }

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);

    internal void Write(string category, string message) {
        lock (_gate) {
            try {
                if (_writer == null) {
                    Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
                    _writer = new StreamWriter(new FileStream(_filePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete), new UTF8Encoding(false)) {
                        AutoFlush = true
                    };
                    _written = new FileInfo(_filePath).Length;
                }

                string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} | {category} | {message}";
                _writer.WriteLine(line);
                _written += line.Length + 2;

                if (_written > MaxFileSize) {
                    _writer.Dispose();
                    _writer = null;
                    RotateFile();
                }
            } catch (Exception) {
                // Logging must never take the extension down.
            }
        }
    }

    private void RotateFile() {
        try {
            string old = Path.ChangeExtension(_filePath, ".old.log");
            File.Delete(old);
            File.Move(_filePath, old);
        } catch (Exception) {
            // Ignore rotation failures.
        }
    }

    public void Dispose() {
        lock (_gate) {
            _writer?.Dispose();
            _writer = null;
        }
    }

    private sealed class FileLogger(FileLoggerProvider provider, string category) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) {
            if (!IsEnabled(logLevel)) return;

            string message = formatter(state, exception);
            if (exception != null) message += Environment.NewLine + exception;

            provider.Write($"{ShortLevel(logLevel)} {category}", message);
        }

        private static string ShortLevel(LogLevel level) => level switch {
            LogLevel.Trace => "TRACE",
            LogLevel.Debug => "DEBUG",
            LogLevel.Information => "INFO ",
            LogLevel.Warning => "WARN ",
            LogLevel.Error => "ERROR",
            LogLevel.Critical => "CRIT ",
            _ => "INFO "
        };
    }
}
