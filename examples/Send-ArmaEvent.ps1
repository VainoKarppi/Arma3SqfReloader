param(
    [Parameter(Mandatory = $true)]
    [string]$Function,

    [object[]]$Data = @(),

    [string]$ApiBaseUrl = "http://127.0.0.1:8764/api",
    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$uri = "$($ApiBaseUrl.TrimEnd('/'))/send"
$body = @{ function = $Function; data = @($Data) } | ConvertTo-Json -Depth 20

try {
    Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json" -Body $body -TimeoutSec $TimeoutSeconds
} catch {
    throw "Could not send the event to $uri. Confirm the event is registered in SQF and check the API port. $($_.Exception.Message)"
}
