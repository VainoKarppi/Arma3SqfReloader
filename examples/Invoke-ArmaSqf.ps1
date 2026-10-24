param(
    [Parameter(Mandatory = $true)]
    [string]$Code,

    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30,

    [string]$ApiBaseUrl = "http://127.0.0.1:8764/api"
)

$ErrorActionPreference = "Stop"
$api = $ApiBaseUrl.TrimEnd('/')
$uri = "$api/eval"
$body = @{ code = $Code; timeoutMs = $TimeoutSeconds * 1000 } | ConvertTo-Json -Depth 20

try {
    $response = Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json" -Body $body -TimeoutSec ($TimeoutSeconds + 5)
    if (-not $response.success) {
        if ($response.error) { throw $response.error }
        throw "Arma execution failed."
    }
    return $response.result
} catch {
    throw "SQF execution at $uri failed: $($_.Exception.Message)"
}
