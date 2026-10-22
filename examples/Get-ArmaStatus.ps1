param(
    [string]$ApiBaseUrl = "http://127.0.0.1:8764/api",
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$uri = "$($ApiBaseUrl.TrimEnd('/'))/status"

try {
    Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec $TimeoutSeconds
} catch {
    throw "Could not query SqfReloader at $uri. Start Arma with @SqfReloader and check its API port. $($_.Exception.Message)"
}
