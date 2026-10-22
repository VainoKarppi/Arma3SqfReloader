param(
    [string]$ApiBaseUrl = "http://127.0.0.1:8764/api",
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$uri = "$($ApiBaseUrl.TrimEnd('/'))/functions"

try {
    $response = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec $TimeoutSeconds
    $response.functions
} catch {
    throw "Could not list SqfReloader functions at $uri. Start Arma with @SqfReloader and check its API port. $($_.Exception.Message)"
}
