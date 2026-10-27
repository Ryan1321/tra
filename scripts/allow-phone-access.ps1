# Run as Administrator if Windows Firewall blocks your phone.
# Allows only local subnet devices on a Windows Private network.
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$nodePath = (Get-Command node.exe).Source
$portNumber = 4173
if ($env:PORT) { $portNumber = [int]$env:PORT }
$securePort = 4175
if ($env:HTTPS_PORT) { $securePort = [int]$env:HTTPS_PORT }
foreach ($allowedPort in @($portNumber, $securePort) | Select-Object -Unique) {
    if ($allowedPort -lt 1024 -or $allowedPort -gt 65535) { throw 'Printing and camera ports must be between 1024 and 65535.' }
    $ruleName = "CitizenMobileLabels-$allowedPort"
    if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name $ruleName -DisplayName "Citizen mobile labels and camera ($allowedPort)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $allowedPort -Program $nodePath -RemoteAddress LocalSubnet -Profile Private | Out-Null
    }
}
Write-Output "Phone access is allowed on private local networks, ports $portNumber and $securePort."
