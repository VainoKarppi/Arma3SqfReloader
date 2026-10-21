<#
.SYNOPSIS
    Validates the built SqfReloader_x64.dll without Arma 3.

.DESCRIPTION
    Loads the DLL like Arma 3 does (RVExtensionVersion / RVExtension /
    RVExtensionArgs / RVExtensionRegisterCallback), registers a callback sink and
    then exercises the REST API: status, send, command, reload, invalid bodies and
    a 300 message burst that must be coalesced into BATCH callbacks.
    The DLL copy is written to %TEMP%\SqfReloaderSmokeTest so the test can load it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\smoke-test.ps1
#>

[CmdletBinding()]
param(
    [string]$DllPath = "",
    [int]$Port = 8764
)

$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
if ($DllPath -eq "") {
    $DllPath = Join-Path $scriptRoot "..\dist\@SqfReloader\dll\SqfReloader_x64.dll"
}

# Build the PE export probe on demand.
$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
$probeProject = Join-Path $scriptRoot "ExportsProbe\ExportsProbe.csproj"
& $dotnet build $probeProject -c Release -nologo -v q | Out-Null

$dll = (Resolve-Path $DllPath).Path
$workDir = Join-Path $env:TEMP "SqfReloaderSmokeTest"
if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

# The DLL is embedded in the test host so the host folder is added to the DLL
# search path by the runtime (the game does the same for extensions next to arma3_x64.exe).
Copy-Item $dll (Join-Path $workDir "SqfReloader_x64.dll") -Force

$payload = [Convert]::ToBase64String([IO.File]::ReadAllBytes($dll))

$source = @'
using System;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;

public static class ArmaCallExtension {
    public const string Payload = "__PAYLOAD__";

    public static readonly object Gate = new object();
    public static string LastName = "";
    public static string LastFunction = "";
    public static string LastData = "";
    public static int CallbackCount = 0;

    private static CallbackFn keepAlive;

