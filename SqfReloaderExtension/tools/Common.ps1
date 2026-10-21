<#
.SYNOPSIS
    Shared helpers for the SqfReloader build/install scripts.
#>

$ErrorActionPreference = "Stop"

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script:ProjectFile = Join-Path $script:RepoRoot "SqfReloaderExtension.csproj"
# The sources are already laid out like the shipped mod:
#   @SqfReloader\mod.cpp, @SqfReloader\logo.paa, @SqfReloader\addons\scripts\...
$script:ModSource = Join-Path $script:RepoRoot "@SqfReloader"
$script:AddonSource = Join-Path $script:ModSource "addons\scripts"
$script:PboBuilderProject = Join-Path $script:RepoRoot "tools\PboBuilder\PboBuilder.csproj"
$script:DistDir = Join-Path $script:RepoRoot "dist"
$script:WorkspaceRoot = (Resolve-Path (Join-Path $script:RepoRoot "..")).Path
$script:PackageFile = Join-Path $script:WorkspaceRoot "package.json"
$script:ModName = "SqfReloader"
$script:ModFolder = Join-Path $script:DistDir "@$($script:ModName)"
$script:DllName = "SqfReloader_x64.dll"
# The addon is mounted as \scripts, which is what CfgFunctions uses in config.cpp.
$script:AddonName = "scripts"

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
// Written by SqfReloaderExtension\tools\build.ps1 (Update-ComponentVersions). Do not edit by
// hand: the version is set in SqfReloaderExtension.csproj and Tools\build.ps1 keeps this, the
// VS Code package.json and CfgPatches in sync.
// </auto-generated>
namespace SqfReloader;

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
        Write-Ok "SqfReloaderExtension.csproj"
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
        Write-Ok "@$($script:ModName)\addons\$($script:AddonName)\config.cpp"
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

