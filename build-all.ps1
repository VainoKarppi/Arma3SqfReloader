<#
.SYNOPSIS
    Builds everything: the SqfReloader extension, the @SqfReloader mod, the editable junction sources
    and the VS Code extension (.vsix). Optionally installs both into Arma 3 / VS Code.

.DESCRIPTION
    1. NativeAOT SqfReloader_x64.dll            (SqfReloaderExtension/tools/build.ps1)
    2. @SqfReloader mod (PBO via AddonBuilder)  (dist/@SqfReloader, dist/SqfReloader-Setup.zip)
    3. Runtime bundle for the VSIX          (vscode-runtime/SqfReloader_x64.dll + @SqfReloader)
    4. VS Code extension                    (npm install, tsc, vsce package -> *.vsix)

    Every build increases the version of both components by one patch level
    (project + CfgPatches and package.json/package-lock.json), so two VSIX files never share
    a version number. Use -Version to build an exact version instead (the .vsix is replaced).

.PARAMETER Version
    Build this exact version, e.g. -Version "2.3.0". Writes it to SqfReloaderExtension.csproj,
    src\BuildStamp.cs, CfgPatches in config.cpp and package.json/package-lock.json, then builds
    without the automatic patch bump. Must be three parts (major.minor.patch).

    Without -Version the current version is rebuilt: every version file keeps its number and
    the existing .vsix of that version is replaced.

.PARAMETER Install
    Install the .vsix into VS Code and set up Arma 3 (equivalent to -InstallVsCode -InstallArma).

.PARAMETER InstallVsCode
    code --install-extension <vsix> (replaces a previous install).

.PARAMETER InstallArma
    Runs SqfReloaderExtension/tools/install.ps1 (installs @SqfReloader + the API config).

.PARAMETER ArmaDir
    Arma 3 folder for -InstallArma. Auto-detected when omitted.

.PARAMETER AddonBuilder
    Path to Arma 3 Tools AddonBuilder.exe (auto-detected when omitted).

.PARAMETER SkipVsce
    Only compile the TypeScript (useful when vsce is not installed).

.PARAMETER Clean
    Rebuild the DLL from scratch and delete the previous .vsix files.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build-all.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build-all.ps1 -Version "2.3.0" -Install

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build-all.ps1 -Install -ArmaDir "D:\SteamLibrary\steamapps\common\Arma 3"
#>

[CmdletBinding()]
param(
    [string]$Version = "",
    [switch]$Install,
    [switch]$InstallVsCode,
    [switch]$InstallArma,
    [string]$ArmaDir = "",
    [string]$AddonBuilder = "",
    [switch]$SkipVsce,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

# Captured before Common.ps1 is dot-sourced: it defines its own $repoRoot/$PSScriptRoot for the
# extension folder, so a distinct name is used for this script's root.
$solutionRoot = $PSScriptRoot
$extensionDir = Join-Path $solutionRoot "SqfReloaderExtension"
$modSource = Join-Path $extensionDir "@SqfReloader"
$addonName = "scripts"
$modName = "SqfReloader"
$dllName = "SqfReloader_x64.dll"
$npm = if ($env:OS -eq "Windows_NT") { "npm.cmd" } else { "npm" }

if ($Install) {
    $InstallVsCode = $true
    $InstallArma = $true
}

if ($InstallArma) {
    # The extension deploys the bundled DLL and @SqfReloader itself on "SqfReloader: Play".
    Write-Host "Note: -InstallArma is no longer needed (the extension ships the DLL and the mod); installing anyway." -ForegroundColor Yellow
}

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Green
}

function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $solutionRoot)

    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $exitCode."
    }
}

# ---------------------------------------------------------------------------
# 0. Version
#    -Version X.Y.Z writes that number into every version file and builds it.
#    Without -Version the current version is rebuilt (the .vsix is replaced).
#    Either way tools\build.ps1 must not bump the patch level afterwards.
# ---------------------------------------------------------------------------

. (Join-Path $extensionDir "tools\Common.ps1")

if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        throw "-Version needs three numbers like 2.3.0 (got '$Version')."
    }

    Update-ComponentVersions -Version $Version -UpdateDll -UpdateVsCode -UpdateConfig
}
else {
    $currentVersion = Get-VscodeVersion
    if (!$currentVersion) { $currentVersion = Get-ProjectVersion }
    Write-Step "Building the current version $currentVersion (the $currentVersion .vsix is replaced)"
}

# The version is set on disk above (or already there), so it is read once here and used for
# the runtime bundle, the .vsix file name and the summary.
$packageJson = Join-Path $solutionRoot "package.json"
$version = "?"

try { $version = (Get-Content $packageJson -Raw | ConvertFrom-Json).version } catch { }

if ($version -eq "?") { throw "Could not read the version from $packageJson." }

# ---------------------------------------------------------------------------
# 1. SqfReloader extension + mod (PBO via Arma 3 Tools AddonBuilder)
# ---------------------------------------------------------------------------

Write-Step "Building the SqfReloader extension and mod"

$buildArgs = @("-File", (Join-Path $extensionDir "tools\build.ps1"), "-Release", "-NoVersionBump")
if ($Clean) { $buildArgs += "-Clean" }
if ($AddonBuilder) { $buildArgs += @("-AddonBuilder", $AddonBuilder) }

