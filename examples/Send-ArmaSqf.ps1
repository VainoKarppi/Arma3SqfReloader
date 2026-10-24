param(
    [Parameter(Mandatory = $true)]
    [string]$Code,

    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30,

    [string]$ApiBaseUrl = "http://127.0.0.1:8764/api"
)

$ErrorActionPreference = "Stop"
$uri = "$($ApiBaseUrl.TrimEnd('/'))/execute"
$body = @{ code = $Code } | ConvertTo-Json -Depth 20

try {
    Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json" -Body $body -TimeoutSec $TimeoutSeconds
} catch {
    throw "SQF execution request at $uri failed: $($_.Exception.Message)"
}
