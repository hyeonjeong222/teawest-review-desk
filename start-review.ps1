$ErrorActionPreference = 'Stop'
$reviewRoot = $PSScriptRoot
$reviewUrl = 'http://127.0.0.1:4317'
$reviewReady = $false
try {
    $reviewSession = Invoke-RestMethod -Uri "$reviewUrl/api/session" -TimeoutSec 2
    $reviewReady = [bool]$reviewSession.csrf
} catch {}
if (-not $reviewReady) {
    if (-not (Test-Path -LiteralPath "$reviewRoot\node_modules\playwright-core")) {
        throw 'Run npm install in this folder first.'
    }
    New-Item -ItemType Directory -Path "$reviewRoot\.local" -Force | Out-Null
    $reviewNode = Join-Path $reviewRoot 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $reviewNode)) { $reviewNode = (Get-Command node -ErrorAction Stop).Source }
    Start-Process -FilePath $reviewNode -ArgumentList @('--env-file-if-exists=.env', 'src/server.js') -WorkingDirectory $reviewRoot -WindowStyle Hidden -RedirectStandardOutput "$reviewRoot\.local\server.log" -RedirectStandardError "$reviewRoot\.local\server-error.log" | Out-Null
    for ($reviewAttempt = 0; $reviewAttempt -lt 30; $reviewAttempt++) {
        Start-Sleep -Milliseconds 200
        try { $reviewSession = Invoke-RestMethod -Uri "$reviewUrl/api/session" -TimeoutSec 1; $reviewReady = [bool]$reviewSession.csrf; if ($reviewReady) { break } } catch {}
    }
    if (-not $reviewReady) { throw 'The review app did not start. Check .local/server-error.log.' }
}
Start-Process $reviewUrl
Write-Output "Review Desk: $reviewUrl"
