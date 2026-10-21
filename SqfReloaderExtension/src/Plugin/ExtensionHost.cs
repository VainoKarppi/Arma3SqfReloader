using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;

namespace SqfReloader;

/// <summary>
/// The callExtension dispatcher. Every public static method of a registered
/// container that carries <see cref="ArmaMethodAttribute"/> can be invoked from SQF:
///
///   "SqfReloader" callExtension ["Version", []]
///   "SqfReloader" callExtension ["MyMethod|42", ["arg"]]   // async request id 42
///   "SqfReloader" callExtension ["MyMethod|-1", ["arg"]]   // fire and forget
///
/// Sync call result : ["SUCCESS", [value]] / ["ERROR", ["message"]]
/// Async call result: ["ASYNC_SENT", []] and later an ExtensionCallback
///                    ["ASYNC_RESPONSE|42|0", [value]] (return code 1 on error).
/// </summary>
internal static class ExtensionHost {
    private const int FireAndForgetKey = -1;

    private static readonly object Gate = new();
    private static readonly Dictionary<string, MethodInfo> Methods = new(StringComparer.OrdinalIgnoreCase);
    private static readonly HashSet<int> PendingRequests = [];
    private static bool _initialized;

    public static string Name { get; } = typeof(ExtensionHost).Assembly.GetName().Name?.Replace("_x64", "", StringComparison.Ordinal) ?? "SqfReloader";
    public static string Version { get; } = BuildStamp.Version;

    public static void Initialize() {
        lock (Gate) {
            if (_initialized) return;
            _initialized = true;

            ArmaLog.Initialize();

            Register(typeof(ApiMethods));
            Register(typeof(ReloadPlugin));

            ArmaLog.Log($"Registered methods: {string.Join(", ", Methods.Keys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase))}");
        }
    }

    /// <summary>Registers an extra container of [ArmaMethod] methods.</summary>
    public static void Register(Type container) {
        lock (Gate) {
            MethodInfo[] candidates = container
                .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
                .Where(m => !m.IsSpecialName && m.GetCustomAttribute<ArmaMethodAttribute>() != null)
                .ToArray();

            foreach (MethodInfo method in candidates)
                Methods[method.GetCustomAttribute<ArmaMethodAttribute>()!.Name ?? method.Name] = method;
        }
    }

    public static object?[] MethodIndex() =>
        Methods.Values
            .Select(m => (object?)new object?[] { m.GetCustomAttribute<ArmaMethodAttribute>()!.Name ?? m.Name, IsAsync(m), (long)m.GetParameters().Length })
            .ToArray();

    /// <summary>
    /// Executes <c>name|asyncKey</c>. A request without a key is synchronous (that is what
    /// <c>RVExtension</c> looks like), <c>name|-1</c> means fire-and-forget and
    /// <c>name|123</c> starts an async request whose answer is delivered as a callback.
    /// </summary>
    public static (string Payload, int ReturnCode) Execute(string request, string[] args) {
        int pipe = request.IndexOf('|');

        string name;
        int asyncKey;

        if (pipe >= 0) {
            name = request[..pipe].Trim();
            asyncKey = int.TryParse(request[(pipe + 1)..].Trim(), out int parsedKey) ? parsedKey : -1;
        } else {
            name = request.Trim();
            asyncKey = int.MinValue; // no request id: behave synchronously
        }

        if (ArmaHost.Context is { } context) {
            context.MethodName = name;
            context.AsyncKey = asyncKey;
        }

        if (name.Length == 0)
            return Error("Invalid method name.");

        MethodInfo? method;
        lock (Gate) Methods.TryGetValue(name, out method);

        if (method == null)
            return Error($"Method '{name}' not found.");

        try {
            object?[] parameters = BindArguments(method, args);
            bool isAsync = IsAsync(method);

            if (asyncKey == int.MinValue)
                return (ExtensionResult.Success(Invoke(method, parameters)), ArmaHost.ReturnCodeSuccess);

            if (isAsync && asyncKey >= 0) return StartAsync(method, parameters, asyncKey);

            if (isAsync) {
                _ = Task.Run(() => RunAndForget(method, parameters));
                return (ExtensionResult.Success(), ArmaHost.ReturnCodeSuccess);
            }

            return (ExtensionResult.Success(Invoke(method, parameters)), ArmaHost.ReturnCodeSuccess);
        } catch (Exception ex) {
            string message = Unwrap(ex).Message;
            ArmaLog.Error($"{name} failed: {message}");
            return Error(message);
        }
    }

