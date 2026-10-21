<#
.SYNOPSIS
    Drives SqfReloader_x64.dll the way Arma 3 does, using the killzonekid callExtension harness.

.DESCRIPTION
    EdenOnline tests its extension with Tools\TestExtension.ps1: it downloads the
    callExtension harness (callExtension_v2.0.zip), copies a .sqf script that calls the
    extension, and runs the harness against it. The harness loads the DLL with
    LoadLibraryExA, resolves RVExtensionVersion / RVExtension / RVExtensionArgs /
    RVExtensionRegisterCallback and prints every message the extension sends back.

    This tool does the same for SqfReloader:

      1. installs the harness (tools\install-call-extension.ps1) when missing,
      2. publishes the extension (unless -NoBuild) and copies it next to the harness,
      3. runs a test script that calls the extension and starts the REST API,
      4. checks the harness output for every expected answer,
      5. while the harness is still alive, checks the REST API it just started.

    This validates the Arma -> extension direction (callExtension, return buffers,
    arguments, callbacks) without starting the game.

.PARAMETER TestScript
    SQF script for the harness. Default: tests\callExtension\sqfreloader_test.sqf

.PARAMETER KeepRunning
    Leave the harness process running after the checks (the REST API stays reachable).

.PARAMETER NoBuild
    Use the already published DLL (dist\@SqfReloader\SqfReloader_x64.dll).

.PARAMETER Reinstall
    Re-download the harness even when it is already installed.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\test-extension.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\test-extension.ps1 -KeepRunning
#>

[CmdletBinding()]
param(
    [string]$TestScript = "",
    [switch]$KeepRunning,
    [switch]$NoBuild,
    [switch]$Reinstall,
    [int]$Port = 8764
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")

$harnessDir = (New-Item -ItemType Directory -Force -Path (Join-Path $script:RepoRoot "tests\callExtension")).FullName
$harnessExe = Join-Path $harnessDir "callExtension_x64.exe"
$scriptFile = if ($TestScript) { (Resolve-Path $TestScript).Path } else { Join-Path $harnessDir "sqfreloader_test.sqf" }
$logFile = Join-Path $env:LOCALAPPDATA "SqfReloader\logs\SqfReloader.log"

$failures = New-Object System.Collections.Generic.List[string]
$checks = 0

function Assert-Output {
    param([string]$Name, [string]$Pattern, [string]$Output)

    $script:checks++
    if ($Output -match $Pattern) {
        Write-Host "  PASS  $Name" -ForegroundColor Green
        return $true
    }

    Write-Host "  FAIL  $Name (no match for '$Pattern')" -ForegroundColor Red
    $script:failures.Add($Name)
    return $false
}

function Invoke-ApiRaw {
    param([string]$Method, [string]$Url, [string]$Body)

    try {
        if ($Method -eq "GET") {
            $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 3 -UseBasicParsing
        }
        else {
            $response = Invoke-WebRequest -Uri $Url -Method Post -Body $Body -ContentType "application/json" -TimeoutSec 3 -UseBasicParsing
        }

        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = [string]$response.Content }
    }
    catch {
        $status = 0

        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $status = [int]$_.Exception.Response.StatusCode
        }

        return [pscustomobject]@{ Status = $status; Body = "" }
    }
}

