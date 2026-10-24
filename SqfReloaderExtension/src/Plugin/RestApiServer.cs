using System;
using System.Collections.Concurrent;
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
///   POST /api/eval         {"code":"1 + 1","timeoutMs":30000} (waits for an SQF result)
///   POST /api/execute      {"code":"systemChat 'hello'"} (fire and forget)
///   POST /api/reload       {"functions":["TAG_fnc_a"]} or {} for every function marked recompile=1
///   POST /api/log          {"level":"debug"|"info"|"warning"|"error"}
///   GET  /api/status
///   GET  /api/functions
/// </summary>
internal static class RestApiServer {
    private static readonly object Gate = new();
    private static readonly ConcurrentDictionary<string, PendingExecution> PendingExecutions = new(StringComparer.Ordinal);

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

    /// <summary>[function name, Arma source path] entries for workspace functions.</summary>
    public static IReadOnlyList<object?[]> ConfiguredWorkspaceFunctions { get; private set; } = Array.Empty<object?[]>();

    public static string Start() {
        lock (Gate) {
            if (IsRunning) return $"Already running on {Url}";

            ApiConfig config = ApiConfig.Load();
            ConfiguredPboPrefixes = config.PboPrefixes;
            ConfiguredWorkspaceFunctions = config.WorkspaceFunctions;

            if (!string.IsNullOrEmpty(config.SourceDirectory) && System.IO.Directory.Exists(config.SourceDirectory))
                ReloadPlugin.SourceDirectory = config.SourceDirectory;

            if (!CanBind(config.Host, config.Port, out string reason)) {
                ArmaLog.Error($"API port {config.Host}:{config.Port} is already taken ({reason}); trying the next free port.");
                int fallback = FindFreePort(config.Host, config.Port);
                ArmaLog.Error($"API fallback: using {config.Host}:{fallback}. Update sqfReloader.apiUrl in VS Code (or SqfReloader_fnc_apiStart {fallback}) to reach it.");
                return StartCore(config.Host, fallback);
            }

            return StartCore(config.Host, config.Port);
        }
    }

    /// <summary>
    /// HttpListener binds the whole prefix, so two extensions listening on 127.0.0.1:8764 are
    /// mutually exclusive. Probing first keeps the error understandable: otherwise Windows only
    /// answers "conflicts with an existing registration on the machine".
    /// </summary>
    private static bool CanBind(string host, int port, out string reason) {
        try {
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://{host}:{port}/");
            listener.Start();
            listener.Stop();
            listener.Close();
            reason = string.Empty;
            return true;
        } catch (Exception ex) {
            reason = ex.Message;
            return false;
        }
    }

