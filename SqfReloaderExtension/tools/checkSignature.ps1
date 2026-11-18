<#
.SYNOPSIS
    Shows the Authenticode signature of a DLL (or of every DLL below a folder).

.DESCRIPTION
    Reports exactly what Windows, Smart App Control and BattlEye look at: the signature status, the
    signer and its issuer, the certificate chain root, the RFC 3161 timestamp, and whether the file
    is marked as downloaded (Mark-of-the-Web). Works on any Windows machine and needs no repo.

    Exit code: 0 = every file is signed and valid, 1 = at least one file is unsigned or invalid,
    2 = a path was not found.

.PARAMETER Path
    DLL or EXE to inspect, or a folder (every *.dll and *.exe below it is checked).

.EXAMPLE
    .\checkSignature.ps1 "E:\SteamLibrary\steamapps\common\Arma 3\@SqfReloader\SqfReloader_x64.dll"

.EXAMPLE
    .\checkSignature.ps1 "E:\SteamLibrary\steamapps\common\Arma 3\@SqfReloader"

.EXAMPLE
    .\checkSignature.ps1 .\SqfReloaderExtension\dist\@SqfReloader\SqfReloader_x64.dll
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0, ValueFromPipeline)]
    [string[]]$Path
)

$ErrorActionPreference = "Stop"

function Write-Label([string]$Label, [string]$Value, [string]$Color = "Gray") {
    Write-Host ("    {0,-19}: {1}" -f $Label, $Value) -ForegroundColor $Color
}

function Get-Chain([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
    $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
    try {
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        [void]$chain.Build($Certificate)
        return @{
            Root  = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
            Count = $chain.ChainElements.Count
        }
    }
    finally {
        $chain.Dispose()
    }
}

function Show-Signature {
    param([string]$File)

    Write-Host ""
    Write-Host "==> $File" -ForegroundColor Cyan

    $signature = Get-AuthenticodeSignature -LiteralPath $File
    $status = "$($signature.Status)"
    $version = (Get-Item -LiteralPath $File).VersionInfo.FileVersion

    $color = switch ($status) {
        "Valid" { "Green" }
        "NotSigned" { "Red" }
        default { "Yellow" }
    }

    Write-Label "Version" $version "Green"
    Write-Label "Signature" $status $color
    Write-Label "File size" ("{0:N0} bytes" -f (Get-Item -LiteralPath $File).Length)
    Write-Label "SHA256" (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash

    # The Mark-of-the-Web is an alternate data stream, not a path; Test-Path rejects the syntax.
    $mark = if (Get-Item -LiteralPath $File -Stream "Zone.Identifier" -ErrorAction SilentlyContinue) { "present (marked as downloaded)" } else { "none" }
    Write-Label "Mark-of-the-Web" $mark

    $verdict = ""

    if ($signature.SignerCertificate) {
        Write-Label "Signer" $signature.SignerCertificate.Subject
        Write-Label "Issuer" $signature.SignerCertificate.Issuer
        Write-Label "Not after" $signature.SignerCertificate.NotAfter.ToString("yyyy-MM-dd")

        $chain = Get-Chain $signature.SignerCertificate
        Write-Label "Chain root" $chain.Root.Subject
        if ($chain.Count -le 1) {
            Write-Label "Warning" "the signing certificate is self-signed: Smart App Control only accepts certificates that chain to a Microsoft Trusted Root CA" "Yellow"
        }
    }

    if ($signature.TimeStamperCertificate) {
        Write-Label "Timestamp" $signature.TimeStamperCertificate.Subject
    }

    $verdict = if ($status -eq "Valid") {
        if ($signature.TimeStamperCertificate) {
            "Signed and valid on this machine."
        }
        else {
            "Signed and valid on this machine, but without a timestamp: the signature stops validating when the certificate expires."
        }
    }
    elseif (!$signature.SignerCertificate) {
        "No signature. Smart App Control and BattlEye refuse an unsigned extension; sign the build with tools\build.ps1 -SignThumbprint/-SignPfx/-SignMetadata."
    }
    elseif ("$($signature.StatusMessage)" -match "not trusted by the trust provider") {
        "Signed, but the certificate chain is not trusted on this machine (self-signed, or its root is not installed). Smart App Control ignores such certificates."
    }
    elseif ($status -eq "HashMismatch") {
        "The file was modified after it was signed; sign the built DLL again."
    }
    else {
        "Signature reports $status - see Details below."
    }

    Write-Label "Verdict" $verdict $color

    if ($status -ne "Valid" -and $status -ne "NotSigned" -and $signature.StatusMessage) {
        Write-Label "Details" $signature.StatusMessage
    }

    return $status
}

$targets = New-Object System.Collections.Generic.List[string]
$missing = $false

foreach ($item in $Path) {
    if (Test-Path -LiteralPath $item -PathType Container) {
        $found = @(Get-ChildItem -LiteralPath $item -Recurse -File | Where-Object { $_.Extension -in ".dll", ".exe" })
        if ($found.Count -eq 0) {
            Write-Host "No *.dll or *.exe below $item" -ForegroundColor Yellow
        }
        $found | ForEach-Object { $targets.Add($_.FullName) }
    }
    elseif (Test-Path -LiteralPath $item) {
        $targets.Add((Resolve-Path -LiteralPath $item).Path)
    }
    else {
        Write-Host "Not found: $item" -ForegroundColor Red
        $missing = $true
    }
}

$unsigned = 0
$checked = 0

foreach ($target in $targets) {
    $checked++
    if ((Show-Signature -File $target) -ne "Valid") { $unsigned++ }
}

if ($checked -gt 0) {
    Write-Host ""
    if ($unsigned -eq 0) {
        Write-Host "$checked file(s) checked: all signed and valid." -ForegroundColor Green
    }
    else {
        Write-Host "$checked file(s) checked: $unsigned not signed or not valid." -ForegroundColor Red
    }
}

if ($missing) { exit 2 }
if ($unsigned -gt 0 -or $checked -eq 0) { exit 1 }
exit 0
