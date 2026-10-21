<#
.SYNOPSIS
    Builds the SqfReloader extension DLL and the @SqfReloader mod folder (no installation).

.DESCRIPTION
    Sources are laid out like the shipped mod (SqfReloaderExtension\@SqfReloader), and the
    build produces the same tree in dist:
      dist\@SqfReloader\mod.cpp
      dist\@SqfReloader\logo.paa                 (mod.cpp declares logo = "logo.paa")
      dist\@SqfReloader\addons\scripts.pbo       packed addon (prefix "scripts")
      dist\@SqfReloader\SqfReloader_x64.dll      native extension, in the MOD ROOT

    Every build bumps the version by default: the project, the VS Code extension (package.json)
    and CfgPatches in config.cpp all get the same new number.

.PARAMETER Release
    Also create dist\SqfReloader-Setup.zip (installer scripts + built files).

.PARAMETER NoPbo
    Only ship the unpacked addon folder (skip packing scripts.pbo).

.PARAMETER AddonBuilder
    Path to AddonBuilder.exe. Detected from the Arma 3 Tools install when omitted.

.PARAMETER Key
    .biprivatekey used with -sign (defaults to @SqfReloader\addons\scripts\SqfReloader.biprivatekey).

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

Write-Step "SqfReloader $version"

# Fail before the DLL build when AddonBuilder is missing.
if (!$NoPbo) {
    $builderPath = if ($AddonBuilder) { (Resolve-Path $AddonBuilder).Path } else { Find-AddonBuilder }
    if (!$builderPath) {
        throw 'AddonBuilder.exe was not found. Install "Arma 3 Tools" from Steam (Tools) and run again, pass -AddonBuilder <path>, or use -NoPbo.'
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
New-ModPackage -DllPath $dll -NoPbo:$NoPbo -AddonBuilder $AddonBuilder -KeyPath (Get-SqfReloaderPublicKeyPath -Override $Key)

if ($Release) {
    Write-Step "Creating dist\SqfReloader-Setup.zip"

    $stage = Join-Path $script:DistDir "setup"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    # Join-Path silently returns "" when its base folder is missing, which would try to
    # copy files into the project root, so the layout is created up front.
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    Copy-Item (Join-Path $script:RepoRoot "SqfReloaderExtension.csproj") $stage
    Copy-Item (Join-Path $script:RepoRoot "exports.c") $stage
    Copy-Item (Join-Path $script:RepoRoot "linker.xml") $stage
    Copy-Item (Join-Path $script:RepoRoot "global.json") $stage
    Copy-Item (Join-Path $script:RepoRoot "README.md") $stage
    Copy-Item (Join-Path $script:RepoRoot "src") $stage -Recurse
    Copy-Item $script:ModSource $stage -Recurse

    $stageTools = Join-Path $stage "tools"
    New-Item -ItemType Directory -Force -Path $stageTools | Out-Null
    Copy-Item (Join-Path $script:RepoRoot "tools\*") $stageTools -Recurse

    # The harness script is needed by tools\test-extension.ps1; the downloaded binary is not shipped.
    $stageTests = Join-Path $stage "tests\callExtension"
    New-Item -ItemType Directory -Force -Path $stageTests | Out-Null
    Copy-Item (Join-Path $script:RepoRoot "tests\callExtension\sqfreloader_test.sqf") $stageTests

    $stageDist = Join-Path $stage "dist"
    New-Item -ItemType Directory -Force -Path $stageDist | Out-Null
    Copy-Item $script:ModFolder (Join-Path $stageDist "@SqfReloader") -Recurse

    # Do not ship build output of the packer inside the zip.
    Get-ChildItem $stageTools -Recurse -Directory -Filter "bin" | Remove-Item -Recurse -Force
    Get-ChildItem $stageTools -Recurse -Directory -Filter "obj" | Remove-Item -Recurse -Force

    $zip = Join-Path $script:DistDir "SqfReloader-Setup.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal

    Remove-Item $stage -Recurse -Force

    Write-Ok "Package: $zip ($([Math]::Round((Get-Item $zip).Length / 1MB, 2)) MB)"
    Write-Ok "Ship the zip; the user runs tools\install.ps1 -NoBuild from it."
}

Write-Step "Build finished"
Write-Host "  Mod   : $script:ModFolder" -ForegroundColor Gray
Write-Host "  DLL   : $(Join-Path $script:ModFolder $script:DllName)" -ForegroundColor Gray
Write-Host "  Install: powershell -ExecutionPolicy Bypass -File tools\install.ps1" -ForegroundColor Gray
