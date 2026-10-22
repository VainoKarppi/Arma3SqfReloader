param(
    [string[]]$FunctionName = @(),
    [string]$ApiBaseUrl = "http://127.0.0.1:8764/api",
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$uri = "$($ApiBaseUrl.TrimEnd('/'))/reload"
$bodyObject = if ($FunctionName.Count -gt 0) {
    @{ functions = $FunctionName }
} else {
    @{}
}
$body = $bodyObject | ConvertTo-Json -Depth 10

try {
    Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json" -Body $body -TimeoutSec $TimeoutSeconds
} catch {
    throw "Could not request a function reload from $uri. Start Arma with @SqfReloader and check its API port. $($_.Exception.Message)"
}