Invoke-Native -FilePath "powershell" -Arguments (@("-NoProfile", "-ExecutionPolicy", "Bypass") + $buildArgs)
Write-Ok "SqfReloader_x64.dll and @SqfReloader built"

# ---------------------------------------------------------------------------
# 2. Runtime shipped inside the VSIX: the complete @SqfReloader mod
#    (vscode-runtime/mod/@SqfReloader -> <Arma 3>\@SqfReloader on Play)
# ---------------------------------------------------------------------------

Write-Step "Bundling the runtime into the VS Code extension"

$runtimeDir = Join-Path $solutionRoot "vscode-runtime"
$runtimeMod = Join-Path $runtimeDir "mod\@$modName"

if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path $runtimeMod -Parent) | Out-Null

$builtMod = Join-Path $extensionDir "dist\@$modName"
if (!(Test-Path (Join-Path $builtMod $dllName))) { throw "$dllName not found in $builtMod" }
if (!(Test-Path (Join-Path $builtMod "addons\$addonName.pbo"))) { throw "PBO not found in $builtMod\addons" }
if (!(Test-Path (Join-Path $builtMod "logo.paa"))) { throw "logo.paa not found in $builtMod (mod.cpp references it)" }

# Ship the mod exactly as it has to look in the Arma folder - the dist copy already has that
# layout, so it is copied as a whole:
#   mod.cpp, logo.paa, addons\scripts.pbo, SqfReloader_x64.dll
# The DLL must be in the mod ROOT - Arma does not search a dll\ subfolder for extensions.
Copy-Item $builtMod $runtimeMod -Recurse -Force

if ($Clean) {
    Get-ChildItem $solutionRoot -Filter "arma3-sqf-reloader-*.vsix" | Remove-Item -Force
}

Write-Ok "vscode-runtime\mod\@$modName : mod.cpp + logo.paa + addons\$addonName.pbo + $dllName ($((Get-ChildItem $runtimeMod -Recurse -File).Count) files)"

# ---------------------------------------------------------------------------
# 4. VS Code extension
# ---------------------------------------------------------------------------

Write-Step "Building the VS Code extension"

if (!(Test-Path (Join-Path $solutionRoot "node_modules"))) {
    Write-Host "    npm install" -ForegroundColor Gray
    Invoke-Native -FilePath $npm -Arguments @("install")
}

Invoke-Native -FilePath $npm -Arguments @("run", "compile")
Write-Ok "TypeScript compiled to out\"

$vsix = $null

if ($SkipVsce) {
    Write-Host "    -SkipVsce: no .vsix was created" -ForegroundColor Yellow
}
else {
    Invoke-Native -FilePath $npm -Arguments @("run", "package", "--", "--allow-missing-repository")

    # The build knows the version, so the exact file is checked (an older .vsix can never be
    # picked up by accident, and the current one is simply overwritten by vsce).
    $expected = Join-Path $solutionRoot "arma3-sqf-reloader-$version.vsix"

    # vsce can return just before the file shows up in a directory listing (antivirus scan,
    # write-back cache), so give it a moment before calling it a failure.
    for ($attempt = 0; $attempt -lt 20 -and !(Test-Path $expected); $attempt++) {
        Start-Sleep -Milliseconds 250
    }

    if (!(Test-Path $expected)) {
        throw "vsce did not produce $expected."
    }

    $vsix = Get-Item $expected
    Write-Ok "VSIX: $($vsix.FullName) (replaced)"
}

# ---------------------------------------------------------------------------
# 5. Install
# ---------------------------------------------------------------------------

if ($InstallArma) {
    Write-Step "Installing SqfReloader into Arma 3"

    $installArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $extensionDir "tools\install.ps1"), "-NoBuild")
    if ($ArmaDir) { $installArgs += @("-ArmaDir", $ArmaDir) }

    Invoke-Native -FilePath "powershell" -Arguments $installArgs
}

if ($InstallVsCode) {
    if (!$vsix) { throw "The VS Code extension was not packaged (remove -SkipVsce to install it)." }

    Write-Step "Installing the VS Code extension"

    $code = (Get-Command code -ErrorAction SilentlyContinue)
    if (!$code) {
        Write-Host "    'code' CLI not found. In VS Code use Ctrl+Shift+P > 'Shell Command: Install code command in PATH'," -ForegroundColor Yellow
        Write-Host "    or install manually: Extensions > ... > Install from VSIX > $($vsix.FullName)" -ForegroundColor Yellow
    }
    else {
        Invoke-Native -FilePath $code.Source -Arguments @("--install-extension", $vsix.FullName, "--force")
        Write-Ok "Installed $(Split-Path $vsix.Name -Leaf); reload the VS Code window to activate it"
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Step "Done"
Write-Host "  Version          : $version" -ForegroundColor Gray
Write-Host "  @SqfReloader mod : $(Join-Path $extensionDir 'dist\@SqfReloader')" -ForegroundColor Gray
Write-Host "    mod.cpp, logo.paa, addons\$addonName.pbo, $dllName" -ForegroundColor Gray
Write-Host "  Bundled in VSIX  : $runtimeMod" -ForegroundColor Gray
if ($vsix) { Write-Host "  VS Code extension: $($vsix.FullName)" -ForegroundColor Gray }
Write-Host ""
Write-Host "  Next: open your mod folder in VS Code and run ""SqfReloader: Play"" (status bar). Saving a .sqf file recompiles it in the running game." -ForegroundColor Gray
