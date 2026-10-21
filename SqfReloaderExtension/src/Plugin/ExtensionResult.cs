using System;

namespace SqfReloader;

/// <summary>
/// The response envelope shared by every <c>callExtension</c> result:
/// <c>[code, [data...]]</c>, e.g. <c>["SUCCESS",[1]]</c> or <c>["ERROR",["boom"]]</c>.
/// </summary>
internal static class ExtensionResult {
    public const string CodeSuccess = "SUCCESS";
    public const string CodeError = "ERROR";
    public const string CodeAsyncSent = "ASYNC_SENT";
    public const string CodeAsyncSentFailed = "ASYNC_SENT_FAILED";
    public const string CodeAsyncResponse = "ASYNC_RESPONSE";

    public static string Success() => Envelope(CodeSuccess, []);

    /// <summary><c>["SUCCESS",[value]]</c>; arrays and dictionaries stay a single value.</summary>
    public static string Success(object? value) => Envelope(CodeSuccess, new object?[] { value });

    public static string Error(string message) => Envelope(CodeError, [message]);

    public static string AsyncSent() => Envelope(CodeAsyncSent, []);

    public static string Envelope(string code, object?[] data) =>
        "[" + SimpleSerializer.ToArma(code) + "," + SimpleSerializer.ToArma(data) + "]";
}