    /// <summary>Sends an unsolicited message; SQF receives it in the ExtensionCallback handler.</summary>
    public static void SendToArma(string function, params object?[] data) =>
        MessageQueue.Enqueue(function, SimpleSerializer.ToArma(data));

    /// <summary>Broadcasts a notice to every SqfReloader instance in the current session.</summary>
    public static void Notify(string eventName, params object?[] data) =>
        SendToArma("EVENT", [eventName, data]);

    internal static Exception Unwrap(Exception ex) =>
        ex is TargetInvocationException { InnerException: { } inner } ? Unwrap(inner) : ex;

    internal static (string Payload, int ReturnCode) Error(string message) =>
        (ExtensionResult.Error(message), ArmaHost.ReturnCodeError);

    private static (string, int) StartAsync(MethodInfo method, object?[] parameters, int asyncKey) {
        lock (Gate) {
            if (!PendingRequests.Add(asyncKey))
                return (ExtensionResult.Envelope("ASYNC_SENT_FAILED", [$"Async key {asyncKey} is already in use."]), ArmaHost.ReturnCodeError);
        }

        _ = Task.Run(() => {
            try {
                object? result = Invoke(method, parameters);
                MessageQueue.Enqueue($"ASYNC_RESPONSE|{asyncKey}|0", SimpleSerializer.ToArma(new object?[] { result }));
            } catch (Exception ex) {
                string message = Unwrap(ex).Message;
                ArmaLog.Error($"Async method {method.Name}|{asyncKey} failed: {message}");
                MessageQueue.Enqueue($"ASYNC_RESPONSE|{asyncKey}|1", SimpleSerializer.ToArma(new object?[] { message }));
            } finally {
                lock (Gate) PendingRequests.Remove(asyncKey);
            }
        });

        return (ExtensionResult.AsyncSent(), ArmaHost.ReturnCodeSuccess);
    }

    private static void RunAndForget(MethodInfo method, object?[] parameters) {
        try {
            Invoke(method, parameters);
        } catch (Exception ex) {
            ArmaLog.Error($"Async method {method.Name} failed: {Unwrap(ex).Message}");
        }
    }

    /// <summary>Invokes a method and synchronously awaits Task/Task&lt;T&gt; results.</summary>
    private static object? Invoke(MethodInfo method, object?[] parameters) {
        object? result = method.Invoke(null, parameters);

        if (result is not Task task) return result;

        task.GetAwaiter().GetResult();

        Type returnType = method.ReturnType;
        if (returnType.IsGenericType && returnType.GetGenericTypeDefinition() == typeof(Task<>))
            return returnType.GetProperty("Result")?.GetValue(task);

        return null;
    }

    private static object?[] BindArguments(MethodInfo method, string[] args) {
        ParameterInfo[] parameters = method.GetParameters();
        object?[] values = new object?[parameters.Length];

        if (args.Length > parameters.Length)
            throw new ArgumentException($"Method '{method.Name}' takes at most {parameters.Length} argument(s), got {args.Length}.");

        for (int i = 0; i < parameters.Length; i++) {
            if (i >= args.Length) {
                if (!parameters[i].HasDefaultValue)
                    throw new ArgumentException($"Method '{method.Name}' requires argument '{parameters[i].Name}'.");

                values[i] = parameters[i].DefaultValue;
                continue;
            }

            values[i] = SimpleSerializer.Coerce(SimpleSerializer.Parse(args[i]), parameters[i].ParameterType);
        }

        return values;
    }
    private static bool IsAsync(MethodInfo method) {
        Type type = method.ReturnType;
        return type == typeof(Task) || (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Task<>));
    }
}

[AttributeUsage(AttributeTargets.Method)]
internal sealed class ArmaMethodAttribute : Attribute {
    /// <summary>Name used from SQF; defaults to the C# method name.</summary>
    public string? Name { get; init; }
}
