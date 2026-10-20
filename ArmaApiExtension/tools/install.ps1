<#
.SYNOPSIS
    Automatic installer for the ArmaApi Arma 3 extension and mod.

.DESCRIPTION
    One command does everything:
      1. builds ArmaApi_x64.dll (NativeAOT) unless -NoBuild is given
      2. packs the @ArmaApi mod folder (PBO + sources + DLL)
      3. copies the DLL next to arma3_x64.exe / arma3server_x64.exe
      4. installs @ArmaApi into the mods directory
      5. writes %LOCALAPPDATA%\ArmaApi\config.json (REST host/port)
      6. adds -mod="@ArmaApi" to the Steam launch options (unless -SkipLaunchOptions)

.PARAMETER ArmaDir
    Arma 3 installation folder. Detected from the registry / Steam libraries if omitted.

.PARAMETER ModsDir
    Folder that receives @ArmaApi. Defaults to the Arma 3 folder.

.PARAMETER Port
    REST API port written to the config (default 8765).

.PARAMETER HostName
    REST API bind address (default 127.0.0.1).

.PARAMETER SkipLaunchOptions
    Do not touch the Steam launch options.

.PARAMETER NoBuild
    Install the already built dist\@ArmaApi instead of rebuilding.

.PARAMETER Release
    Also create dist\ArmaApi-Setup.zip.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ArmaDir "D:\SteamLibrary\steamapps\common\Arma 3" -Port 8765
#>

[CmdletBinding()]
param(
    [string]$ArmaDir,
    [string]$ModsDir,
    [int]$Port = 8765,
    [string]$HostName = "127.0.0.1",
    [switch]$SkipLaunchOptions,
    [switch]$NoBuild,
    [switch]$Release,
    [string]$AddonBuilder = "",
    [switch]$NoVersionBump
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")

try {
    Write-Step "ArmaApi installer $((Get-ProjectVersion))"

    $armaDirectory = Get-ArmaDirectory -Path $ArmaDir
    Write-Ok "Arma 3: $armaDirectory"

    if (!$ModsDir) { $ModsDir = $armaDirectory }
    New-Item -ItemType Directory -Force -Path $ModsDir | Out-Null

    if ($NoBuild) {
        Write-Step "Using existing build in dist"
        if (!(Test-Path $script:ModFolder)) { throw "dist\@ArmaApi not found. Run without -NoBuild first." }
    }
    else {
        $buildArgs = @("-File", (Join-Path $PSScriptRoot "build.ps1"))
        if ($AddonBuilder) { $buildArgs += @("-AddonBuilder", $AddonBuilder) }
        if ($NoVersionBump) { $buildArgs += "-NoVersionBump" }

        & powershell -NoProfile -ExecutionPolicy Bypass @buildArgs
        if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed with exit code $LASTEXITCODE." }
    }

    $builtDll = Join-Path $script:ModFolder "dll\$($script:DllName)"
    if (!(Test-Path $builtDll)) {
        # -NoBuild on a shipped zip: the DLL may sit next to the addons instead.
        $builtDll = Join-Path $script:ModFolder "addons\$($script:DllName)"
    }
    if (!(Test-Path $builtDll)) { throw "ArmaApi_x64.dll was not found inside $script:ModFolder." }

    Write-Step "Installing DLL"
    $count = Install-DllToArma -ArmaDir $armaDirectory -DllPath $builtDll
    if ($count -eq 0) { throw "arma3_x64.exe was not found in $armaDirectory." }

    Write-Step "Installing mod"
    $targetMod = Join-Path $ModsDir "@$($script:ModName)"

    if (Test-Path $targetMod) {
        Write-Warn "Removing previous installation: $targetMod"
        Remove-Item $targetMod -Recurse -Force
    }

    Copy-Item $script:ModFolder $targetMod -Recurse -Force
    Write-Ok "Mod: $targetMod"

    # Keys folder keeps signature-aware servers happy; the mod is unsigned.
    $keys = Join-Path $targetMod "keys"
    if (!(Test-Path $keys)) { New-Item -ItemType Directory -Force -Path $keys | Out-Null }

    Write-Step "Writing REST API config"
    Write-ApiConfig -Port $Port -HostName $HostName -SourceDirectory (Join-Path $targetMod "source")

    if (!$SkipLaunchOptions) {
        Write-Step "Adding Steam launch option"
        Add-SteamLaunchOption -ModFolder $targetMod | Out-Null
    }

    if ($Release) {
        Write-Step "Creating dist\ArmaApi-Setup.zip"
        & (Join-Path $PSScriptRoot "build.ps1") -Release -NoVersionBump | Out-Null
    }

    Write-Step "Installation finished"
    Write-Host "  1. Start Arma 3 (Eden Editor) with @ArmaApi enabled." -ForegroundColor Gray
    Write-Host "  2. In the editor: Tools > Arma API: Status" -ForegroundColor Gray
    Write-Host "  3. API: http://$($HostName):$Port/api/status" -ForegroundColor Gray
    Write-Host "  Log: $(Join-Path $env:LOCALAPPDATA 'ArmaApi\logs\ArmaApi.log')" -ForegroundColor Gray
    exit 0
}
catch {
    Write-Fail $_.Exception.Message
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
    exit 1
}
