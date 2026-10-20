<#
.SYNOPSIS
    Shared helpers for the ArmaApi build/install scripts.
#>

$ErrorActionPreference = "Stop"

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script:ProjectFile = Join-Path $script:RepoRoot "ArmaApiExtension.csproj"
$script:AddonSource = Join-Path $script:RepoRoot "addons\armaapi"
$script:PboBuilderProject = Join-Path $script:RepoRoot "tools\PboBuilder\PboBuilder.csproj"
$script:DistDir = Join-Path $script:RepoRoot "dist"
$script:WorkspaceRoot = (Resolve-Path (Join-Path $script:RepoRoot "..")).Path
$script:PackageFile = Join-Path $script:WorkspaceRoot "package.json"
$script:ModName = "ArmaApi"
$script:ModFolder = Join-Path $script:DistDir "@$($script:ModName)"
$script:DllName = "ArmaApi_x64.dll"
$script:AddonName = "armaapi"

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Green
}

function Write-Warn([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Yellow
}

function Write-Fail([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Red
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [Parameter(Mandatory)] [string[]]$Arguments,
        [string]$WorkingDirectory = $script:RepoRoot
    )

    Push-Location $WorkingDirectory
    try {
        $output = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        $output | ForEach-Object {
            $line = "$_"
            $color = if ($line -match "error") { "Red" } elseif ($line -match "warn") { "Yellow" } else { "Gray" }
            Write-Host "    $line" -ForegroundColor $color
        }
        throw "Command failed ($exitCode): $FilePath $($Arguments -join ' ')"
    }

    return $output
}

function Get-DotNetPath {
    $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($dotnet) { return $dotnet.Source }

    $fallback = Join-Path $env:ProgramFiles "dotnet\dotnet.exe"
    if (Test-Path $fallback) { return $fallback }

    throw "dotnet SDK not found. Install the .NET 10 SDK: https://dotnet.microsoft.com/download"
}

function Test-MsvcToolchain {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (!(Test-Path $vswhere)) { return $false }

    $install = & $vswhere -products * -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    return [bool]$install
}

function Get-ArmaDirectories {
    $results = New-Object System.Collections.Generic.List[string]

    # Registry (works for Steam and retail installs).
    $registryKeys = @(
        "HKLM:\SOFTWARE\WOW6432Node\Bohemia Interactive\ArmA 3",
        "HKLM:\SOFTWARE\Bohemia Interactive\ArmA 3",
        "HKCU:\SOFTWARE\Bohemia Interactive\ArmA 3"
    )

    foreach ($key in $registryKeys) {
        $value = (Get-ItemProperty -Path $key -Name "main" -ErrorAction SilentlyContinue).main
        if ($value) {
            $directory = Split-Path $value -Parent
            if (Test-Path $directory) { $results.Add($directory) }
        }
    }

    # Steam libraries (steamapps/libraryfolders.vdf).
    $steamPath = (Get-ItemProperty -Path "HKCU:\SOFTWARE\Valve\Steam" -Name "SteamPath" -ErrorAction SilentlyContinue).SteamPath
    $steamRoots = @(
        if ($steamPath) { $steamPath },
        "C:\Program Files (x86)\Steam",
        "D:\SteamLibrary",
        "D:\Steam"
    )

    foreach ($root in $steamRoots) {
        if (!$root -or !(Test-Path $root)) { continue }

        $libraryFile = Join-Path $root "steamapps\libraryfolders.vdf"
        $libraries = @($root)

        if (Test-Path $libraryFile) {
            foreach ($line in (Get-Content $libraryFile)) {
                if ($line -match '"path"\s+"([^"]+)"') { $libraries += $Matches[1].Replace("\\", "\") }
            }
        }

        foreach ($library in $libraries) {
            $candidate = Join-Path $library "steamapps\common\Arma 3"
            if (Test-Path (Join-Path $candidate "arma3_x64.exe")) { $results.Add($candidate) }
        }
    }

    return @($results | Select-Object -Unique)
}

function Get-ArmaDirectory {
    param([string]$Path)

    if ($Path) {
        $resolved = (Resolve-Path $Path -ErrorAction SilentlyContinue).Path
        if (!$resolved -or !(Test-Path (Join-Path $resolved "arma3_x64.exe"))) {
            throw "Arma 3 was not found in '$Path' (arma3_x64.exe missing)."
        }
        return $resolved
    }

    $found = Get-ArmaDirectories | Select-Object -First 1
    if (!$found) {
        throw "Could not find Arma 3. Pass -ArmaDir 'C:\...\steamapps\common\Arma 3'."
    }

    return $found
}

function Get-ProjectVersion {
    [xml]$project = Get-Content $script:ProjectFile
    $versionNode = $project.Project.PropertyGroup | Where-Object { $_.Version } | Select-Object -First 1
    if ($versionNode -and $versionNode.Version) { return $versionNode.Version }
    return "0.0.0"
}

function Get-VscodeVersion {
    if (!(Test-Path $script:PackageFile)) { return "" }

    $package = Get-Content $script:PackageFile -Raw | ConvertFrom-Json
    return $package.version
}

function Add-KeyToHashtable {
    # Replaces the first "version" value in a JSON file in place so the surrounding
    # formatting (and the lock file's indentation) stays as it was.
    param(
        [string]$Version,
        [string[]]$Files
    )

    foreach ($file in $Files) {
        $relative = Split-Path $file -Leaf
        if (!(Test-Path $file)) { Write-Warn "Version bump skipped, file not found: $relative"; continue }

        $content = Get-Content $file -Raw
        $updated = [regex]::Replace($content, '("version"\s*:\s*")[^"]*(")', '${1}' + $Version + '${2}', 1)

        if ($updated -eq $content) {
            Write-Warn "Version bump skipped, no version field: $relative"
            continue
        }

        # UTF8 without BOM: JSON parsers (npm, vsce) reject a byte order mark.
        [System.IO.File]::WriteAllText($file, $updated, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "Version $Version -> $relative"
    }
}

function Write-BuildStamp([string]$Version) {
    # The VSIX contains a prebuilt copy of this file, so it must be written from the build
    # (see Add-VersionAutoIncrement in the csproj).
    $stamp = Join-Path $script:RepoRoot "src\BuildStamp.cs"
    $content = @"
// <auto-generated>
// Written by ArmaApiExtension\tools\build.ps1 (Update-ComponentVersions). Do not edit by
// hand: the version is set in ArmaApiExtension.csproj and Tools\build.ps1 keeps this, the
// VS Code package.json and CfgPatches in sync.
// </auto-generated>
namespace ArmaApi;

internal static class BuildStamp {
    public const string Version = "$Version";
}

"@
    Set-Content -Path $stamp -Value $content -Encoding UTF8 -NoNewline
    Write-Ok "Build stamp: src\BuildStamp.cs ($Version)"}

function Update-ComponentVersions {
    # Note: parameter names avoid $Config, $Dll... because PowerShell treats variables that
    # differ only in case from a preference variable as the preference ($Config, $PSScriptRoot...).
    param(
        [Parameter(Mandatory)] [string]$Version,
        [switch]$UpdateDll,
        [switch]$UpdateVsCode,
        [switch]$UpdateConfig
    )

    Write-Step "Setting version $Version"
    $bump = @()

    if ($UpdateDll) {
        $csproj = [string](Get-Content $script:ProjectFile -Raw)
        $csproj = [regex]::Replace($csproj, '(<Version>)[^<]*(</Version>)', '${1}' + $Version + '${2}', 1)
        [System.IO.File]::WriteAllText($script:ProjectFile, $csproj, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "ArmaApiExtension.csproj"
        Write-BuildStamp -Version $Version
    }

    if ($UpdateDll -or $UpdateVsCode) {
        $bump = @(
            $script:PackageFile,
            (Join-Path $script:WorkspaceRoot "package-lock.json")
        )
    }

    if ($bump.Count -gt 0) {
        Add-KeyToHashtable -Version $Version -Files $bump
    }

    if ($UpdateConfig) {
        $configPath = Join-Path $script:AddonSource "config.cpp"
        $config = [string](Get-Content $configPath -Raw)

        # CfgPatches: version / versionStr / versionAr[] share one major.minor.patch.
        $parts = @($Version.Split("."))

        if ($parts.Count -lt 3) { throw "The mod version needs three parts (x.y.z): $Version" }

        $numbers = "$([int]$parts[0]), $([int]$parts[1]), $([int]$parts[2])"

        $config = [regex]::Replace($config, '(?<=\bversion\s*=\s*")[^"]*', $Version)
        $config = [regex]::Replace($config, '(?<=\bversionStr\s*=\s*")[^"]*', $Version)
        $config = [regex]::Replace($config, '(?<=\bversionAr\[\]\s*=\s*\{)[^}]*', $numbers)

        [System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding($false)))
        Write-Ok "addons\armaapi\config.cpp"
    }
}

function Invoke-DllBuild {
    param([switch]$Clean)

    $dotnet = Get-DotNetPath

    Write-Step "Building $($script:DllName) (NativeAOT, win-x64)"

    if (!(Test-MsvcToolchain)) {
        Write-Warn "Visual Studio C++ build tools were not detected. NativeAOT linking will fail without them:"
        Write-Warn 'winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
    }

    if ($Clean) {
        Invoke-Checked -FilePath $dotnet -Arguments @("clean", $script:ProjectFile, "-c", "Release", "-r", "win-x64") | Out-Null
    }

    Invoke-Checked -FilePath $dotnet -Arguments @("publish", $script:ProjectFile, "-c", "Release", "-r", "win-x64", "-nologo") | Out-Null

    $dll = Join-Path $script:RepoRoot "bin\Release\net10.0\win-x64\publish\$($script:DllName)"
    if (!(Test-Path $dll)) { throw "DLL was not produced: $dll" }

    Write-Ok "DLL: $dll ($([Math]::Round((Get-Item $dll).Length / 1MB, 2)) MB)"

    return $dll
}

function Find-AddonBuilder {
    # Order: explicit parameter / environment, the registry entry the Arma 3 Tools installer
    # writes, then the default Steam library locations.
    $candidates = New-Object System.Collections.Generic.List[string]

    if ($env:ARMA3_ADDONBUILDER) { $candidates.Add($env:ARMA3_ADDONBUILDER) }

    foreach ($key in @("HKLM:\SOFTWARE\WOW6432Node\Bohemia Interactive\Arma 3 Tools", "HKLM:\SOFTWARE\Bohemia Interactive\Arma 3 Tools")) {
        $install = (Get-ItemProperty -Path $key -Name "Path" -ErrorAction SilentlyContinue).Path
        if ($install) { $candidates.Add((Join-Path $install "AddonBuilder\AddonBuilder.exe")) }
    }

    $steamPath = (Get-ItemProperty -Path "HKCU:\SOFTWARE\Valve\Steam" -Name "SteamPath" -ErrorAction SilentlyContinue).SteamPath
    $libraries = New-Object System.Collections.Generic.List[string]

    if ($steamPath) {
        $libraries.Add($steamPath)

        $libraryFile = Join-Path $steamPath "steamapps\libraryfolders.vdf"
        if (Test-Path $libraryFile) {
            foreach ($line in (Get-Content $libraryFile)) {
                if ($line -match '"path"\s+"([^"]+)"') { $libraries.Add($Matches[1].Replace("\\", "\")) }
            }
        }
    }

    $drives = @("C:", "D:", "E:", "F:", "G:")
    $roots = @($libraries) + @("C:\Program Files (x86)\Steam", "D:\SteamLibrary", "D:\Steam", "E:\SteamLibrary")

    foreach ($root in $roots) {
        if (!$root) { continue }
        $candidates.Add((Join-Path $root "steamapps\common\Arma 3 Tools\AddonBuilder\AddonBuilder.exe"))
    }

    foreach ($drive in $drives) {
        $candidates.Add("$drive\SteamLibrary\steamapps\common\Arma 3 Tools\AddonBuilder\AddonBuilder.exe")
    }

    # A partial Arma 3 Tools install ships AddonBuilder.exe without binarize/CfgConvert, which
    # makes it fail at the first binarize step; such an install is not usable.
    foreach ($candidate in $candidates) {
        if (!(Test-Path $candidate)) { continue }

        $toolsRoot = Split-Path (Split-Path $candidate -Parent) -Parent
        if (!(Test-Path (Join-Path $toolsRoot "CfgConvert\CfgConvert.exe")) -and
            !(Test-Path (Join-Path $toolsRoot "CfgConvert.exe"))) {
            Write-Warn "AddonBuilder found but Arma 3 Tools is incomplete (CfgConvert missing): $toolsRoot"
            continue
        }

        return (Resolve-Path $candidate).Path
    }

    return $null
}

function Get-ArmaApiPublicKeyPath {
    param([string]$Override)

    if ($Override) { return (Resolve-Path $Override).Path }

    $local = Join-Path $script:AddonSource "$($script:ModName).biprivatekey"
    if (Test-Path $local) { return $local }

    return $null
}

function Assert-PboContainsScripts {
    # A script-only addon PBO must contain its functions and $PBOPREFIX$; a PBO with just
    # config.bin makes Arma report "Script functions\... not found" for every function at
    # start-up, which is silent and easy to misdiagnose.
    param([Parameter(Mandatory)] [string]$PboPath)

    $bytes = [System.IO.File]::ReadAllBytes($PboPath)
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)

    if (!$text.Contains("PBOPREFIX")) {
        throw "The PBO $PboPath has no `$PBOPREFIX` entry. Arma would mount it without knowing where its relative script paths live."
    }

    $missing = @()

    foreach ($file in (Get-ChildItem (Join-Path $script:AddonSource "functions") -Recurse -File -Filter "fn_*.sqf")) {
        if (!$text.Contains($file.Name)) { $missing += $file.Name }
    }

    if ($missing.Count -gt 0) {
        throw "The PBO $PboPath is missing $($missing.Count) script(s), for example $($missing[0]). Arma would report 'Script ... not found' for those functions."
    }
}

function Invoke-AddonBuilder {
    param(
        [Parameter(Mandatory)] [string]$Source,
        [Parameter(Mandatory)] [string]$Output,
        [string]$AddonBuilder = "",
        [string]$KeyPath = "",
        [string]$TempDirectory = "",
        [switch]$Nobinarize
    )

    $builderPath = if ($AddonBuilder) { (Resolve-Path $AddonBuilder).Path } else { Find-AddonBuilder }

    if (!$builderPath) {
        throw @"
AddonBuilder.exe was not found. Install "Arma 3 Tools" in Steam (Library > Tools) or pass -AddonBuilder.
  Steam: steam://install/233800   (Arma 3 Tools)
  Typical path: <Steam>\steamapps\common\Arma 3 Tools\AddonBuilder\AddonBuilder.exe
"@
    }

    if (!$TempDirectory) { $TempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "armaapi-addonbuilder" }
    $sourcePath = (Resolve-Path $Source).Path
    $pboTarget = [System.IO.Path]::GetFullPath($Output)
    $outputFolder = Split-Path $pboTarget -Parent
    New-Item -ItemType Directory -Force -Path $outputFolder | Out-Null
    New-Item -ItemType Directory -Force -Path $TempDirectory | Out-Null

    # destination_path is a folder: AddonBuilder writes <destination>\<source folder name>.pbo.
    $arguments = @($sourcePath, $outputFolder, "-clear", "-temp=$TempDirectory", "-prefix=z\$($script:AddonName)")
    if ($Nobinarize) { $arguments += "-packonly" }
    if ($KeyPath) { $arguments += "-sign=$KeyPath" }

    # Without this AddonBuilder looks for binarize/CfgConvert below its own folder, which is not
    # where the Arma 3 Tools installer puts them.
    $toolsRoot = Split-Path (Split-Path $builderPath -Parent) -Parent
    $arguments += "-toolsDirectory=$toolsRoot"

    # AddonBuilder writes its progress (and Steam's "Setting breakpad minidump AppID" line) to
    # stderr. With $ErrorActionPreference = "Stop" that would abort the build, so the output is
    # collected as text and only the exit code and the output file decide.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $builderOutput = @(& $builderPath @arguments 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    $builderOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

    # Local names are prefixed: $output and similar names are PowerShell automatic variables
    # that pipeline output would overwrite inside this scope.
    $pboPath = [System.IO.Path]::GetFullPath($pboTarget)
    $produced = Test-Path -LiteralPath $pboPath

    if ($exitCode -ne 0) {
        throw "AddonBuilder failed (exit code $exitCode):`n$(($builderOutput) -join "`n")"
    }

    if (!$produced) {
        throw "AddonBuilder did not create $pboPath. Output:`n$(($builderOutput) -join "`n")"
    }

    Write-Ok "AddonBuilder: $builderPath ($pboPath)"
    return $pboPath
}

function New-ModPackage {
    param(
        [Parameter(Mandatory)] [string]$DllPath,
        [switch]$SkipPbo,
        [ValidateSet("Auto", "AddonBuilder", "PboBuilder")] [string]$Packer = "Auto",
        [string]$AddonBuilder = "",
        [string]$KeyPath = ""
    )

    Write-Step "Creating mod folder $script:ModFolder"

    if (Test-Path $script:ModFolder) { Remove-Item $script:ModFolder -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $script:ModFolder "addons") | Out-Null

    # mod.cpp + logo live in the mod root.
    Copy-Item (Join-Path $script:AddonSource "mod.cpp") $script:ModFolder -Force
    $logo = Join-Path $script:AddonSource "logo.paa"
    if (Test-Path $logo) { Copy-Item $logo $script:ModFolder -Force }

    if ($SkipPbo) {
        Write-Warn "-NoPbo: the addon folder is shipped unpacked (Arma loads it as a directory)."
    }
    elseif ($Packer -eq "Auto") {
        # AddonBuilder (Arma 3 Tools) is the official packer and is used whenever it is
        # installed; PboBuilder is the fallback for machines without Arma 3 Tools.
        if ((Test-Path $script:PboBuilderProject) -and !(Find-AddonBuilder)) { $Packer = "PboBuilder" }
        else { $Packer = "AddonBuilder" }
    }

    if ($Packer -eq "PboBuilder" -and !(Test-Path $script:PboBuilderProject)) {
        throw "PboBuilder was requested but $script:PboBuilderProject does not exist."
    }

    if (!$SkipPbo -and $Packer -eq "AddonBuilder") {
        Write-Step "Packing addons\$($script:AddonName).pbo (Arma 3 Tools AddonBuilder)"
    }
    elseif (!$SkipPbo) {
        Write-Step "Packing addons\$($script:AddonName).pbo (PboBuilder)"
    }

    $pbo = Join-Path $script:ModFolder "addons\$($script:AddonName).pbo"

    if ($SkipPbo) {
        # Nothing to pack.
    }
    elseif ($Packer -eq "AddonBuilder") {
        # ArmaApi is a script-only addon: no models, no textures. AddonBuilder's binarize step
        # classifies files by extension and drops the loose .sqf files of such an addon (the
        # PBO ended up containing config.bin only, so Arma reported "Script ... not found" for
        # every function). -packonly stores the folder as-is, which is exactly what a script
        # PBO needs; CfgConvert still writes config.bin from config.cpp.
        $stage = Join-Path $script:DistDir "stage\armaapi"
        if (Test-Path (Join-Path $script:DistDir "stage")) { Remove-Item (Join-Path $script:DistDir "stage") -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $stage | Out-Null

        Copy-Item (Join-Path $script:AddonSource "config.cpp") $stage -Force
        Copy-Item (Join-Path $script:AddonSource '$PBOPREFIX$') $stage -Force
        Copy-Item (Join-Path $script:AddonSource "functions") $stage -Recurse -Force

        # The packed copy gets recompile=1 stripped: it is not needed in the PBO (the extension
        # re-adds reloading through the file-patching config), and older binarize builds
        # rejected the flag.
        $configPath = Join-Path $stage "config.cpp"
        $config = [regex]::Replace([string](Get-Content $configPath -Raw), '\s*recompile\s*=\s*1\s*;', '')
        [System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding($false)))

        Invoke-AddonBuilder -Source $stage -Output $pbo -AddonBuilder $AddonBuilder -KeyPath $KeyPath -Nobinarize | Out-Null
        Remove-Item (Join-Path $script:DistDir "stage") -Recurse -Force

        Assert-PboContainsScripts -PboPath $pbo
        Write-Ok "PBO: $pbo ($([Math]::Round((Get-Item $pbo).Length / 1KB, 1)) KB)"
    }
    else {
        $output = Invoke-PboBuild -Source $script:AddonSource -Output $pbo `
            -Prefix "z\$($script:AddonName.ToLower())\addons\$($script:AddonName.ToLower())" `
            -Exclude @("mod.cpp", "logo.paa", "*.pbo")

        $output | ForEach-Object { if ("$_" -match "^Packed") { Write-Ok "$_" } }
        Assert-PboContainsScripts -PboPath $pbo
    }

    # Sources next to the PBO: REST recompile reads them from disk (PBOs cannot be edited).
    $sourceDir = Join-Path $script:ModFolder "source"
    New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
    Copy-Item (Join-Path $script:AddonSource "functions") $sourceDir -Recurse -Force
    Copy-Item (Join-Path $script:AddonSource "config.cpp") $sourceDir -Force

    # The DLL ships twice: the installer can deploy it from either place.
    $dllDir = Join-Path $script:ModFolder "dll"
    New-Item -ItemType Directory -Force -Path $dllDir | Out-Null
    Copy-Item $DllPath $dllDir -Force

    Write-Ok "Mod created: $script:ModFolder"
}

function Install-DllToArma {
    param([Parameter(Mandatory)] [string]$ArmaDir, [Parameter(Mandatory)] [string]$DllPath)

    $targets = @("arma3_x64.exe", "arma3server_x64.exe")
    $installed = 0

    foreach ($target in $targets) {
        if (!(Test-Path (Join-Path $ArmaDir $target))) { continue }

        Copy-Item $DllPath (Join-Path $ArmaDir $script:DllName) -Force
        Write-Ok "DLL -> $(Join-Path $ArmaDir $script:DllName)"
        $installed++
    }

    return $installed
}

function Write-ApiConfig {
    param(
        [int]$Port = 8765,
        [string]$HostName = "127.0.0.1",
        [string]$SourceDirectory = ""
    )

    $configDir = Join-Path $env:LOCALAPPDATA "ArmaApi"
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null

    $configFile = Join-Path $configDir "config.json"
    $config = [ordered]@{
        host = $HostName
        port = $Port
        autoStart = $true
        sourceDirectory = $SourceDirectory
    }

    $config | ConvertTo-Json | Set-Content -Path $configFile -Encoding UTF8
    Write-Ok "Config -> $configFile"
}

function Add-SteamLaunchOption {
    param([Parameter(Mandatory)] [string]$ModFolder)

    $steamPath = (Get-ItemProperty -Path "HKCU:\SOFTWARE\Valve\Steam" -Name "SteamPath" -ErrorAction SilentlyContinue).SteamPath
    if (!$steamPath) {
        Write-Warn "Steam was not found, add this manually to the Arma 3 launch options: -mod=`"$ModFolder`""
        return $false
    }

    $userData = Join-Path $steamPath "userdata"
    if (!(Test-Path $userData)) {
        Write-Warn "Steam userdata folder not found; add -mod=`"$ModFolder`" manually."
        return $false
    }

    $option = "-mod=`"$ModFolder`""
    $updated = 0

    Get-ChildItem $userData -Directory | ForEach-Object {
        $localConfig = Join-Path $_.FullName "config\localconfig.vdf"
        if (!(Test-Path $localConfig)) { return }

        $content = Get-Content $localConfig -Raw
        if ($content -match [regex]::Escape($option)) { return }

        # The Arma 3 app block (107410) must exist before a launch option can be added.
        if ($content -notmatch '"107410"') {
            Write-Warn "Arma 3 is not in the Steam library of $($_.Name); launch options were not changed."
            return
        }

        $pattern = '(?s)("107410"\s*\{.*?)("LaunchOptions"\s*")([^"]*)(")'
        if ($content -match $pattern) {
            $content = [regex]::Replace($content, $pattern, { param($m) $m.Groups[1].Value + $m.Groups[2].Value + ($m.Groups[3].Value + " $option").Trim() + $m.Groups[4].Value }, 1)
        }
        else {
            $content = [regex]::Replace($content, '(?s)("107410"\s*\{)', { param($m) $m.Groups[1].Value + "`n`t`t`t`t`"LaunchOptions`"`t`t`"$option`"" }, 1)
        }

        Set-Content -Path $localConfig -Value $content -Encoding UTF8 -NoNewline
        $updated++
    }

    if ($updated -gt 0) {
        Write-Ok "Steam launch options updated: $option (restart Steam if it is running)"
        return $true
    }

    Write-Warn "No launch option was changed. Add this to Arma 3 -> Properties -> Launch Options: $option"
    return $false
}

function Remove-SteamLaunchOption {
    param([Parameter(Mandatory)] [string]$ModFolder)

    $steamPath = (Get-ItemProperty -Path "HKCU:\SOFTWARE\Valve\Steam" -Name "SteamPath" -ErrorAction SilentlyContinue).SteamPath
    if (!$steamPath) { return }

    $option = "-mod=`"$ModFolder`""

    Get-ChildItem (Join-Path $steamPath "userdata") -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $localConfig = Join-Path $_.FullName "config\localconfig.vdf"
        if (!(Test-Path $localConfig)) { return }

        $content = Get-Content $localConfig -Raw
        if ($content -notmatch [regex]::Escape($option)) { return }

        $content = $content.Replace(" $option", "").Replace($option, "")
        Set-Content -Path $localConfig -Value $content -Encoding UTF8 -NoNewline
        Write-Ok "Removed launch option from $localConfig"
    }
}