try {
    Write-Step "SqfReloader extension test (callExtension harness)"

    # --- 1. Harness -------------------------------------------------------
    if ($Reinstall -or !(Test-Path $harnessExe)) {
        & (Join-Path $PSScriptRoot "install-call-extension.ps1") -Force:$Reinstall
        if ($LASTEXITCODE -ne 0 -or !(Test-Path $harnessExe)) { throw "callExtension harness is not available." }
    }
    else {
        Write-Ok "Harness: $harnessExe"
    }

    # --- 2. DLL -----------------------------------------------------------
    # Stop any harness left over from a previous run first: it keeps SqfReloader_x64.dll
    # loaded, which makes the copy below fail.
    Get-Process -Name "callExtension_x64" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Warn "Stopping previous harness instance (PID $($_.Id))"
        Stop-Process -Id $_.Id -Force
    }

    Start-Sleep -Milliseconds 300

    if ($NoBuild) {
        Write-Step "Using existing build"
    }
    else {
        $dll = Invoke-DllBuild
        New-ModPackage -DllPath $dll -NoPbo
    }

    $dll = Join-Path $script:ModFolder $script:DllName
    if (!(Test-Path $dll)) { throw "DLL not found: $dll" }

    # The harness resolves the extension by file name, so it has to sit in its own folder.
    Copy-Item $dll $harnessDir -Force
    Write-Ok "DLL: $(Join-Path $harnessDir $script:DllName)"

    if (!(Test-Path $scriptFile)) { throw "Test script not found: $scriptFile" }
    Write-Ok "Script: $scriptFile"

    # A stale harness instance would answer the REST checks with an old DLL, and its
    # port would block the one the new SQF script starts.
    $running = Get-Process -Name "callExtension_x64" -ErrorAction SilentlyContinue
    foreach ($stale in $running) {
        Write-Warn "Stopping previous harness instance (PID $($stale.Id))"
        Stop-Process -Id $stale.Id -Force
    }

    # --- 3. Run -----------------------------------------------------------
    Write-Step "Running the harness"
    Write-Host "    (the extension log is written to $logFile)" -ForegroundColor DarkGray

    Push-Location $harnessDir
    try {
        $stdoutPath = Join-Path $harnessDir "stdout.txt"
        $stderrPath = Join-Path $harnessDir "stderr.txt"
        $runnerPath = Join-Path $harnessDir "run-harness.cmd"
        $apiStatusUrl = "http://127.0.0.1:$Port/api/status"
        $apiSendUrl = "http://127.0.0.1:$Port/api/send"

        # The harness only exits once its standard input is closed, so it is started from
        # cmd with "< nul" (same trick as running it by hand). A plain Start-Process with
        # redirected output keeps stdin as an interactive console handle.
        $lines = @(
            "@echo off",
            "cd /d `"$harnessDir`"",
            "`"$(Join-Path $harnessDir "callExtension_x64.exe")`" `"$scriptFile`" < nul > `"$stdoutPath`" 2> `"$stderrPath`"",
            "exit /b %ERRORLEVEL%"
        )
        Set-Content -Path $runnerPath -Value $lines -Encoding ASCII

        $process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$runnerPath`"" -PassThru -WindowStyle Hidden

        # Poll for the API the script starts (it comes up after roughly five seconds of
        # harness sleeps) instead of guessing a fixed delay, then check it while the
        # harness is alive. The harness only exits when its stdin closes, so it is read
        # until the end of the script and then terminated.
        $restAvailable = $false
        $status = $null
        $send = $null

        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($process.HasExited) { break }

            $candidate = Invoke-ApiRaw -Method GET -Url $apiStatusUrl
            if ($candidate.Status -eq 200) {
                $status = $candidate
                $restAvailable = $true
                break
            }

            Start-Sleep -Milliseconds 200
        }

        if ($restAvailable) {
            $send = Invoke-ApiRaw -Method POST -Url $apiSendUrl -Body '{"function":"Harness","data":[1,"two"]}'
            Start-Sleep -Milliseconds 800
        }

        # Give the script time to reach its final "freeExtension" line, then stop the harness.
        $process.WaitForExit(8000) | Out-Null
        if (!$process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit(5000) | Out-Null
        }

        Get-Process -Name "callExtension_x64" -ErrorAction SilentlyContinue | ForEach-Object {
            Stop-Process -Id $_.Id -Force
        }

        Start-Sleep -Milliseconds 300
    }
    finally {
        Pop-Location
    }

    $stdout = Get-Content (Join-Path $harnessDir "stdout.txt") -Raw -ErrorAction SilentlyContinue
    $stderr = Get-Content (Join-Path $harnessDir "stderr.txt") -Raw -ErrorAction SilentlyContinue

    Write-Step "Harness output"
    if ($stdout) { ($stdout.TrimEnd()) -split "`r?`n" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    if ($stderr) { Write-Host "    stderr:" -ForegroundColor Yellow; ($stderr.TrimEnd()) -split "`r?`n" | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow } }

    # --- 4. Checks --------------------------------------------------------
    Write-Step "Checks"

    Assert-Output "harness loaded SqfReloader_x64.dll" 'CallExtension loaded: sqfreloader \(sqfreloader_x64\.dll\)' $stdout | Out-Null
    Assert-Output "callback registered" 'Callback registered:' $stdout | Out-Null
    # The version is a 4-part build stamp (e.g. 2.0.11.0), so only the envelope is matched.
    Assert-Output "Version() answers SUCCESS" '"SUCCESS",\["\d+\.\d+\.\d+' $stdout | Out-Null
    Assert-Output "Ping() receives its argument" 'pong:harness' $stdout | Out-Null
    Assert-Output "unknown method answers ERROR" 'Method ''NoSuchMethod'' not found' $stdout | Out-Null
    Assert-Output "unknown method returns exit code 1" ([regex]::Escape('not found.""]]",1,0]')) $stdout | Out-Null
    Assert-Output "REST API started from SQF" 'REST API listening on http://127\.0\.0\.1:' $stdout | Out-Null
    Assert-Output "ApiPort() returns the port" $Port $stdout | Out-Null
    Assert-Output "Reload queues a callback" 'ExtensionCallback:.*RELOAD' $stdout | Out-Null

    if ($stderr -match 'Unhandled exception') {
        $checks++
        Write-Host "  FAIL  extension did not crash" -ForegroundColor Red
        $failures.Add("extension crash")
    }
    else {
        $checks++
        Write-Host "  PASS  extension did not crash" -ForegroundColor Green
    }

    # REST round trip against the API the SQF script started.
    if ($restAvailable) {
        Assert-Output "REST /api/status" '"status":"ok"' $status.Body | Out-Null
        Assert-Output "REST reports a live game callback" '"gameConnected":true' $status.Body | Out-Null
        Assert-Output "REST /api/send accepted" '"success":true' $send.Body | Out-Null
        Assert-Output "REST /api/send reached the callback" 'ExtensionCallback:.*SEND' $stdout | Out-Null
    }
    else {
        $checks++
        Write-Host "  FAIL  REST API reachable on port $Port" -ForegroundColor Red
        $failures.Add("REST API reachable")
    }

    Write-Host ""
    if ($failures.Count -gt 0) {
        Write-Host "CALL EXTENSION TEST FAILED ($($failures.Count)/$checks failed)" -ForegroundColor Red
        exit 1
    }

    Write-Host "CALL EXTENSION TEST PASSED ($checks checks)" -ForegroundColor Green
    exit 0
}
catch {
    Write-Fail $_.Exception.Message
    exit 1
}
