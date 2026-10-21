using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SqfReloader;

/// <summary>
/// Local HTTP API used by editors/tools to push code into a running Arma 3 game.
///
/// The game never blocks on HTTP: every request is acknowledged immediately and
/// the work is queued as an ExtensionCallback message that the SQF side executes
/// on the game thread.
///
/// Routes (prefix <c>/api</c>):
///   POST /api/command      EdenOnline compatible: {"type":"code"|"recompile","code":"...","method":"..."}
///   POST /api/send         {"function":"MyFn","data":[...display formats...]}
///   POST /api/eval         {"code":"player setDamage 1"}  (alias of /command with type=code)
///   POST /api/reload       {"functions":["TAG_fnc_a"]} or {} for every function marked recompile=1
///   POST /api/log          {"level":"debug"|"info"|"warning"|"error"}
///   GET  /api/status
///   GET  /api/functions
/// </summary>
internal static class RestApiServer {
    private static readonly object Gate = new();

    private static HttpListener? _listener;
    private static CancellationTokenSource? _cts;

    public static bool IsRunning => _listener?.IsListening == true;
    public static int Port { get; private set; }
    public static string Host { get; private set; } = "127.0.0.1";
    public static string Url => $"http://{Host}:{Port}/api/";

    /// <summary>
    /// $PBOPREFIX$ of the workspace addons, from config.json. Reported by apiStatus so SQF can
    /// resolve a function tag to its addon folder for hot reloads.
    /// </summary>
    public static IReadOnlyList<string> ConfiguredPboPrefixes { get; private set; } = Array.Empty<string>();

    public static string Start() {
        lock (Gate) {
            if (IsRunning) return $"Already running on {Url}";

            ApiConfig config = ApiConfig.Load();
            ConfiguredPboPrefixes = config.PboPrefixes;

            if (!string.IsNullOrEmpty(config.SourceDirectory) && System.IO.Directory.Exists(config.SourceDirectory))
                ReloadPlugin.SourceDirectory = config.SourceDirectory;

            return StartCore(config.Host, config.Port);
        }
    }

    public static string Start(int port, string host = "127.0.0.1") {
        lock (Gate) return StartCore(host, port);
    }

    private static string StartCore(string host, int port) {
        if (IsRunning) return $"Already running on {Url}";

        try {
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://{host}:{port}/");
            listener.Start();

            _listener = listener;
            _cts = new CancellationTokenSource();
            Host = host;
            Port = port;

            _ = Task.Run(() => AcceptLoop(listener, _cts.Token));

            ArmaLog.Log($"REST API listening on {Url}");
            return $"REST API listening on {Url}";
        } catch (Exception ex) {
            ArmaLog.Error($"Could not start REST API on {host}:{port}: {ex.Message}");
            return $"Failed to start REST API on {host}:{port}: {ex.Message}";
        }
    }

    public static string Stop() {
        lock (Gate) {
            if (!IsRunning) return "REST API is not running";

            _cts?.Cancel();
            _listener?.Stop();
            _listener?.Close();

            _listener = null;
            _cts?.Dispose();
            _cts = null;

            ArmaLog.Log("REST API stopped");
            return "REST API stopped";
        }
    }

    private static async Task AcceptLoop(HttpListener listener, CancellationToken token) {
        while (!token.IsCancellationRequested) {
            HttpListenerContext context;

            try {
                context = await listener.GetContextAsync();
            } catch (Exception) {
                break;
            }

            _ = Task.Run(() => Handle(context));
        }
    }

