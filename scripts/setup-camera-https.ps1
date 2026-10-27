param([string]$DataDirectory = '', [string]$OpenSslPath = '')
$ErrorActionPreference = 'Stop'

# Creates local certificate files only. Installing the public CA on a phone is
# a separate, visible Android Settings action; this script changes no trust store.
$projectPath = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $DataDirectory) { $DataDirectory = Join-Path $projectPath 'data' }
$dataPath = [IO.Path]::GetFullPath($DataDirectory)
if (-not $dataPath.StartsWith($projectPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The certificate directory must be inside this printing app workspace.'
}
$tlsPath = Join-Path $dataPath 'tls'
if (-not $OpenSslPath) {
    $OpenSslPath = @('C:\xampp\apache\bin\openssl.exe', 'C:\xampp\php\extras\openssl\openssl.exe') | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $OpenSslPath) { throw 'OpenSSL was not found in XAMPP. Run this script with -OpenSslPath pointing to openssl.exe.' }

function Invoke-CameraOpenSsl([string[]]$Arguments) {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $OpenSslPath @Arguments 2>&1
    $commandExitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedPreference
    if ($commandExitCode -ne 0) { throw ('OpenSSL failed: ' + ($output -join [Environment]::NewLine)) }
    return ($output -join [Environment]::NewLine)
}

New-Item -ItemType Directory -Path $tlsPath -Force | Out-Null
# Allow the app's Windows owner to start the service even when setup is run
# from an isolated development account. Do not grant the general Users group.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$workspaceOwner = (Get-Acl -LiteralPath $projectPath).GetOwner([Security.Principal.SecurityIdentifier])
$systemIdentity = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$directoryAcl = [IO.Directory]::GetAccessControl($tlsPath, [Security.AccessControl.AccessControlSections]::Access)
$directoryAcl.SetAccessRuleProtection($true, $false)
foreach ($existingRule in @($directoryAcl.Access)) { $directoryAcl.RemoveAccessRuleSpecific($existingRule) }
foreach ($principal in @($identity, $workspaceOwner, $systemIdentity) | Sort-Object -Property Value -Unique) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $directoryAcl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($tlsPath, $directoryAcl)

$stagePath = Join-Path $tlsPath ('setup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagePath | Out-Null
try {
    $caCertificate = Join-Path $tlsPath 'ca.crt'
    $caKey = Join-Path $tlsPath 'ca.key'
    if ((Test-Path -LiteralPath $caCertificate) -xor (Test-Path -LiteralPath $caKey)) {
        throw 'The existing camera CA is incomplete. Restore its matching ca.crt and ca.key before continuing; it was not replaced.'
    }
    if (-not (Test-Path -LiteralPath $caCertificate)) {
        $caConfig = @'
[req]
prompt = no
distinguished_name = name
x509_extensions = ca_extensions
[name]
CN = Citizen Labels Local Camera
O = Local Printing App
[ca_extensions]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
nameConstraints = critical,permitted;DNS:localhost,permitted;IP:127.0.0.0/255.0.0.0,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0,permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:169.254.0.0/255.255.0.0,permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
'@
        $caConfigPath = Join-Path $stagePath 'ca.cnf'
        [IO.File]::WriteAllText($caConfigPath, $caConfig, [Text.Encoding]::ASCII)
        $newCaKey = Join-Path $stagePath 'ca.key'
        $newCaCertificate = Join-Path $stagePath 'ca.crt'
        Invoke-CameraOpenSsl @('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1095', '-config', $caConfigPath, '-keyout', $newCaKey, '-out', $newCaCertificate) | Out-Null
        Move-Item -LiteralPath $newCaKey -Destination $caKey
        Move-Item -LiteralPath $newCaCertificate -Destination $caCertificate
    }
    # Keep the same CA so existing phones do not need to trust a new issuer.
    Invoke-CameraOpenSsl @('x509', '-checkend', '34300800', '-noout', '-in', $caCertificate) | Out-Null
    $addresses = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object { $_.OperationalStatus -eq [Net.NetworkInformation.OperationalStatus]::Up } |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        Where-Object { $_.Address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork } |
        ForEach-Object { $_.Address.IPAddressToString } |
        Where-Object { $_ -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)' } |
        Sort-Object -Unique)
    $sans = @('DNS:localhost', 'IP:127.0.0.1', 'IP:::1') + @($addresses | ForEach-Object { 'IP:' + $_ })
    $leafConfig = @"
[req]
prompt = no
distinguished_name = name
[name]
CN = Citizen Labels Camera
O = Local Printing App
[server_extensions]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = $($sans -join ',')
"@
    $leafConfigPath = Join-Path $stagePath 'server.cnf'
    [IO.File]::WriteAllText($leafConfigPath, $leafConfig, [Text.Encoding]::ASCII)
    $newKey = Join-Path $stagePath 'server.key'
    $requestPath = Join-Path $stagePath 'server.csr'
    $newCertificate = Join-Path $stagePath 'server.crt'
    Invoke-CameraOpenSsl @('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-config', $leafConfigPath, '-keyout', $newKey, '-out', $requestPath) | Out-Null
    $serial = '0x' + [Guid]::NewGuid().ToString('N')
    Invoke-CameraOpenSsl @('x509', '-req', '-in', $requestPath, '-CA', $caCertificate, '-CAkey', $caKey, '-set_serial', $serial, '-days', '397', '-sha256', '-extfile', $leafConfigPath, '-extensions', 'server_extensions', '-out', $newCertificate) | Out-Null
    Invoke-CameraOpenSsl @('verify', '-CAfile', $caCertificate, '-purpose', 'sslserver', '-verify_hostname', 'localhost', $newCertificate) | Out-Null
    foreach ($address in $addresses) {
        Invoke-CameraOpenSsl @('verify', '-CAfile', $caCertificate, '-purpose', 'sslserver', '-verify_ip', $address, $newCertificate) | Out-Null
    }
    Move-Item -LiteralPath $newKey -Destination (Join-Path $tlsPath 'server.key') -Force
    Move-Item -LiteralPath $newCertificate -Destination (Join-Path $tlsPath 'server.crt') -Force
    Write-Output 'Camera HTTPS certificates are ready. Restart the printing service to use them.'
    Write-Output 'Open the Trust Receipt page on your phone for the one-time certificate setup.'
    Write-Output (Invoke-CameraOpenSsl @('x509', '-in', $caCertificate, '-noout', '-sha256', '-fingerprint'))
    $cameraPort = 4175
    if ($env:HTTPS_PORT) { $cameraPort = [int]$env:HTTPS_PORT }
    foreach ($address in $addresses) { Write-Output "Phone camera: https://${address}:$cameraPort/tra" }
}
finally {
    $absoluteStage = [IO.Path]::GetFullPath($stagePath)
    $absoluteTls = [IO.Path]::GetFullPath($tlsPath)
    if (-not $absoluteStage.StartsWith($absoluteTls + '\setup-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected certificate staging directory; cleanup stopped.' }
    if (Test-Path -LiteralPath $absoluteStage) { Remove-Item -LiteralPath $absoluteStage -Recurse -Force }
}
