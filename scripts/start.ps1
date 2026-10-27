param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
try {
    $projectPath = Split-Path -Parent $PSScriptRoot
    $dataPath = Join-Path $projectPath 'data'
    $serverPath = Join-Path $projectPath 'server.js'
    $portNumber = 4173
    if ($env:PORT) { $portNumber = [int]$env:PORT }
    $serviceUrl = "http://localhost:$portNumber"
    $healthUrl = "http://127.0.0.1:$portNumber/api/status"
    $existing = $null
    try { $existing = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5 } catch {}
    if ($existing -and $existing.service -eq 'citizen-mobile-labels') {
        Write-Output "Printing service is already running: $serviceUrl"
    }
    else {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if (-not $nodeCommand) { throw 'Install Node.js 22 or newer, then open Start Printing again. See README.md.' }
        New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
        $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList @(('"' + $serverPath + '"')) -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'server.log') -RedirectStandardError (Join-Path $dataPath 'server-error.log') -PassThru
        [System.IO.File]::WriteAllText((Join-Path $dataPath 'server.pid'), [string]$process.Id)
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 500
            if ($process.HasExited) { throw ('Service could not start. ' + (Get-Content -LiteralPath (Join-Path $dataPath 'server-error.log') -Raw)) }
            try {
                $status = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
                if ($status.service -eq 'citizen-mobile-labels') { $ready = $true; break }
            } catch {}
        }
        if (-not $ready) { throw 'The service did not become ready. Check data/server-error.log.' }
        Write-Output "Printing service started: $serviceUrl"
    }
    if (-not $NoBrowser) { Start-Process ($serviceUrl + '/dashboard') }
}
catch { Write-Error $_.Exception.Message; exit 1 }