    private static async Task Handle(HttpListenerContext context) {
        try {
            string path = (context.Request.Url?.AbsolutePath ?? "/").TrimEnd('/').ToLowerInvariant();
            string method = context.Request.HttpMethod.ToUpperInvariant();

            if (method == "GET" && (path == "/api/status" || path == "/api")) {
                await Respond(context, 200, StatusPayload());
                return;
            }

            if (method == "GET" && path == "/api/functions") {
                await Respond(context, 200, new Dictionary<string, object?> {
                    ["functions"] = ReloadPlugin.ListFunctions()
                });
                return;
            }

            if (method != "POST") {
                await Respond(context, 404, Error("Not found"));
                return;
            }

            string body = await ReadBody(context.Request);

            if (!SimpleJson.TryParse(body, out Dictionary<string, object?>? request, out string parseError) || request == null) {
                await Respond(context, 400, Error($"Body must be a JSON object ({parseError})"));
                return;
            }

            switch (path) {
                case "/api/command":
                case "/api/eval":
                case "/api/send":
                case "/api/reload":
                case "/api/log":
                case "/api/source": {
                    var (status, response) = HandlePost(path, request);
                    await Respond(context, status, response);
                    return;
                }
                default:
                    await Respond(context, 404, Error($"Unknown route '{path}'. See GET /api/status."));
                    return;
            }
        } catch (Exception ex) {
            ArmaLog.Error($"REST request failed: {ex}");
            try { await Respond(context, 500, Error(ex.Message)); } catch (Exception) { /* client gone */ }
        } finally {
            context.Response.Close();
        }
    }

    private static (int Status, Dictionary<string, object?> Body) HandlePost(string path, Dictionary<string, object?> request) {
        switch (path) {
            case "/api/command": {
                var command = ArmaCommand.FromJson(request);
                if (command.Error != null) return (400, Error(command.Error));

                MessageQueue.Enqueue("COMMAND", SimpleSerializer.ToArma(new object?[] { command.Type, command.Method ?? string.Empty, command.Code }));
                ArmaLog.Log($"REST command accepted: type={command.Type} method={command.Method}");
                return (200, Ok("command queued", new Dictionary<string, object?> { ["type"] = command.Type, ["method"] = command.Method }));
            }

            case "/api/eval": {
                if (!request.TryGetValue("code", out object? code) || code is not string codeString || string.IsNullOrWhiteSpace(codeString))
                    return (400, Error("'code' is required"));

                MessageQueue.Enqueue("COMMAND", SimpleSerializer.ToArma(new object?[] { "code", string.Empty, codeString }));
                ArmaLog.Log("REST eval accepted");
                return (200, Ok("command queued", new Dictionary<string, object?> { ["type"] = "code" }));
            }

            case "/api/send": {
                if (!request.TryGetValue("function", out object? function) || function is not string functionName || string.IsNullOrWhiteSpace(functionName))
                    return (400, Error("'function' is required"));

                // A missing "data" means "no arguments": [null] would serialize as [nil].
                object? data = request.TryGetValue("data", out object? payload) ? payload : Array.Empty<object?>();
                MessageQueue.Enqueue("SEND", SimpleSerializer.ToArma(new object?[] { functionName, data }));
                ArmaLog.Log($"REST send accepted: function={functionName}");
                return (200, Ok("message queued", new Dictionary<string, object?> { ["function"] = functionName }));
            }

            case "/api/reload": {
                object? functions = request.GetValueOrDefault("functions");
                var queue = new List<object?>();

                if (functions is List<object?> list && list.Count > 0) {
                    foreach (object? item in list)
                        if (item is string name && !string.IsNullOrWhiteSpace(name))
                            queue.Add(name);
                }

                MessageQueue.Enqueue("RELOAD", SimpleSerializer.ToArma(new object?[] { queue.ToArray() }));
                ArmaLog.Log($"REST reload accepted: {queue.Count} function(s)");
                return (200, Ok("reload queued", new Dictionary<string, object?> { ["count"] = (long)queue.Count }));
            }

            case "/api/log": {
                string level = request.GetValueOrDefault("level") as string ?? "info";
                ArmaLog.CurrentLogLevel = level.ToLowerInvariant() switch {
                    "debug" => ArmaLog.LogLevel.Debug,
                    "warning" or "warn" => ArmaLog.LogLevel.Warning,
                    "error" => ArmaLog.LogLevel.Error,
                    _ => ArmaLog.LogLevel.Info
                };
                return (200, Ok($"log level set to {ArmaLog.CurrentLogLevel}"));
            }

            case "/api/source": {
                // Points the DLL at the folder that holds the plain fn_*.sqf sources.
                if (request.GetValueOrDefault("directory") is not string directory)
                    return (400, Error("'directory' is required"));

                if (!System.IO.Directory.Exists(directory))
                    return (400, Error($"Directory not found: {directory}"));

                ReloadPlugin.SourceDirectory = directory;
                ArmaLog.Log($"SQF source directory set to {directory}");

                return (200, Ok("source directory set", new Dictionary<string, object?> {
                    ["directory"] = directory,
                    ["functions"] = ReloadPlugin.ListFunctions()
                }));
            }

            default:
                return (404, Error("Not found"));
        }
    }

