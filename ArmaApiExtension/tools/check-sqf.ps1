# SQF syntax gate.
#
# Arma cannot be started in CI, so this checks the things that are cheap and reliable
# to verify without the engine:
#   * balanced parentheses, brackets and braces outside strings and comments,
#   * unterminated string literals,
#   * every "call ArmaApi_fnc_x" / config "file" target exists,
#   * every class declared in CfgFunctions maps to an existing fn_<name>.sqf.
#
# Usage: powershell -ExecutionPolicy Bypass -File tools\check-sqf.ps1 [-Path addons\armaapi]

param(
    [string]$Path = ""
)

$ErrorActionPreference = "Stop"

$root = if ($Path) { (Convert-Path $Path) } else { (Convert-Path (Join-Path $PSScriptRoot "..\addons\armaapi")) }
if (!(Test-Path $root)) { Write-Host "Path not found: $root" -ForegroundColor Red; exit 2 }
$root = $root.TrimEnd('\')
$errors = New-Object System.Collections.Generic.List[string]

function Test-Balance([string]$file, [string]$text) {
    $stack = New-Object System.Collections.Generic.Stack[char]
    $line = 1
    $inString = $false
    $inLineComment = $false
    $blockComment = 0

    for ($i = 0; $i -lt $text.Length; $i++) {
        $c = $text[$i]

        if ($c -eq "`n") { $line++; $inLineComment = $false; continue }
        if ($inLineComment) { continue }

        if ($blockComment -gt 0) {
            if ($c -eq '*' -and $i + 1 -lt $text.Length -and $text[$i + 1] -eq '/') { $blockComment--; $i++ }
            continue
        }

        if ($inString) {
            if ($c -eq '"') {
                if ($i + 1 -lt $text.Length -and $text[$i + 1] -eq '"') { $i++; continue }
                $inString = $false
            }
            continue
        }

        if ($c -eq '/' -and $i + 1 -lt $text.Length) {
            if ($text[$i + 1] -eq '*') { $blockComment++; $i++; continue }
            if ($text[$i + 1] -eq '/') { $inLineComment = $true; $i++; continue }
        }

        # #include lines and preprocessor directives are not SQF.
        if ($c -eq '#' -and ($i -eq 0 -or $text[$i - 1] -eq "`n")) { $inLineComment = $true; continue }

        if ($c -eq '"') { $inString = $true; continue }

        if ($c -in @('(', '[', '{')) { $stack.Push($c); continue }

        if ($c -in @(')', ']', '}')) {
            if ($stack.Count -eq 0) { $errors.Add("$file`:$line - unexpected '$c'"); return }
            $open = $stack.Pop()
            $expected = switch ($c) { ')' { '(' } ']' { '[' } '}' { '{' } }
            if ($open -ne $expected) { $errors.Add("$file`:$line - '$c' closes '$open'"); return }
        }
    }

    if ($inString) { $errors.Add("$file - unterminated string literal") }
    if ($stack.Count -gt 0) { $errors.Add("$file - $($stack.Count) unclosed '$($stack.Peek())'") }
}

$sqfFiles = Get-ChildItem $root -Recurse -File | Where-Object { $_.Extension -in ".sqf", ".cpp", ".hpp", ".ext" }

foreach ($file in $sqfFiles) {
    $relative = $file.FullName
    if ($relative.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relative = $relative.Substring($root.Length).TrimStart('\')
    }

    Test-Balance $relative ([IO.File]::ReadAllText($file.FullName))
}

# CfgFunctions cross-check
$config = Join-Path $root "config.cpp"
if (Test-Path $config) {
    $configText = Get-Content $config -Raw
    $currentFolder = $null
    $seenFunctions = New-Object System.Collections.Generic.HashSet[string]

    foreach ($rawLine in $configText -split "`n") {
        $line = $rawLine.Trim()

        if ($line -match '^file\s*=\s*"([^"]+)"') {
            # CfgFunctions paths are relative to the PBO root, which is this folder.
            $currentFolder = $Matches[1].Replace('\', '/')
            continue
        }

        if ($line -match '^class\s+(\w+)\s*\{\s*recompile\s*=\s*1') {
            $functionName = $Matches[1]
            if (!$currentFolder) { continue }

            $expected = Join-Path (Join-Path $root ($currentFolder.Replace('/', '\'))) "fn_$functionName.sqf"
            if (!(Test-Path $expected)) {
                $errors.Add("config.cpp class $functionName expects fn_$functionName.sqf in $currentFolder")
            }
            elseif ($seenFunctions.Contains($functionName)) {
                $errors.Add("config.cpp declares class $functionName more than once")
            }
            else {
                $seenFunctions.Add($functionName) | Out-Null
            }
        }
    }
}

if ($errors.Count -gt 0) {
    Write-Host "SQF check FAILED:" -ForegroundColor Red
    $errors | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}

Write-Host "SQF check passed ($($sqfFiles.Count) files)." -ForegroundColor Green
exit 0
