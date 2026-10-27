param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
    Add-Type -AssemblyName System.Drawing
    $settings = New-Object System.Drawing.Printing.PrinterSettings
    $printers = @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters | ForEach-Object {
        [pscustomobject]@{ name = [string]$_; isDefault = ([string]$_ -eq $settings.PrinterName) }
    })
    [pscustomobject]@{ printers = $printers } | ConvertTo-Json -Depth 4 -Compress
}
catch {
    [pscustomobject]@{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
