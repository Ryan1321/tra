param(
    [Parameter(Mandatory = $true)][string]$PrinterName,
    [ValidateSet('Letter', 'A4', 'Long')][string]$Paper = 'Letter',
    [ValidateRange(1, 10)][int]$Copies = 1,
    [ValidateSet('Receipt', 'Waybill')][string]$DocumentKind = 'Receipt',
    [string]$ImagePath,
    [switch]$CheckPrinter,
    [switch]$Print
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$document = $null
$bitmap = $null
try {
    Add-Type -AssemblyName System.Drawing
    if ((-not $Print -and -not $CheckPrinter) -or ($Print -and $CheckPrinter)) { throw 'Choose either printer validation or printing.' }
    if ($PrinterName -match 'citizen|label|zebra|dymo|pdf|onenote|xps|fax') { throw 'Choose the Epson document printer for this document.' }
    if (-not ([System.Drawing.Printing.PrinterSettings]::InstalledPrinters -contains $PrinterName)) { throw 'The selected receipt printer is not installed on this Windows PC.' }
    $document = New-Object System.Drawing.Printing.PrintDocument
    $document.PrinterSettings.PrinterName = $PrinterName
    if (-not $document.PrinterSettings.IsValid) { throw 'The selected receipt printer is unavailable.' }
    $document.DocumentName = 'Label Desk - Trust Receipt Agreement'
    if ($DocumentKind -eq 'Waybill') { $document.DocumentName = 'Label Desk - Waybill' }
    $document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
    $document.OriginAtMargins = $false
    $document.PrinterSettings.Copies = 1
    $document.PrinterSettings.PrintToFile = $false
    if ($document.PrinterSettings.CanDuplex) { $document.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Simplex }
    $document.DefaultPageSettings.Landscape = $false
    $document.DefaultPageSettings.Color = ($DocumentKind -eq 'Waybill' -and $document.PrinterSettings.SupportsColor)
    $document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
    $width = 850; $height = 1100
    if ($Paper -eq 'A4') { $width = 827; $height = 1169 }
    if ($Paper -eq 'Long') { $height = 1300 }
    $paperSize = @($document.PrinterSettings.PaperSizes | Where-Object { [Math]::Abs($_.Width - $width) -le 2 -and [Math]::Abs($_.Height - $height) -le 2 }) | Select-Object -First 1
    if (-not $paperSize) { $paperSize = New-Object System.Drawing.Printing.PaperSize($Paper, $width, $height) }
    $document.DefaultPageSettings.PaperSize = $paperSize

    function Assert-ReceiptPage($page) {
        if ([Math]::Abs($page.PaperSize.Width - $width) -gt 2 -or [Math]::Abs($page.PaperSize.Height - $height) -gt 2) {
            throw "The printer driver did not accept $Paper paper. Set the matching paper size in Windows Printing Preferences."
        }
        if ($page.PrintableArea.Width -lt 500 -or $page.PrintableArea.Height -lt 700) { throw 'The receipt printer printable area is too small. Check its paper settings.' }
    }
    $measurement = $document.PrinterSettings.CreateMeasurementGraphics($document.DefaultPageSettings, $false)
    try { Assert-ReceiptPage $document.DefaultPageSettings }
    finally { $measurement.Dispose() }

    if ($Print) {
        if (-not $ImagePath) { throw 'The rendered receipt is missing.' }
        $bitmap = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path)
        if ($bitmap.Width -ne 2550 -or $bitmap.Height -ne 3300) { throw 'The receipt must be a 300 DPI Letter-size image.' }
        $script:receiptPages = 0
        $document.add_PrintPage({
            param($sender, $eventArgs)
            Assert-ReceiptPage $eventArgs.PageSettings
            $area = $eventArgs.PageSettings.PrintableArea
            $scale = [Math]::Min(1.0, [Math]::Min($area.Width / 850.0, $area.Height / 1100.0))
            $drawWidth = 850 * $scale; $drawHeight = 1100 * $scale
            $x = $area.X - $eventArgs.PageSettings.HardMarginX + ($area.Width - $drawWidth) / 2
            $y = $area.Y - $eventArgs.PageSettings.HardMarginY + ($area.Height - $drawHeight) / 2
            $eventArgs.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Display
            $eventArgs.Graphics.PageScale = 1
            $eventArgs.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $eventArgs.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $destination = New-Object System.Drawing.RectangleF($x, $y, $drawWidth, $drawHeight)
            $source = New-Object System.Drawing.RectangleF(0, 0, $bitmap.Width, $bitmap.Height)
            $eventArgs.Graphics.DrawImage($bitmap, $destination, $source, [System.Drawing.GraphicsUnit]::Pixel)
            $script:receiptPages++
            $eventArgs.HasMorePages = $script:receiptPages -lt $Copies
        })
        $document.Print()
    }
    [pscustomobject]@{ ok = $true; submitted = [bool]$Print; printer = $PrinterName; paper = $Paper; copies = $Copies; fit = 'printable-area' } | ConvertTo-Json -Compress
}
catch { [pscustomobject]@{ error = $_.Exception.Message } | ConvertTo-Json -Compress; exit 1 }
finally { if ($bitmap) { $bitmap.Dispose() }; if ($document) { $document.Dispose() } }
