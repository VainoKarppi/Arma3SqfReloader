<#
.SYNOPSIS
    Automatic installer for the SqfReloader Arma 3 extension and mod.

.DESCRIPTION
    One command does everything:
      1. builds SqfReloader_x64.dll (NativeAOT) unless -NoBuild is given
      2. packs the @SqfReloader mod folder (PBO + sources + DLL)
      3. copies the DLL next to arma3_x64.exe / arma3server_x64.exe
      4. installs @SqfReloader into the mods directory
      5. writes %LOCALAPPDATA%\SqfReloader\config.json (REST host/port)
      6. adds -mod="@SqfReloader" to the Steam launch options (unless -SkipLaunchOptions)

.PARAMETER ArmaDir
    Arma 3 installation folder. Detected from the registry / Steam libraries if omitted.

.PARAMETER ModsDir
    Folder that receives @SqfReloader. Defaults to the Arma 3 folder.

.PARAMETER Port
    REST API port written to the config (default 8764).

.PARAMETER HostName
    REST API bind address (default 127.0.0.1).

.PARAMETER SkipLaunchOptions
    Do not touch the Steam launch options.

.PARAMETER NoBuild
    Install the already built dist\@SqfReloader instead of rebuilding.

.PARAMETER Release
    Also create dist\SqfReloader-Setup.zip.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ArmaDir "D:\SteamLibrary\steamapps\common\Arma 3" -Port 8764
#>

[CmdletBinding()]
param(
    [string]$ArmaDir,
    [string]$ModsDir,
    [int]$Port = 8764,
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
    Write-Step "SqfReloader installer $((Get-ProjectVersion))"

    $armaDirectory = Get-ArmaDirectory -Path $ArmaDir
    Write-Ok "Arma 3: $armaDirectory"

    if (!$ModsDir) { $ModsDir = $armaDirectory }
    New-Item -ItemType Directory -Force -Path $ModsDir | Out-Null

    if ($NoBuild) {
        Write-Step "Using existing build in dist"
        if (!(Test-Path $script:ModFolder)) { throw "dist\@SqfReloader not found. Run without -NoBuild first." }
    }
    else {
        $buildArgs = @("-File", (Join-Path $PSScriptRoot "build.ps1"))
        if ($AddonBuilder) { $buildArgs += @("-AddonBuilder", $AddonBuilder) }
        if ($NoVersionBump) { $buildArgs += "-NoVersionBump" }

        & powershell -NoProfile -ExecutionPolicy Bypass @buildArgs
        if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed with exit code $LASTEXITCODE." }
    }

    $builtDll = Join-Path $script:ModFolder $script:DllName
    if (!(Test-Path $builtDll)) { throw "$($script:DllName) was not found inside $script:ModFolder." }

    # The DLL sits in the mod ROOT: Arma resolves extensions from the executable folder or the
    # mod root, never from a dll\ subfolder.
    Write-Step "Installing mod"

    $targetMod = Join-Path $ModsDir "@$($script:ModName)"

    if (Test-Path $targetMod) {
        Write-Warn "Removing previous installation: $targetMod"
        Remove-Item $targetMod -Recurse -Force
    }

    Copy-Item $script:ModFolder $targetMod -Recurse -Force
    Write-Ok "Mod: $targetMod ($($script:DllName), addons\$($script:AddonName).pbo)"

    # Remove files the old installer used to leave in the game folder.
    foreach ($legacy in @("$($script:DllName)", "SqfReloader")) {
        $path = Join-Path $armaDirectory $legacy
        if (Test-Path $path) {
            Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
            Write-Ok "Removed legacy $path"
        }
    }

    # Keys folder keeps signature-aware servers happy; the mod is unsigned.
    $keys = Join-Path $targetMod "keys"
    if (!(Test-Path $keys)) { New-Item -ItemType Directory -Force -Path $keys | Out-Null }

    Write-Step "Writing REST API config"
    Write-ApiConfig -Port $Port -HostName $HostName

    if (!$SkipLaunchOptions) {
        Write-Step "Adding Steam launch option"
        Add-SteamLaunchOption -ModFolder $targetMod | Out-Null
    }

    if ($Release) {
        Write-Step "Creating dist\SqfReloader-Setup.zip"
        & (Join-Path $PSScriptRoot "build.ps1") -Release -NoVersionBump | Out-Null
    }

    Write-Step "Installation finished"
    Write-Host "  1. Start Arma 3 (Eden Editor) with @SqfReloader enabled." -ForegroundColor Gray
    Write-Host "  2. In the editor: Tools > SqfReloader: Status" -ForegroundColor Gray
    Write-Host "  3. API: http://$($HostName):$Port/api/status" -ForegroundColor Gray
    Write-Host "  Log: $(Join-Path $env:LOCALAPPDATA 'SqfReloader\logs\SqfReloader.log')" -ForegroundColor Gray
    exit 0
}
catch {
    Write-Fail $_.Exception.Message
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
    exit 1
}
