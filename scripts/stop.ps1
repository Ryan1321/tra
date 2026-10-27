param()
$ErrorActionPreference = 'Stop'
try {
    $projectPath = Split-Path -Parent $PSScriptRoot
    $pidPath = Join-Path $projectPath 'data\server.pid'
    $serverPath = Join-Path $projectPath 'server.js'
    if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output 'No service started by this launcher was found.'; exit 0 }
    $serviceProcessId = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $serviceProcessId"
    if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine.Contains($serverPath)) {
        Stop-Process -Id $serviceProcessId
        Write-Output 'Printing service stopped.'
    }
    elseif ($process) { throw 'The recorded process is not this printing service. It was left running.' }
    else { Write-Output 'Printing service is already stopped.' }
    Remove-Item -LiteralPath $pidPath -Force
}
catch { Write-Error $_.Exception.Message; exit 1 }
