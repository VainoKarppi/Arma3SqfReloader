<#
.SYNOPSIS
    Removes the SqfReloader mod, the deployed extension DLL and the Steam launch option.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1
#>

[CmdletBinding()]
param(
    [string]$ArmaDir,
    [switch]$KeepConfig
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")

try {
    $armaDirectory = Get-ArmaDirectory -Path $ArmaDir
    $targetMod = Join-Path $armaDirectory "@$($script:ModName)"

    Write-Step "Removing launch option"
    Remove-SteamLaunchOption -ModFolder $targetMod

    Write-Step "Removing deployed DLL"
    foreach ($exe in @("arma3_x64.exe", "arma3server_x64.exe")) {
        $dll = Join-Path $armaDirectory $script:DllName
        if ((Test-Path (Join-Path $armaDirectory $exe)) -and (Test-Path $dll)) {
            Remove-Item $dll -Force
            Write-Ok "Removed $dll"
        }
    }

    Write-Step "Removing mod"
    if (Test-Path $targetMod) {
        Remove-Item $targetMod -Recurse -Force
        Write-Ok "Removed $targetMod"
    }
    else {
        Write-Warn "Mod folder not found: $targetMod"
    }

    if (!$KeepConfig) {
        $configDir = Join-Path $env:LOCALAPPDATA "SqfReloader"
        if (Test-Path $configDir) {
            Remove-Item $configDir -Recurse -Force
            Write-Ok "Removed $configDir"
        }
    }

    Write-Step "Uninstall finished"
    exit 0
}
catch {
    Write-Fail $_.Exception.Message
    exit 1
}
