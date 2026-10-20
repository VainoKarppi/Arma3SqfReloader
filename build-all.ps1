<#
.SYNOPSIS
    Builds everything: the ArmaApi extension, the @ArmaApi mod, the editable junction sources
    and the VS Code extension (.vsix). Optionally installs both into Arma 3 / VS Code.

.DESCRIPTION
    1. NativeAOT ArmaApi_x64.dll            (ArmaApiExtension/tools/build.ps1)
    2. @ArmaApi mod (PBO via AddonBuilder)  (dist/@ArmaApi, dist/ArmaApi-Setup.zip)
    3. Runtime bundle for the VSIX          (vscode-runtime/ArmaApi_x64.dll + @ArmaApi)
    4. VS Code extension                    (npm install, tsc, vsce package -> *.vsix)

    Every build increases the version of both components by one patch level
    (project + CfgPatches and package.json/package-lock.json), so two VSIX files never share
    a version number.

.PARAMETER Install
    Install the .vsix into VS Code and set up Arma 3 (equivalent to -InstallVsCode -InstallArma).

.PARAMETER InstallVsCode
    code --install-extension <vsix> (replaces a previous install).

.PARAMETER InstallArma
    Runs ArmaApiExtension/tools/install.ps1 (DLL next to arma3_x64.exe + @ArmaApi + config).

.PARAMETER ArmaDir
    Arma 3 folder for -InstallArma. Auto-detected when omitted.

.PARAMETER AddonBuilder
    Path to Arma 3 Tools AddonBuilder.exe (auto-detected when omitted).

.PARAMETER SkipVsce
    Only compile the TypeScript (useful when vsce is not installed).

.PARAMETER NoVersionBump
    Build with the current version numbers.

.PARAMETER Clean
    Rebuild the DLL from scratch and delete the previous .vsix files.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build-all.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File build-all.ps1 -Install -ArmaDir "D:\SteamLibrary\steamapps\common\Arma 3"
#>

[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$InstallVsCode,
    [switch]$InstallArma,
    [string]$ArmaDir = "",
    [string]$AddonBuilder = "",
    [switch]$SkipVsce,
    [switch]$NoVersionBump,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$extensionDir = Join-Path $repoRoot "ArmaApiExtension"
$addonSource = Join-Path $extensionDir "addons\armaapi"
$npm = if ($env:OS -eq "Windows_NT") { "npm.cmd" } else { "npm" }

if ($Install) {
    $InstallVsCode = $true
    $InstallArma = $true
}

if ($InstallArma) {
    # The extension deploys the bundled DLL and @ArmaApi itself on "Arma API: Play".
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
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $repoRoot)

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
# 1. ArmaApi extension + mod (PBO via Arma 3 Tools AddonBuilder)
# ---------------------------------------------------------------------------

Write-Step "Building the ArmaApi extension and mod"

$buildArgs = @("-File", (Join-Path $extensionDir "tools\build.ps1"), "-Release")
if ($Clean) { $buildArgs += "-Clean" }
if ($NoVersionBump) { $buildArgs += "-NoVersionBump" }
if ($AddonBuilder) { $buildArgs += @("-AddonBuilder", $AddonBuilder) }

Invoke-Native -FilePath "powershell" -Arguments (@("-NoProfile", "-ExecutionPolicy", "Bypass") + $buildArgs)
Write-Ok "ArmaApi_x64.dll, @ArmaApi (armaapi.pbo) and ArmaApi-Setup.zip built"

# Both components share one version number (tools\build.ps1 already bumped them together).
$version = "?"
try { $version = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version } catch { }

# ---------------------------------------------------------------------------
# 2. Runtime files shipped inside the VSIX
#    (vscode-runtime/ArmaApi_x64.dll + vscode-runtime/mod/@ArmaApi)
# ---------------------------------------------------------------------------

Write-Step "Bundling the runtime into the VS Code extension"

$runtimeDir = Join-Path $repoRoot "vscode-runtime"
$runtimeMod = Join-Path $runtimeDir "mod\@ArmaApi"

if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $runtimeMod | Out-Null

$builtDll = Join-Path $extensionDir "dist\@ArmaApi\dll\ArmaApi_x64.dll"
$builtPbo = Join-Path $extensionDir "dist\@ArmaApi\addons\armaapi.pbo"
if (!(Test-Path $builtDll)) { throw "DLL not found: $builtDll" }
if (!(Test-Path $builtPbo)) { throw "PBO not found: $builtPbo" }

Copy-Item $builtDll $runtimeDir -Force

# mod.cpp points at \armaapi\logo.paa, which lives inside the PBO.
Copy-Item (Join-Path $addonSource "mod.cpp") $runtimeMod -Force

# The addon ships as a PBO, exactly like the E:\SteamLibrary\...\@ArmaApi install. Hot reloads
# still work: the extension links <arma>\z\armaapi\addons\armaapi to the plain sources in
# vscode-runtime\mod\armaapi-src and enables file patching (replacePbo), and it writes
#     reloader = "\armaapi-src\reloader.sqf"; recompile = 1;
# into that patched config before Arma starts (src/reloader.ts).
$pboDir = Join-Path $runtimeMod "addons"
New-Item -ItemType Directory -Force -Path $pboDir | Out-Null
Copy-Item $builtPbo $pboDir -Force

# Sources of the SQF side (also what "afterbuner" style tools read).
$runtimeSource = Join-Path $runtimeDir "mod\armaapi-src"
New-Item -ItemType Directory -Force -Path $runtimeSource | Out-Null
Copy-Item (Join-Path $addonSource "config.cpp") $runtimeSource -Force
Copy-Item (Join-Path $addonSource '$PBOPREFIX$') $runtimeSource -Force
Copy-Item (Join-Path $addonSource "functions") $runtimeSource -Recurse -Force

if ($Clean) {
    Get-ChildItem $repoRoot -Filter "arma3-sqf-reloader-*.vsix" | Remove-Item -Force
}

Write-Ok "vscode-runtime: ArmaApi_x64.dll + @ArmaApi\addons\armaapi.pbo + armaapi-src ($((Get-ChildItem $runtimeDir -Recurse -File).Count) files)"

# ---------------------------------------------------------------------------
# 4. VS Code extension
# ---------------------------------------------------------------------------

Write-Step "Building the VS Code extension"

if (!(Test-Path (Join-Path $repoRoot "node_modules"))) {
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
    $vsix = Get-ChildItem $repoRoot -Filter "arma3-sqf-reloader-*.vsix" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (!$vsix) { throw "vsce did not produce a .vsix file." }
    Write-Ok "VSIX: $($vsix.FullName)"
}

# ---------------------------------------------------------------------------
# 5. Install
# ---------------------------------------------------------------------------

if ($InstallArma) {
    Write-Step "Installing ArmaApi into Arma 3"

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
Write-Host "  ArmaApi DLL      : $(Join-Path $extensionDir 'dist\@ArmaApi\dll\ArmaApi_x64.dll')" -ForegroundColor Gray
Write-Host "  ArmaApi mod      : $(Join-Path $extensionDir 'dist\@ArmaApi') (addons\armaapi.pbo)" -ForegroundColor Gray
Write-Host "  PBO sources      : $(Join-Path $runtimeDir 'mod\armaapi-src')" -ForegroundColor Gray
if ($vsix) { Write-Host "  VS Code extension: $($vsix.FullName)" -ForegroundColor Gray }
Write-Host ""
Write-Host "  Next: open your mod folder in VS Code and run ""Arma API: Play"" (status bar). Saving a .sqf file recompiles it in the running game." -ForegroundColor Gray