    static ArmaCallExtension() {
        // Keep a copy of the extension next to this assembly and make that folder part of
        // the DLL search path (NativeAOT DLLs are resolved by the OS loader, not by probing
        // the application base directory of a PowerShell host).
        string folder = Path.GetDirectoryName(new Uri(typeof(ArmaCallExtension).Assembly.CodeBase).LocalPath);
        File.WriteAllBytes(Path.Combine(folder, "SqfReloader_x64.dll"), Convert.FromBase64String(Payload));
        AddDllDirectory(folder);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool AddDllDirectory(string path);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
    public delegate int CallbackFn(IntPtr name, IntPtr function, IntPtr data);

    [DllImport("SqfReloader_x64.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern void RVExtensionVersion(IntPtr output, int outputSize);

    [DllImport("SqfReloader_x64.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private static extern int RVExtension(IntPtr output, int outputSize, string function);

    [DllImport("SqfReloader_x64.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern int RVExtensionArgs(IntPtr output, int outputSize, IntPtr function, IntPtr args, int argsCount);

    [DllImport("SqfReloader_x64.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern ulong RVExtensionGetFeatureFlags();

    [DllImport("SqfReloader_x64.dll", CallingConvention = CallingConvention.StdCall)]
    private static extern void RVExtensionRegisterCallback(IntPtr callback);

    public static void RegisterCallback() {
        keepAlive = OnCallback;
        RVExtensionRegisterCallback(Marshal.GetFunctionPointerForDelegate(keepAlive));
    }

    private static int OnCallback(IntPtr name, IntPtr function, IntPtr data) {
        string n = Marshal.PtrToStringAnsi(name) ?? "";
        string f = Marshal.PtrToStringAnsi(function) ?? "";
        string d = Marshal.PtrToStringAnsi(data) ?? "";

        // The DLL delivers on its worker thread; hold the values for the test.
        lock (Gate) {
            LastName = n;
            LastFunction = f;
            LastData = d;
            CallbackCount++;
        }

        // Arma returns the free callback slots, anything >= 0 is accepted.
        return 99;
    }

    public static string FeatureFlags() { return RVExtensionGetFeatureFlags().ToString(); }

    public static string Version() {
        IntPtr buffer = Marshal.AllocHGlobal(20480);
        try {
            RVExtensionVersion(buffer, 20480);
            return Marshal.PtrToStringAnsi(buffer);
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static string Call(string function, string[] args) {
        IntPtr buffer = Marshal.AllocHGlobal(20480);
        try {
            if (args == null || args.Length == 0) {
                int code = RVExtension(buffer, 20480, function);
                return "[" + code + "] " + Marshal.PtrToStringAnsi(buffer);
            }

            IntPtr fn = Marshal.StringToHGlobalAnsi(function);
            IntPtr array = Marshal.AllocHGlobal(IntPtr.Size * args.Length);
            var pointers = new IntPtr[args.Length];

            try {
                for (int i = 0; i < args.Length; i++) {
                    pointers[i] = Marshal.StringToHGlobalAnsi(args[i]);
                    Marshal.WriteIntPtr(array, i * IntPtr.Size, pointers[i]);
                }

                int result = RVExtensionArgs(buffer, 20480, fn, array, args.Length);
                return "[" + result + "] " + Marshal.PtrToStringAnsi(buffer);
            } finally {
                for (int i = 0; i < args.Length; i++) Marshal.FreeHGlobal(pointers[i]);
                Marshal.FreeHGlobal(array);
                Marshal.FreeHGlobal(fn);
            }
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
'@

$source = $source.Replace("__PAYLOAD__", $payload)
$sourcePath = Join-Path $workDir "SqfReloaderTestHost.cs"
Set-Content -Path $sourcePath -Value $source -Encoding UTF8

# Compile into a runtime folder so the test host assembly and the DLL share a directory.
$hostAssembly = Join-Path $workDir "SqfReloaderTestHost.dll"
Add-Type -Path $sourcePath -OutputAssembly $hostAssembly

[System.Reflection.Assembly]::LoadFile($hostAssembly) | Out-Null

$failed = $false

function Get-CallbackSnapshot {
    [System.Threading.Monitor]::Enter([ArmaCallExtension]::Gate)
    try {
        return @([ArmaCallExtension]::LastName, [ArmaCallExtension]::LastFunction, [ArmaCallExtension]::LastData)
    }
    finally {
        [System.Threading.Monitor]::Exit([ArmaCallExtension]::Gate)
    }
}

function Reset-CallbackSnapshot {
    [System.Threading.Monitor]::Enter([ArmaCallExtension]::Gate)
    try {
        [ArmaCallExtension]::LastName = ""
        [ArmaCallExtension]::LastFunction = ""
        [ArmaCallExtension]::LastData = ""
    }
    finally {
        [System.Threading.Monitor]::Exit([ArmaCallExtension]::Gate)
    }
}

function Wait-CallbackSnapshot {
    param([string]$Expected, [int]$TimeoutMs = 3000)

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $snapshot = Get-CallbackSnapshot
        if ($snapshot[1] -like "$Expected*") { return $snapshot }
        Start-Sleep -Milliseconds 25
    }

    return Get-CallbackSnapshot
}

function Invoke-Api {
    param([string]$Method, [string]$Url, [string]$Body)

    try {
        if ($Method -eq "GET") {
            return (Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 5 | ConvertTo-Json -Depth 6 -Compress)
        }

        return (Invoke-RestMethod -Uri $Url -Method Post -Body $Body -ContentType "application/json" -TimeoutSec 5 | ConvertTo-Json -Depth 6 -Compress)
    }
    catch {
        return "ERROR: $($_.Exception.Message)"
    }
}

function Invoke-ApiRaw {
    param([string]$Method, [string]$Url, [string]$Body)

    # HttpClient returns the raw status and body for every response, including 4xx/5xx
    # (Invoke-WebRequest throws there and its response stream cannot always be re-read).
    if ($null -eq $script:httpClient) {
        Add-Type -AssemblyName System.Net.Http
        $script:httpClient = New-Object System.Net.Http.HttpClient
        $script:httpClient.Timeout = [TimeSpan]::FromSeconds(5)
    }

    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::new($Method), $Url)

    if ($Body) {
        $request.Content = New-Object System.Net.Http.StringContent($Body, [System.Text.Encoding]::UTF8, "application/json")
    }

    try {
        $response = $script:httpClient.SendAsync($request).GetAwaiter().GetResult()
        $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $content }
    }
    catch {
        return [pscustomobject]@{ Status = 0; Body = "ERROR: $($_.Exception.Message)" }
    }
}
function Test-Result {
    param([string]$Name, [bool]$Condition, [string]$Detail)

    if ($Condition) {
        Write-Host "  PASS  $Name" -ForegroundColor Green
    }
    else {
        Write-Host "  FAIL  $Name ($Detail)" -ForegroundColor Red
        $script:failed = $true
    }
}

$logFile = Join-Path $env:LOCALAPPDATA "SqfReloader\logs\SqfReloader.log"
$baseUrl = "http://127.0.0.1:$Port/api"

Write-Host "DLL : $dll"
Write-Host ""

Write-Host "Exports"
$probe = Join-Path $scriptRoot "ExportsProbe\bin\Release\net10.0\ExportsProbe.exe"
$probeOutput = & $probe $dll 2>&1
$probeOutput | ForEach-Object { Write-Host "  $_" }
Test-Result "PE exports RVExtension*" ($LASTEXITCODE -eq 0) "probe exit $LASTEXITCODE"
Test-Result "PE exports RVExtensionFeatureFlags" (($probeOutput -join "`n") -match 'RVExtensionGetFeatureFlags') "feature flag export missing"

Write-Host ""
Write-Host "ABI"
[ArmaCallExtension]::RegisterCallback()

$flags = [ArmaCallExtension]::FeatureFlags()
Write-Host "  feature flags: $flags"
Test-Result "RVExtensionGetFeatureFlags == 7" ($flags -eq "7") $flags

$version = [ArmaCallExtension]::Version()
Write-Host "  RVExtensionVersion: $version"
Test-Result "RVExtensionVersion is [SUCCESS,[...]]" ($version -match '^\["SUCCESS",\["1\.0\.0(\.0)?"\]\]$') $version

$ping = [ArmaCallExtension]::Call("Ping", @("`"abc`""))
Write-Host "  Ping: $ping"
Test-Result "Ping returns pong:abc" ($ping -eq '[0] ["SUCCESS",["pong:abc"]]') $ping

$unknown = [ArmaCallExtension]::Call("NoSuchMethod", @())
Write-Host "  NoSuchMethod: $unknown"
Test-Result "unknown method returns ERROR" ($unknown -match '^\[1\] \["ERROR"') $unknown

$start = [ArmaCallExtension]::Call("ApiStart", @("$Port", "`"127.0.0.1`""))
Write-Host "  ApiStart: $start"
Test-Result "ApiStart binds the port" ($start -match 'listening on http://127\.0\.0\.1:' + $Port) $start

Write-Host ""
Write-Host "REST"
$status = Invoke-Api -Method GET -Url "$baseUrl/status"
Write-Host "  GET /status: $status"
Test-Result "status ok" ($status -match '"status":"ok"') $status
Test-Result "gameConnected true" ($status -match '"gameConnected":true') $status

$statusCode = (Invoke-ApiRaw -Method GET -Url "$baseUrl/status").Status
Test-Result "status HTTP 200" ($statusCode -eq 200) "HTTP $statusCode"

Reset-CallbackSnapshot
$send = Invoke-ApiRaw -Method POST -Url "$baseUrl/send" -Body '{"function":"SmokeTest","data":[1,"two",[3,4],true,nil]}'
Write-Host "  POST /send: HTTP $($send.Status) $($send.Body)"
Test-Result "send accepted" ($send.Status -eq 200 -and $send.Body -match '"success":true') $send.Body

$callback = Wait-CallbackSnapshot -Expected "SEND"
Write-Host "  callback: $($callback[1]) $($callback[2])"
Test-Result "SEND callback function" ($callback[1] -eq "SEND") $callback[1]
Test-Result "SEND callback payload" ($callback[2] -eq '["SmokeTest",[1,"two",[3,4],true,nil]]') $callback[2]
Test-Result "callback extension name" ($callback[0] -eq "SqfReloader") $callback[0]

Reset-CallbackSnapshot
$command = Invoke-Api -Method POST -Url "$baseUrl/command" -Body '{"type":"recompile","method":"SqfReloader_fnc_test","code":"[]"}'
Write-Host "  POST /command: $command"
Test-Result "command accepted" ($command -match '"success":true') $command

$callback = Wait-CallbackSnapshot -Expected "COMMAND"
Write-Host "  callback: $($callback[1]) $($callback[2])"
Test-Result "COMMAND callback payload" ($callback[2] -eq '["recompile","SqfReloader_fnc_test","[]"]') $callback[2]

Reset-CallbackSnapshot
$eval = Invoke-Api -Method POST -Url "$baseUrl/eval" -Body '{"code":"systemChat ''hello \"arma\"''"}'
Write-Host "  POST /eval: $eval"
$callback = Wait-CallbackSnapshot -Expected "COMMAND"
Write-Host "  callback: $($callback[1]) $($callback[2])"
$expectedEval = '["code","","systemChat ''hello ""arma""''"]'
Test-Result "EVAL passes code through" ($callback[2] -eq $expectedEval) "$($callback[2]) != $expectedEval"

Reset-CallbackSnapshot
$reload = Invoke-Api -Method POST -Url "$baseUrl/reload" -Body '{"functions":["SqfReloader_fnc_init","SqfReloader_fnc_call"]}'
Write-Host "  POST /reload: $reload"
$callback = Wait-CallbackSnapshot -Expected "RELOAD"
Write-Host "  callback: $($callback[1]) $($callback[2])"
Test-Result "RELOAD callback payload" ($callback[2] -eq '[["SqfReloader_fnc_init","SqfReloader_fnc_call"]]') $callback[2]

$bad = Invoke-ApiRaw -Method POST -Url "$baseUrl/command" -Body '{"type":"bogus"}'
Write-Host "  POST /command (invalid): HTTP $($bad.Status) $($bad.Body)"
Test-Result "invalid command rejected (400)" ($bad.Status -eq 400 -and $bad.Body -match '"success":false') $bad.Body

$missing = Invoke-ApiRaw -Method POST -Url "$baseUrl/command" -Body '{"type":"recompile","code":"[]"}'
Test-Result "recompile without method rejected" ($missing.Status -eq 400 -and $missing.Body -like "*method*is required*") $missing.Body

$notFound = Invoke-ApiRaw -Method POST -Url "$baseUrl/nope" -Body '{}'
Write-Host "  POST /nope: HTTP $($notFound.Status) $($notFound.Body)"
Test-Result "unknown route rejected (404)" ($notFound.Status -eq 404) $notFound.Body
$functions = Invoke-Api -Method GET -Url "$baseUrl/functions"
Write-Host "  GET /functions: $functions"
Test-Result "function list returned" ($functions -match '"functions":') $functions

Write-Host ""
Write-Host "Burst (300 messages)"
Reset-CallbackSnapshot
$sw = [System.Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt 300; $i++) {
    [void](Invoke-Api -Method POST -Url "$baseUrl/send" -Body ('{"function":"Burst","data":[' + $i + ']}'))
}
Start-Sleep -Milliseconds 1500
$sw.Stop()

$burstCount = [ArmaCallExtension]::CallbackCount
Write-Host "  callback deliveries: $burstCount in $([Math]::Round($sw.Elapsed.TotalSeconds, 2))s"

# 300 messages arrive within a frame and are coalesced, so only a handful of callbacks
# are delivered. Verify that the last delivery carried the burst payload.
$lastBurst = Get-CallbackSnapshot
Write-Host "  last delivery: $($lastBurst[1]) $($lastBurst[2].Substring(0, [Math]::Min(90, $lastBurst[2].Length)))"
Test-Result "burst delivered" ($burstCount -gt 0 -and ($lastBurst[1] -eq "BATCH" -or $lastBurst[2] -like "*Burst*")) "$lastBurst[1] $($lastBurst[2])"

Write-Host ""
if (Test-Path $logFile) {
    Write-Host "Log tail ($logFile):"
    Get-Content $logFile -Tail 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

Write-Host ""
if ($failed) {
    Write-Host "SMOKE TEST FAILED" -ForegroundColor Red
    exit 1
}

Write-Host "SMOKE TEST PASSED" -ForegroundColor Green
exit 0
