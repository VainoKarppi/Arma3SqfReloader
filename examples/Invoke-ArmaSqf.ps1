param(
    [Parameter(Mandatory = $true)]
    [string]$Code,

    [ValidateRange(1, 300)]
    [int]$TimeoutSeconds = 30,

    [string]$ApiBaseUrl = "http://127.0.0.1:8764/api"
)

$ErrorActionPreference = "Stop"
$api = $ApiBaseUrl.TrimEnd('/')
$uri = "$api/execute"
$body = @{ code = $Code; timeoutMs = $TimeoutSeconds * 1000 } | ConvertTo-Json -Depth 20

try {
    $accepted = Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json" -Body $body -TimeoutSec $TimeoutSeconds
    $requestId = $accepted.requestId
    if (-not $requestId) { throw "The API did not return an execution request ID." }

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 200
        $result = Invoke-RestMethod -Uri "$api/result/$requestId" -Method Get -TimeoutSec $TimeoutSeconds
        if ($result.pending) { continue }
        if (-not $result.success) {
            if ($result.error) { throw $result.error }
            throw "Arma execution failed."
        }
        return $result.result
    }

    throw "Arma did not return a result within $TimeoutSeconds seconds."
} catch {
    throw "SQF execution at $uri failed: $($_.Exception.Message)"
}
