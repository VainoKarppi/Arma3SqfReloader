# Unpacks the killzonekid callExtension harness (callExtension_v2.0.zip) into
# tests\callExtension so tools\test-extension.ps1 can drive ArmaApi_x64.dll the same way
# Arma 3 does - no game required.
#
# The harness loads a DLL with LoadLibraryExA, resolves RVExtensionVersion /
# RVExtension / RVExtensionArgs / RVExtensionRegisterCallback, runs the SQF lines of a
# script and prints every ExtensionCallback it receives.
#
# Usage: powershell -ExecutionPolicy Bypass -File tools\install-call-extension.ps1 [-Force]

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$target = Join-Path $PSScriptRoot "..\tests\callExtension"
$target = (New-Item -ItemType Directory -Force -Path $target).FullName
$exe = Join-Path $target "callExtension_x64.exe"

if ((Test-Path $exe) -and !$Force) {
    Write-Host "callExtension harness already installed: $exe" -ForegroundColor Green
    exit 0
}

Write-Host "Downloading callExtension_v2.0.zip ..." -ForegroundColor Cyan

$zipUrl = "http://killzonekid.com/pub/callExtension_v2.0.zip"
$zipPath = Join-Path $env:TEMP "callExtension_v2.0.zip"
$extractPath = Join-Path $env:TEMP "callExtension_v2.0_extract"

Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

$source = Join-Path $extractPath "callExtension"
if (!(Test-Path (Join-Path $source "callExtension_x64.exe"))) {
    throw "Unexpected archive layout: callExtension_x64.exe not found in $source"
}

# Copy the whole harness folder: the x64 binary plus the readme/samples it ships with.
Copy-Item (Join-Path $source "*") $target -Recurse -Force

Remove-Item $zipPath -Force
Remove-Item $extractPath -Recurse -Force

Write-Host "Harness installed: $exe" -ForegroundColor Green
Write-Host "Note: the harness is free software published by killzonekid (callExtension v2.0)." -ForegroundColor DarkGray
exit 0