function Get-TreeContentHash {
    param(
        [Parameter(Mandatory)] [string[]]$Path,
        [string]$Root = ""
    )

    $entries = New-Object System.Collections.Generic.List[string]
    foreach ($itemPath in $Path) {
        if (!(Test-Path -LiteralPath $itemPath)) { continue }
        $item = Get-Item -LiteralPath $itemPath
        if ($item.PSIsContainer) {
            $base = $item.FullName
            foreach ($file in (Get-ChildItem -LiteralPath $base -Recurse -File | Sort-Object FullName)) {
                $relative = $file.FullName.Substring($base.TrimEnd("\", "/").Length).TrimStart("\", "/").Replace("\", "/")
                $fileHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
                $entries.Add("$($item.Name)/$relative $fileHash")
            }
        }
        else {
            $relative = if ($Root) { $item.FullName.Substring($Root.TrimEnd("\", "/").Length).TrimStart("\", "/").Replace("\", "/") } else { $item.Name }
            $fileHash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
            $entries.Add("$relative $fileHash")
        }
    }

    $content = [string]::Join("`n", @($entries | Sort-Object))
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($content)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $sha.Dispose() }
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

function Get-SqfReloaderPublicKeyPath {
    param([string]$Override)

    if ($Override) { return (Resolve-Path $Override).Path }

    $local = Join-Path $script:AddonSource "$($script:ModName).biprivatekey"
    if (Test-Path $local) { return $local }

    return $null
}

function Assert-PboContainsScripts {
    # A script-only addon PBO must contain its functions and a mount prefix; a PBO with just
    # config.bin makes Arma report "Script functions\... not found" for every function at
    # start-up, which is silent and easy to misdiagnose.
    #
    # AddonBuilder writes the prefix either as the "prefix" header property (-prefix=scripts)
    # or as a $PBOPREFIX$ file entry, depending on how it was invoked, so accept both.
    param(
        [Parameter(Mandatory)] [string]$PboPath,
        [string]$Prefix = ""
    )

    $bytes = [System.IO.File]::ReadAllBytes($PboPath)
    $text = [System.Text.Encoding]::ASCII.GetString($bytes)

    $hasPrefixEntry = $text.Contains("PBOPREFIX")
    $hasPrefixHeader = $text.Contains("prefix") -and (!$Prefix -or $text.Contains($Prefix))

    if (!$hasPrefixEntry -and !$hasPrefixHeader) {
        throw "The PBO $PboPath has no mount prefix. Arma would not know where its relative script paths live."
    }

    $missing = @()

    foreach ($file in (Get-ChildItem (Join-Path $script:AddonSource "functions") -Recurse -File -Filter "fn_*.sqf")) {
        if (!$text.Contains($file.Name)) { $missing += $file.Name }
    }

    if ($missing.Count -gt 0) {
        throw "The PBO $PboPath is missing $($missing.Count) script(s), for example $($missing[0]). Arma would report 'Script ... not found' for those functions."
    }

    if (!$text.Contains("config.cpp") -and !$text.Contains("config.bin")) {
        throw "The PBO $PboPath has no config. Arma would load the scripts without registering CfgFunctions."
    }
}

function Invoke-AddonBuilder {
    param(
        [Parameter(Mandatory)] [string]$Source,
        [Parameter(Mandatory)] [string]$Output,
        [string]$AddonBuilder = "",
        [string]$KeyPath = "",
        [string]$TempDirectory = "",
        [string]$Prefix = "",
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

    if (!$TempDirectory) { $TempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "sqfreloader-addonbuilder" }
    $sourcePath = (Resolve-Path $Source).Path
    $pboTarget = [System.IO.Path]::GetFullPath($Output)
    $outputFolder = Split-Path $pboTarget -Parent
    New-Item -ItemType Directory -Force -Path $outputFolder | Out-Null
    New-Item -ItemType Directory -Force -Path $TempDirectory | Out-Null

    # destination_path is a folder: AddonBuilder writes <destination>\<source folder name>.pbo.
    if (!$Prefix) { $Prefix = $script:AddonName }
    $arguments = @($sourcePath, $outputFolder, "-clear", "-temp=$TempDirectory", "-prefix=$Prefix")
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
        [switch]$BuildPbo,
        [switch]$NoPbo,
        [ValidateSet("Auto", "AddonBuilder", "PboBuilder")] [string]$Packer = "Auto",
        [string]$AddonBuilder = "",
        [string]$KeyPath = ""
    )

    # The sources in @SqfReloader are already laid out like the shipped mod, so the dist copy
    # is that tree plus the packed PBO and the DLL:
    #
    #   @SqfReloader\mod.cpp
    #   @SqfReloader\logo.paa                     (mod.cpp declares logo = "logo.paa")
    #   @SqfReloader\addons\scripts.pbo           packed addon, prefix "scripts"
    #   @SqfReloader\SqfReloader_x64.dll          native extension, in the MOD ROOT
    #
    # The DLL must sit in the mod root (or next to arma3_x64.exe) - Arma does not search a
    # `dll\` subfolder for extensions, it reports "CallExtension 'SqfReloader' could not be found".
    #
    # No `replacement\` folder and no unpacked addon copy: Arma reads everything from the PBO.
    # The addon is named "scripts" because CfgFunctions uses absolute \scripts\... paths, so
    # the PBO prefix has to say "scripts".
    Write-Step "Creating mod folder $script:ModFolder"

    foreach ($required in @((Join-Path $script:ModSource "mod.cpp"), (Join-Path $script:ModSource "logo.paa"), (Join-Path $script:AddonSource "config.cpp"))) {
        if (!(Test-Path $required)) { throw "Mod source not found: $required" }
    }

    $preserved = Join-Path ([System.IO.Path]::GetTempPath()) ("sqfreloader-package-" + [guid]::NewGuid().ToString("N"))
    $preservedPbo = Join-Path $preserved "scripts.pbo"
    $preservedDll = Join-Path $preserved $script:DllName
    $existingPbo = Join-Path $script:ModFolder "addons\$($script:AddonName).pbo"
    $existingDll = Join-Path $script:ModFolder $script:DllName
    if (!$BuildPbo -and !$NoPbo -and (Test-Path $existingPbo)) {
        New-Item -ItemType Directory -Force -Path $preserved | Out-Null
        Copy-Item $existingPbo $preservedPbo -Force
    }
    if (Test-Path $existingDll) {
        New-Item -ItemType Directory -Force -Path $preserved | Out-Null
        Copy-Item $existingDll $preservedDll -Force
    }

    if (Test-Path $script:ModFolder) { Remove-Item $script:ModFolder -Recurse -Force }
    Copy-Item $script:ModSource $script:ModFolder -Recurse -Force

    # The packer output (PBO / unpacked addon) is produced into the fresh copy, so never ship
    # a PBO that happens to lie around in the source tree.
    Get-ChildItem (Join-Path $script:ModFolder "addons") -File -Filter "*.pbo" | Remove-Item -Force
    Get-ChildItem (Join-Path $script:ModFolder "addons") -Directory -Filter $script:AddonName | Remove-Item -Recurse -Force

    if ($Packer -eq "Auto") {
        # AddonBuilder (Arma 3 Tools) is the official packer and is used whenever it is
        # installed; PboBuilder is the fallback for machines without Arma 3 Tools.
        if ((Test-Path $script:PboBuilderProject) -and !(Find-AddonBuilder)) { $Packer = "PboBuilder" }
        else { $Packer = "AddonBuilder" }
    }

    if ($Packer -eq "PboBuilder" -and !(Test-Path $script:PboBuilderProject)) {
        throw "PboBuilder was requested but $script:PboBuilderProject does not exist."
    }

    $pbo = Join-Path $script:ModFolder "addons\$($script:AddonName).pbo"

    if ($NoPbo) {
        # Debugging aid only: an unpacked addon folder that can be edited in place.
        Write-Warn "-NoPbo: shipping the unpacked addon folder instead of $($script:AddonName).pbo."
        $addonFolder = Join-Path $script:ModFolder "addons\$($script:AddonName)"
        New-Item -ItemType Directory -Force -Path $addonFolder | Out-Null
        Copy-Item (Join-Path $script:AddonSource "config.cpp") $addonFolder -Force
        Copy-Item (Join-Path $script:AddonSource "functions") $addonFolder -Recurse -Force

        $pboJson = Join-Path $script:AddonSource "pbo.json"
        if (Test-Path $pboJson) { Copy-Item $pboJson $addonFolder -Force }
    }
    elseif (!$BuildPbo) {
        if (!(Test-Path $preservedPbo)) { throw "No cached PBO is available to reuse: $existingPbo" }
        Copy-Item $preservedPbo $pbo -Force
        Write-Ok "PBO unchanged; reused cached file ($pbo)"
    }
    elseif ($Packer -eq "AddonBuilder") {
        Write-Step "Packing addons\$($script:AddonName).pbo (Arma 3 Tools AddonBuilder)"

        # -packonly keeps the .sqf files (binarize drops them for a script-only addon) and
        # stores config.cpp as-is, exactly like the PBO that ships in the working @SqfReloader.
        $stage = Join-Path $script:DistDir "stage\$($script:AddonName)"
        if (Test-Path (Join-Path $script:DistDir "stage")) { Remove-Item (Join-Path $script:DistDir "stage") -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $stage | Out-Null

        Copy-Item (Join-Path $script:AddonSource "config.cpp") $stage -Force
        Copy-Item (Join-Path $script:AddonSource "functions") $stage -Recurse -Force

        Invoke-AddonBuilder -Source $stage -Output $pbo -Prefix $script:AddonName -AddonBuilder $AddonBuilder -KeyPath $KeyPath -Nobinarize | Out-Null
        Remove-Item (Join-Path $script:DistDir "stage") -Recurse -Force

        Assert-PboContainsScripts -PboPath $pbo -Prefix $script:AddonName
        Write-Ok "PBO: $pbo ($([Math]::Round((Get-Item $pbo).Length / 1KB, 1)) KB)"
    }
    else {
        Write-Step "Packing addons\$($script:AddonName).pbo (PboBuilder)"

        $output = Invoke-PboBuild -Source $script:AddonSource -Output $pbo `
            -Prefix $script:AddonName `
            -Exclude @("mod.cpp", "logo.paa", "*.pbo", "pbo.json")

        $output | ForEach-Object { if ("$_" -match "^Packed") { Write-Ok "$_" } }
        Assert-PboContainsScripts -PboPath $pbo -Prefix $script:AddonName
    }

    # The DLL goes in the mod ROOT: Arma resolves extension DLLs from the executable folder
    # or the mod root, never from a dll\ subfolder.
    $dllToCopy = if (Test-Path $DllPath) { $DllPath } elseif (Test-Path $preservedDll) { $preservedDll } else { throw "No DLL is available to package: $DllPath" }
    Copy-Item $dllToCopy (Join-Path $script:ModFolder $script:DllName) -Force

    if (Test-Path $preserved) { Remove-Item $preserved -Recurse -Force }

    Write-Ok "Mod created: $script:ModFolder"
}

function Write-ApiConfig {
    param(
        [int]$Port = 8764,
        [string]$HostName = "127.0.0.1",
        [string]$SourceDirectory = ""
    )

    $configDir = Join-Path $env:LOCALAPPDATA "SqfReloader"
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