    /// <summary>First free port at or above <paramref name="preferred"/> (40 ports are tried).</summary>
    private static int FindFreePort(string host, int preferred) {
        for (int offset = 1; offset <= 40; offset++) {
            int candidate = preferred + offset;
            if (candidate > 65535) break;
            if (CanBind(host, candidate, out _)) return candidate;
        }

        // Everything above is taken: try below as a last resort.
        for (int candidate = preferred - 1; candidate >= 1024; candidate--) {
            if (CanBind(host, candidate, out _)) return candidate;
        }

        return preferred;
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
            if (port != DefaultListeningPort())
                PublishPort(port);

            return $"REST API listening on {Url}";
        } catch (Exception ex) {
            ArmaLog.Error($"Could not start REST API on {host}:{port}: {ex.Message}");
            return $"Failed to start REST API on {host}:{port}: {ex.Message}";
        }
    }

    private static int DefaultListeningPort() => ApiConfig.Load().Port;

    /// <summary>
    /// When the fallback port is used, write it back to config.json so the next launch and the
    /// VS Code extension agree on it without anyone editing a setting by hand.
    /// </summary>
    private static void PublishPort(int port) {
        try {
            ApiConfig current = ApiConfig.Load();
            if (current.Port == port) return;

            new ApiConfig {
                Host = current.Host,
                Port = port,
                AutoStart = current.AutoStart,
                SourceDirectory = current.SourceDirectory,
                PboPrefixes = current.PboPrefixes,
                WorkspaceFunctions = current.WorkspaceFunctions
            }.Save();
            ArmaLog.Warning($"SqfReloader config.json now points at the fallback port {port}. Set sqfReloader.apiUrl to http://{Host}:{port}/api in VS Code to use it.");
        } catch (Exception ex) {
            ArmaLog.Warning($"Could not persist the REST API port {port}: {ex.Message}");
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

            if (path == "/api/eval") {
                await HandleEval(context, request);
                return;
            }

            if (path == "/api/execute") {
                var (status, response) = HandleExecute(request);
                await Respond(context, status, response);
                return;
            }

            switch (path) {
                case "/api/command":
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
                "POST /api/eval {code, timeoutMs} (returns the SQF result)",
                "POST /api/execute {code} (fire and forget)",
                "POST /api/reload {functions?}",
                "POST /api/log {level}",
                "POST /api/source {directory}",
                "GET /api/status",
                "GET /api/functions"
            }
        };
    }

    private static (int Status, Dictionary<string, object?> Body) HandleExecute(Dictionary<string, object?> request) {
        if (request.GetValueOrDefault("code") is not string code || string.IsNullOrWhiteSpace(code)) {
            return (400, Error("'code' is required"));
        }

        MessageQueue.Enqueue("COMMAND", SimpleSerializer.ToArma(new object?[] { "code", string.Empty, code }));
        ArmaLog.Log("REST fire-and-forget execution accepted");
        return (202, Ok("execution queued"));
    }

    private static async Task HandleEval(HttpListenerContext context, Dictionary<string, object?> request) {
        if (request.GetValueOrDefault("code") is not string code || string.IsNullOrWhiteSpace(code)) {
            await Respond(context, 400, Error("'code' is required"));
            return;
        }

        int timeoutMs = request.GetValueOrDefault("timeoutMs") switch {
            long value => (int)Math.Clamp(value, 1000, 300000),
            double value => (int)Math.Clamp(value, 1000, 300000),
            _ => 30000
        };
        string requestId = Guid.NewGuid().ToString("N");
        var pending = new PendingExecution();

        PendingExecutions[requestId] = pending;
        string sqf = $"[{SimpleSerializer.ToArma(requestId)}, {SimpleSerializer.ToArma(code)}] spawn {{\n" +
            "    params [\"_requestId\", \"_code\"];\n" +
            "    private _resultJson = \"null\";\n" +
            "    private _error = \"\";\n" +
            "    try {\n" +
            "        private _value = call compile _code;\n" +
            "        if !(isNil \"_value\") then { _resultJson = toJSON _value; };\n" +
            "    } catch {\n" +
            "        _error = str _exception;\n" +
            "    };\n" +
            "    \"SqfReloader\" callExtension [\"ApiPublishResult\", [_requestId, str _resultJson, str _error]];\n" +
            "};";

        MessageQueue.Enqueue("COMMAND", SimpleSerializer.ToArma(new object?[] { "code", string.Empty, sqf }));
        ArmaLog.Log($"REST execution accepted: request={requestId}, timeout={timeoutMs}ms");
        Task completed = await Task.WhenAny(pending.Completion.Task, Task.Delay(timeoutMs));
        PendingExecutions.TryRemove(requestId, out _);
        if (completed != pending.Completion.Task) {
            await Respond(context, 408, Error($"SQF execution timed out after {timeoutMs} ms."));
            return;
        }

        ExecutionResult result = await pending.Completion.Task;
        if (!string.IsNullOrEmpty(result.Error)) {
            await Respond(context, 422, Error(result.Error));
            return;
        }

        await Respond(context, 200, Ok("execution completed", new Dictionary<string, object?> { ["result"] = result.Value }));
    }

    public static string PublishExecutionResult(string requestId, string resultJson, string error) {
        if (!PendingExecutions.TryGetValue(requestId, out PendingExecution? pending))
            return "expired";

        object? value = null;
        if (!string.IsNullOrEmpty(resultJson) && !SimpleJson.TryParseValue(resultJson, out value))
            value = resultJson;

        return pending.Completion.TrySetResult(new ExecutionResult(value, error)) ? "accepted" : "already completed";
    }

    private sealed class PendingExecution {
        public TaskCompletionSource<ExecutionResult> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private sealed record ExecutionResult(object? Value, string Error);

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
