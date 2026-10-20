<#
.SYNOPSIS
    Builds the ArmaApi extension DLL and the @ArmaApi mod folder (no installation).

.DESCRIPTION
    Produces
      dist\@ArmaApi\addons\armaapi.pbo   packed mod content (Arma 3 Tools AddonBuilder)
      dist\@ArmaApi\dll\ArmaApi_x64.dll  extension to copy next to arma3_x64.exe
      dist\@ArmaApi\source\...           plain SQF sources used for hot reloads

    Every build bumps the version by default: the project, the VS Code extension (package.json)
    and CfgPatches in config.cpp all get the same new number.

.PARAMETER Release
    Also create dist\ArmaApi-Setup.zip (installer scripts + built files).

.PARAMETER NoPbo
    Skip packing (useful while iterating on SQF; Arma can load the loose folder).

.PARAMETER AddonBuilder
    Path to AddonBuilder.exe. Detected from the Arma 3 Tools install when omitted.

.PARAMETER Key
    .biprivatekey used with -sign (defaults to addons\armaapi\ArmaApi.biprivatekey).

.PARAMETER NoVersionBump
    Keep the current version (release builds / re-runs of the same version).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File tools\build.ps1
#>

[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$NoPbo,
    [switch]$Clean,
    [string]$AddonBuilder = "",
    [string]$Key = "",
    [switch]$NoVersionBump
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Common.ps1")

if ($NoVersionBump) {
    $version = Get-ProjectVersion
}
else {
    $current = $null

    if ((Get-VscodeVersion) -match '^(\d+)\.(\d+)\.(\d+)$') {
        $current = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
    }
    elseif ((Get-ProjectVersion) -match '^(\d+)\.(\d+)\.(\d+)') {
        $current = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
    }

    if ($current) {
        $version = "$($current[0]).$($current[1]).$($current[2] + 1)"
    }
    else {
        $version = "1.0.0"
    }

    Update-ComponentVersions -Version $version -UpdateDll -UpdateConfig
}

Write-Step "ArmaApi $version"

# Fail before the DLL build when AddonBuilder is missing.
if (!$NoPbo) {
    $builderPath = if ($AddonBuilder) { (Resolve-Path $AddonBuilder).Path } else { Find-AddonBuilder }
    if (!$builderPath) {
        throw 'AddonBuilder.exe was not found. Install "Arma 3 Tools" from Steam (Tools) and run again, or pass -AddonBuilder <path> (or -NoPbo).'
    }
    Write-Ok "AddonBuilder: $builderPath"
}

Write-Step "Checking SQF sources"
$sqfCheck = & (Join-Path $PSScriptRoot "check-sqf.ps1") -Path $script:AddonSource 2>&1
if ($LASTEXITCODE -ne 0) {
    $sqfCheck | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    throw "SQF check failed."
}
$sqfCheck | ForEach-Object { Write-Ok "$_" }

$dll = Invoke-DllBuild -Clean:$Clean
New-ModPackage -DllPath $dll -SkipPbo:$NoPbo -AddonBuilder $AddonBuilder -KeyPath (Get-ArmaApiPublicKeyPath -Override $Key)

if ($Release) {
    Write-Step "Creating dist\ArmaApi-Setup.zip"

    $stage = Join-Path $script:DistDir "setup"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    # Join-Path silently returns "" when its base folder is missing, which would try to
    # copy files into the project root, so the layout is created up front.
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    Copy-Item (Join-Path $script:RepoRoot "ArmaApiExtension.csproj") $stage
    Copy-Item (Join-Path $script:RepoRoot "exports.c") $stage
    Copy-Item (Join-Path $script:RepoRoot "linker.xml") $stage
    Copy-Item (Join-Path $script:RepoRoot "global.json") $stage
    Copy-Item (Join-Path $script:RepoRoot "README.md") $stage
    Copy-Item (Join-Path $script:RepoRoot "src") $stage -Recurse
    Copy-Item (Join-Path $script:RepoRoot "addons") $stage -Recurse

    $stageTools = Join-Path $stage "tools"
    New-Item -ItemType Directory -Force -Path $stageTools | Out-Null
    Copy-Item (Join-Path $script:RepoRoot "tools\*") $stageTools -Recurse

    # The harness script is needed by tools\test-extension.ps1; the downloaded binary is not shipped.
    $stageTests = Join-Path $stage "tests\callExtension"
    New-Item -ItemType Directory -Force -Path $stageTests | Out-Null
    Copy-Item (Join-Path $script:RepoRoot "tests\callExtension\armaapi_test.sqf") $stageTests

    $stageDist = Join-Path $stage "dist"
    New-Item -ItemType Directory -Force -Path $stageDist | Out-Null
    Copy-Item $script:ModFolder (Join-Path $stageDist "@ArmaApi") -Recurse

    # Do not ship build output of the packer inside the zip.
    Get-ChildItem $stageTools -Recurse -Directory -Filter "bin" | Remove-Item -Recurse -Force
    Get-ChildItem $stageTools -Recurse -Directory -Filter "obj" | Remove-Item -Recurse -Force

    $zip = Join-Path $script:DistDir "ArmaApi-Setup.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

    Remove-Item $stage -Recurse -Force

    Write-Ok "Package: $zip ($([Math]::Round((Get-Item $zip).Length / 1MB, 2)) MB)"
    Write-Ok "Ship the zip; the user runs tools\install.ps1 -NoBuild from it."
}

Write-Step "Build finished"
Write-Host "  Mod   : $script:ModFolder" -ForegroundColor Gray
Write-Host "  DLL   : $(Join-Path $script:ModFolder "dll\$($script:DllName)")" -ForegroundColor Gray
Write-Host "  Install: powershell -ExecutionPolicy Bypass -File tools\install.ps1" -ForegroundColor Gray
