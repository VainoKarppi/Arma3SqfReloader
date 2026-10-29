using System.Net;

namespace SqfReloader;

/// <summary>
/// Documentation page served by GET /api (and /api/docs) when a browser asks for HTML.
/// It is a self-contained string on purpose: the extension runs inside Arma, where no static
/// file hosting exists, and the page must work offline.
/// </summary>
internal static class ApiDocs {
    public static string Page(string url, string version, string logLevel, bool gameConnected, string logDirectory) =>
        Template
            .Replace("@@URL@@", Html(url))
            .Replace("@@VERSION@@", Html(version))
            .Replace("@@LOGLEVEL@@", Html(logLevel))
            .Replace("@@GAMESTATE@@", gameConnected ? "connected" : "not connected")
            .Replace("@@GAMECLASS@@", gameConnected ? "status-ok" : "status-bad")
            .Replace("@@LOGDIRECTORY@@", Html(logDirectory));

    /// <summary>Values can contain characters that are significant in HTML (paths, quotes).</summary>
    private static string Html(string value) => WebUtility.HtmlEncode(value);

    private const string Template = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SqfReloader API</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:960px;margin:0 auto;padding:28px 20px 64px;line-height:1.55;color:#1f2328;background:#fff}
h1{font-size:1.7rem;margin:0 0 2px}
h2{font-size:1.15rem;margin:30px 0 8px;padding-bottom:5px;border-bottom:1px solid #d0d7de}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#f6f8fa;padding:1px 5px;border-radius:4px;font-size:.92em}
pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;font-size:.88rem}
table{border-collapse:collapse;width:100%;font-size:.93rem}
th,td{text-align:left;border-bottom:1px solid #d0d7de;padding:7px 10px 7px 0;vertical-align:top}
th{font-weight:600}
.method{font-weight:600;white-space:nowrap}
.muted{color:#57606a;font-size:.9rem}
.status-ok{color:#1a7f37;font-weight:600}
.status-bad{color:#cf222e;font-weight:600}
@media (prefers-color-scheme:dark){
body{color:#e6edf3;background:#0d1117}
code,pre{background:#161b22}
th,td,h2{border-color:#30363d}
.muted{color:#8b949e}
.status-ok{color:#3fb950}
.status-bad{color:#f85149}
}
</style>
</head>
<body>
<h1>SqfReloader API</h1>
<p class="muted">Version @@VERSION@@ &middot; <a href="@@URL@@">@@URL@@</a> &middot; log level <code>@@LOGLEVEL@@</code></p>
<p>Arma callback: <span class="@@GAMECLASS@@">@@GAMESTATE@@</span></p>

<h2>How it works</h2>
<p>Every Arma instance (client, Eden Editor, hosted mission, dedicated server) uses one API on the
configured port. Requests are queued and executed on the game thread, so HTTP never blocks the game.
<code>POST /api/eval</code> waits for the SQF result; the other write endpoints answer as soon as
Arma accepted the work.</p>

<h2>Endpoints</h2>
<table>
<tr><th>Endpoint</th><th>Body</th><th>Result</th></tr>
<tr><td class="method">GET /api</td><td>&mdash;</td><td>This page in a browser; the status JSON when the request does not accept <code>text/html</code>.</td></tr>
<tr><td class="method">GET /api/status</td><td>&mdash;</td><td>Version, port, <code>gameConnected</code>, log level and directory, endpoint list.</td></tr>
<tr><td class="method">GET /api/functions</td><td>&mdash;</td><td><code>functions</code>: <code>[name, family, absolutePath]</code> for every <code>fn_*.sqf</code> the DLL can reload.</td></tr>
<tr><td class="method">POST /api/eval</td><td><code>{"code":"1 + 1","timeoutMs":30000}</code></td><td><code>result</code> (parsed value) and <code>text</code> (Arma's <code>str</code> output). <code>408</code> on timeout, <code>422</code> on an SQF error.</td></tr>
<tr><td class="method">POST /api/execute</td><td><code>{"code":"systemChat 'hi'"}</code></td><td><code>202</code> once Arma accepted the code; no result is returned.</td></tr>
<tr><td class="method">POST /api/command</td><td><code>{"type":"code","code":"..."}</code> or <code>{"type":"recompile","code":"...","method":"..."}</code></td><td>EdenOnline-compatible command queue.</td></tr>
<tr><td class="method">POST /api/send</td><td><code>{"function":"MyEvent","data":[...]}</code></td><td>Calls a handler registered with <code>SqfReloader_fnc_send</code>.</td></tr>
<tr><td class="method">POST /api/reload</td><td><code>{"functions":["TAG_fnc_a"]}</code> or <code>{}</code></td><td>Reloads the named functions, or every function marked <code>recompile=1</code>.</td></tr>
<tr><td class="method">POST /api/log</td><td><code>{"level":"info"}</code></td><td><code>error</code>, <code>warning</code>, <code>info</code> or <code>debug</code>.</td></tr>
<tr><td class="method">POST /api/source</td><td><code>{"directory":"C:\\path\\to\\addon"}</code></td><td>Points the DLL at the folder holding the plain <code>fn_*.sqf</code> sources.</td></tr>
</table>

<h2>Evaluating SQF</h2>
<pre>curl.exe -s -X POST @@URL@@eval -H "Content-Type: application/json" -d "{\"code\":\"1 + 1\",\"timeoutMs\":10000}"</pre>
<pre>$body = @{ code = '1 + 1'; timeoutMs = 30000 } | ConvertTo-Json
Invoke-RestMethod -Uri @@URL@@eval -Method Post -ContentType application/json -Body $body</pre>
<p>Response for <code>1 + 1</code>:</p>
<pre>{
  "success": true,
  "message": "execution completed",
  "result": 2,
  "text": "2"
}</pre>
<p><code>text</code> is exactly what Arma's debug console prints, for example
<code>[[B Alpha 1-1:1,B Alpha 1-1:2],[],[],[-999]]</code>, while <code>result</code> is that same
literal parsed into arrays, strings, numbers and booleans.</p>
<p>An SQF error answers <code>422</code> with the exception text in <code>error</code>:</p>
<pre>{ "success": false, "error": "Error Zero divisor" }</pre>

<h2>Notes</h2>
<ul>
<li>Any origin may send requests: responses carry <code>Access-Control-Allow-Origin: *</code>.</li>
<li><code>timeoutMs</code> defaults to <code>30000</code> and is clamped to <code>1000..300000</code>. A timed-out execution is not cancelled in Arma.</li>
<li>Request bodies must be a JSON object; unknown routes answer <code>404</code> with a JSON error.</li>
<li>Logs: <code>@@LOGDIRECTORY@@</code></li>
<li>Port and log level live in <code>%LOCALAPPDATA%\SqfReloader\config.json</code>, or can be changed from SQF with <code>SqfReloader_fnc_apiStart</code> and <code>POST /api/log</code>.</li>
</ul>
</body>
</html>
""";
}