    private static Dictionary<string, object?> StatusPayload() {
        bool gameAvailable;
        unsafe { gameAvailable = ArmaHost.Callback != null; }

        return new Dictionary<string, object?> {
            ["status"] = "ok",
            ["extension"] = ExtensionHost.Name,
            ["version"] = ExtensionHost.Version,
            ["port"] = (long)Port,
            ["host"] = Host,
            ["gameConnected"] = gameAvailable,
            ["logLevel"] = ArmaLog.CurrentLogLevel.ToString(),
            ["logDirectory"] = ArmaLog.LogDirectory,
            ["endpoints"] = new object?[] {
                "POST /api/command {type: code|recompile, code, method?}",
                "POST /api/send {function, data}",
                "POST /api/eval {code}",
                "POST /api/reload {functions?}",
                "POST /api/log {level}",
                "POST /api/source {directory}",
                "GET /api/status",
                "GET /api/functions"
            }
        };
    }

    private static Dictionary<string, object?> Ok(string message, Dictionary<string, object?>? extra = null) {
        var result = new Dictionary<string, object?> { ["success"] = true, ["message"] = message };
        if (extra != null)
            foreach (var pair in extra) result[pair.Key] = pair.Value;
        return result;
    }

    private static Dictionary<string, object?> Error(string message) =>
        new() { ["success"] = false, ["error"] = message };

    private static async Task<string> ReadBody(HttpListenerRequest request) {
        using var reader = new StreamReader(request.InputStream, request.ContentEncoding ?? Encoding.UTF8);
        string body = await reader.ReadToEndAsync();

        // BOM-prefixed bodies are common when a script writes files with Out-File.
        return body.TrimStart('\uFEFF');
    }

    private static async Task Respond(HttpListenerContext context, int status, Dictionary<string, object?> payload) {
        byte[] bytes = Encoding.UTF8.GetBytes(SimpleJson.Serialize(payload));

        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength64 = bytes.Length;
        context.Response.Headers["Access-Control-Allow-Origin"] = "*";

        await context.Response.OutputStream.WriteAsync(bytes);
    }

    private sealed record ArmaCommand(string Type, string? Method, string Code, string? Error) {
        public static ArmaCommand FromJson(Dictionary<string, object?> request) {
            if (request.GetValueOrDefault("type") is not string rawType || string.IsNullOrWhiteSpace(rawType))
                return new ArmaCommand("", null, "", "Missing required property 'type'");

            string type = rawType.ToLowerInvariant();
            if (type is not ("code" or "recompile"))
                return new ArmaCommand("", null, "", "Type must be 'code' or 'recompile'");

            if (request.GetValueOrDefault("code") is not string code || string.IsNullOrEmpty(code))
                return new ArmaCommand("", null, "", "Missing required property 'code'");

            string? method = request.GetValueOrDefault("method") as string;

            if (type == "recompile" && string.IsNullOrWhiteSpace(method))
                return new ArmaCommand("", null, "", "Property 'method' is required for recompile commands");

            return new ArmaCommand(type, method, code, null);
        }
    }
}
