param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [string]$OutputPath,
    [string]$PreparedImagePath,
    [switch]$Print,
    [switch]$CheckPrinter,
    [string]$PrinterName
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$bitmap = $null
$graphics = $null
$document = $null
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$timings = [ordered]@{}

function New-LabelFont([single]$Pixels, [bool]$Bold = $false) {
    $style = [System.Drawing.FontStyle]::Regular
    if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
    return New-Object System.Drawing.Font('Arial', $Pixels, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Get-LineWidth([string]$Text, [System.Drawing.Font]$Font) {
    $format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
    try {
        $format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces
        return $graphics.MeasureString($Text, $Font, 10000, $format).Width
    }
    finally { $format.Dispose() }
}

function Draw-FittedLine([string]$Text, [string]$Field, [single]$X, [single]$Y, [single]$Width, [single]$Height, [single]$LargestFont, [single]$SmallestFont, [bool]$Bold = $false, [System.Drawing.StringAlignment]$Alignment = [System.Drawing.StringAlignment]::Center) {
    $font = $null
    try {
        for ($size = $LargestFont; $size -ge $SmallestFont; $size -= 1) {
            if ($font) { $font.Dispose() }
            $font = New-LabelFont $size $Bold
            if ((Get-LineWidth $Text $font) -le $Width) { break }
        }
        if ($size -lt $SmallestFont) { throw "$Field is too long to fit this sticker. Shorten it and try again." }
        $format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
        try {
            $format.Alignment = $Alignment
            $format.LineAlignment = [System.Drawing.StringAlignment]::Center
            $format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::NoWrap
            $format.Trimming = [System.Drawing.StringTrimming]::None
            $rect = New-Object System.Drawing.RectangleF($X, $Y, $Width, $Height)
            $graphics.DrawString($Text, $font, [System.Drawing.Brushes]::Black, $rect, $format)
        }
        finally { $format.Dispose() }
    }
    finally { if ($font) { $font.Dispose() } }
}

function Draw-ProductName([string]$Text) {
    $font = $null
    try {
        $lines = @()
        $largestNameFont = 28; $smallestNameFont = 22
        if ($compact) { $largestNameFont = 26; $smallestNameFont = 20 }
        for ($size = $largestNameFont; $size -ge $smallestNameFont; $size -= 1) {
            if ($font) { $font.Dispose() }
            $font = New-LabelFont $size $true
            $lines = @()
            $line = ''
            $fits = $true
            foreach ($word in ($Text -split '\s+')) {
                if ((Get-LineWidth $word $font) -gt ($labelWidth - 24)) { $fits = $false; break }
                $candidate = $word
                if ($line) { $candidate = "$line $word" }
                if ((Get-LineWidth $candidate $font) -le ($labelWidth - 24)) { $line = $candidate }
                else { $lines += $line; $line = $word }
            }
            if ($line) { $lines += $line }
            if ($fits -and $lines.Count -le 2) { break }
        }
        if (-not $fits -or $lines.Count -gt 2) { throw 'Product name is too long for two readable lines on this sticker. Shorten it and try again.' }
        $lineHeight = 33
        $startY = 72
        if ($lines.Count -eq 1) { $startY += 16 }
        foreach ($line in $lines) {
            Draw-FittedLine $line 'Product name' 12 $startY ($labelWidth - 24) $lineHeight $size $size $true
            $startY += $lineHeight
        }
    }
    finally { if ($font) { $font.Dispose() } }
}

function Assert-PrinterPage($Page) {
    if ([Math]::Abs($Page.Width - $paperWidth) -gt 1 -or [Math]::Abs($Page.Height - $paperHeight) -gt 1) {
        throw "The printer driver did not accept the $($paperWidth / 100) x $($paperHeight / 100) inch row for two stickers. Set the matching two-column label stock in Windows Printing Preferences and retry."
    }
    if ([Math]::Abs($Page.DpiX - 300) -gt 1 -or [Math]::Abs($Page.DpiY - 300) -gt 1) {
        throw "The driver is using $($Page.DpiX) x $($Page.DpiY) DPI. Select the Citizen 300 DPI driver before printing."
    }
    $area = $Page.PrintableArea
    $epsilon = 0.2
    if ($area.Width -le 0 -or $area.Height -le 0 -or
        $area.Left -gt ($inkBounds.Left + $epsilon) -or $area.Top -gt ($inkBounds.Top + $epsilon) -or
        $area.Right -lt ($inkBounds.Right - $epsilon) -or $area.Bottom -lt ($inkBounds.Bottom - $epsilon)) {
        throw 'The Windows driver printable area would clip the sticker pair. Select the matching two-column label stock and correct margins in Printing Preferences, then retry.'
    }
}

try {
    Add-Type -AssemblyName System.Drawing
    if (-not $OutputPath -and -not $Print -and -not $CheckPrinter) { throw 'Specify -OutputPath to render a preview, -CheckPrinter to check printer setup, or -Print to print a label.' }
    $request = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $InputPath).Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $layout = $request.layout
    if ($null -eq $layout -or $layout.version -notin @('paired-v3', 'paired-1p25x1-v1')) {
        throw 'Choose one of the supported paired sticker layouts.'
    }
    $compact = $layout.version -eq 'paired-1p25x1-v1'
    $labelWidth = 438; $pageWidth = 900; $rightX = 450
    if ($compact) { $labelWidth = 363; $pageWidth = 750; $rightX = 375 }
    $labelHeight = 300; $pageHeight = 300
    $paperWidth = [int]($pageWidth / 3); $paperHeight = [int]($pageHeight / 3)
    if ($request.widthDots -ne $pageWidth -or $request.heightDots -ne $pageHeight -or $request.dpi -ne 300 -or
        $layout.paperWidthDots -ne $pageWidth -or $layout.paperHeightDots -ne $pageHeight -or
        $layout.templateWidthDots -ne $labelWidth -or $layout.templateHeightDots -ne $labelHeight -or
        $layout.leftX -ne 12 -or $layout.rightX -ne $rightX -or $layout.topY -ne 0) {
        throw 'The sticker dimensions and positions must match the selected 300 DPI layout.'
    }
    foreach ($offset in @('leftX', 'rightX', 'topY')) {
        if (($layout.$offset -isnot [int] -and $layout.$offset -isnot [long]) -or $layout.$offset -lt 0) {
            throw 'Sticker positions must be non-negative whole printer dots.'
        }
    }
    if ($layout.leftX + $layout.templateWidthDots -gt $layout.rightX -or
        $layout.rightX + $layout.templateWidthDots -gt $layout.paperWidthDots -or
        $layout.topY + $layout.templateHeightDots -gt $layout.paperHeightDots) {
        throw 'The two stickers must fit within the page without overlapping.'
    }
    $copies = 1
    if ($null -ne $request.copies) {
        if (($request.copies -isnot [int] -and $request.copies -isnot [long]) -or $request.copies -lt 1 -or $request.copies -gt 100) {
            throw 'Copies must be a whole number from 1 to 100.'
        }
        $copies = [int]$request.copies
    }
    foreach ($field in @('price', 'productName', 'sku', 'barcode')) {
        $value = $request.fields.$field
        if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { throw "The $field field is required." }
        if ($value -match '[\x00-\x1F\x7F]') { throw "The $field field must be a single line without control characters." }
    }
    $moduleWidth = $request.barcode.moduleWidth
    $quietZone = $request.barcode.quietZone
    if (($moduleWidth -isnot [int] -and $moduleWidth -isnot [long]) -or $moduleWidth -lt 2) {
        throw 'Barcode moduleWidth must be a whole number of at least 2 dots.'
    }
    if (($quietZone -isnot [int] -and $quietZone -isnot [long] -and $quietZone -isnot [double] -and $quietZone -isnot [decimal]) -or
        [double]::IsNaN([double]$quietZone) -or [double]::IsInfinity([double]$quietZone) -or $quietZone -lt 0) {
        throw 'Barcode side padding must be a non-negative number of modules.'
    }
    $modules = @($request.barcode.modules)
    if ($modules.Count -lt 7 -or $modules.Count % 2 -ne 1) { throw 'The encoded barcode must contain an odd number of alternating runs.' }
    $moduleTotal = 0
    foreach ($run in $modules) {
        if ($run -isnot [int] -and $run -isnot [long]) { throw 'Barcode runs must be whole numbers from 1 to 4.' }
        if ($run -lt 1 -or $run -gt 4) { throw 'Barcode runs must be whole numbers from 1 to 4.' }
        $moduleTotal += $run
    }
    $fullBarcodeWidth = ($moduleTotal + 2 * $quietZone) * $moduleWidth
    if ($fullBarcodeWidth -ne [Math]::Floor($fullBarcodeWidth)) { throw 'Barcode width including padding must use whole printer dots.' }
    if ($fullBarcodeWidth -gt $labelWidth) { throw 'Barcode is too wide for this sticker at a readable bar width. Use a shorter barcode value.' }

    if ($PreparedImagePath) {
        # Only the service supplies this local image, after validating and
        # rendering these same fields. No client image/path reaches this worker.
        $bitmap = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $PreparedImagePath).Path)
        if ($bitmap.Width -ne $pageWidth -or $bitmap.Height -ne $pageHeight -or
            [Math]::Abs($bitmap.HorizontalResolution - 300) -gt 1 -or [Math]::Abs($bitmap.VerticalResolution - 300) -gt 1) {
            throw "The prepared sticker image must be $pageWidth x $pageHeight pixels at 300 DPI."
        }
    }
    else {
        $bitmap = New-Object System.Drawing.Bitmap($pageWidth, $pageHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $bitmap.SetResolution(300, 300)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([System.Drawing.Color]::White)
        $graphics.PageUnit = [System.Drawing.GraphicsUnit]::Pixel
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::None

        # Template 1 comes from the original BarTender embedded preview. The crop
        # removes only its gray preview surround and one-pixel page outline.
        $artworkPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'reference\template-preview-1.png'
        $artwork = [System.Drawing.Image]::FromFile($artworkPath)
        $croppedArtwork = $null
        $artworkAttributes = $null
        try {
            if ($artwork.Width -ne 762 -or $artwork.Height -ne 762) { throw 'The original Template 1 artwork has unexpected dimensions.' }
            # Crop before resampling so the gray editor surround cannot bleed into
            # the printed sticker. The stored artwork itself remains untouched.
            $croppedArtwork = $artwork.Clone((New-Object System.Drawing.Rectangle(1, 121, 760, 521)), [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $artworkAttributes = New-Object System.Drawing.Imaging.ImageAttributes
            $artworkAttributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
            $artworkHeight = $labelHeight; $artworkY = [int]$layout.topY
            if ($compact) {
                # Fit the fixed logo artwork to the narrower sticker without
                # stretching the logo or the food-safe mark.
                $artworkHeight = [int][Math]::Round($labelWidth * 521.0 / 760.0)
                $artworkY += [int][Math]::Floor(($labelHeight - $artworkHeight) / 2)
            }
            $graphics.DrawImage($croppedArtwork,
                (New-Object System.Drawing.Rectangle([int]$layout.leftX, $artworkY, $labelWidth, $artworkHeight)),
                0, 0, 760, 521, [System.Drawing.GraphicsUnit]::Pixel, $artworkAttributes)
        }
        finally {
            if ($artworkAttributes) { $artworkAttributes.Dispose() }
            if ($croppedArtwork) { $croppedArtwork.Dispose() }
            $artwork.Dispose()
        }
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::None

        # All variable fields belong to Template 2. Independent text boxes keep
        # the top-left price clear of the top-right SKU, as in the supplied layout.
        $graphics.TranslateTransform([single]$layout.rightX, [single]$layout.topY)
        if ($compact) {
            Draw-FittedLine $request.fields.price 'Price' 8 4 ($labelWidth - 16) 42 34 24 $true
            Draw-FittedLine $request.fields.sku 'SKU' 12 48 ($labelWidth - 24) 25 19 15
        }
        else {
            Draw-FittedLine $request.fields.price 'Price' 8 10 193 45 36 26 $true ([System.Drawing.StringAlignment]::Near)
            Draw-FittedLine $request.fields.sku 'SKU' 215 16 211 30 20 16 $false ([System.Drawing.StringAlignment]::Far)
        }
        Draw-ProductName $request.fields.productName
        # Split odd padding pixels once, keeping every bar edge on a whole dot.
        $x = [int][Math]::Floor(($labelWidth - $fullBarcodeWidth) / 2) + [int][Math]::Floor($quietZone * $moduleWidth)
        $black = $true
        foreach ($run in $modules) {
            $runWidth = $run * $moduleWidth
            if ($black) { $graphics.FillRectangle([System.Drawing.Brushes]::Black, [int]$x, 160, [int]$runWidth, 90) }
            $x += $runWidth
            $black = -not $black
        }
        Draw-FittedLine $request.fields.barcode 'Barcode text' 12 253 ($labelWidth - 24) 39 32 22
        $graphics.ResetTransform()
        $graphics.Dispose()
        $graphics = $null
    }
    $timings.renderMs = $clock.ElapsedMilliseconds

    if ($OutputPath) {
        $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
        $bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
    }

    if ($Print -or $CheckPrinter) {
        $setupStart = $clock.ElapsedMilliseconds
        Add-Type -Path (Join-Path $PSScriptRoot 'label-native.cs') -ReferencedAssemblies System.Drawing
        if ([string]::IsNullOrWhiteSpace($PrinterName)) { throw 'Choose a Windows printer before printing.' }
        if (-not ([System.Drawing.Printing.PrinterSettings]::InstalledPrinters -contains $PrinterName)) { throw 'The selected printer is not installed on this Windows PC.' }
        $document = New-Object System.Drawing.Printing.PrintDocument
        $document.PrinterSettings.PrinterName = $PrinterName
        if (-not $document.PrinterSettings.IsValid) { throw 'The selected Windows printer is unavailable.' }
        $document.DocumentName = 'Mobile sticker pair - ' + $request.fields.sku
        $document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
        $document.OriginAtMargins = $false
        # Query copy support only for multi-copy jobs. A single encoded page
        # avoids a shared-driver round trip for every identical sticker pair.
        # Older drivers keep the original exact-count page loop.
        $maximumCopies = 1
        if ($copies -gt 1) { $maximumCopies = $document.PrinterSettings.MaximumCopies }
        $copyPlan = [LabelCopyPlan]::Create($copies, $maximumCopies)
        $document.PrinterSettings.Copies = $copyPlan.DriverCopies
        $document.PrinterSettings.Collate = $false
        $document.DefaultPageSettings.Landscape = $false
        $document.DefaultPageSettings.Color = $false
        $document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
        $document.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize("Mobile sticker pair $($paperWidth / 100) x $($paperHeight / 100) in", $paperWidth, $paperHeight)
        $resolution = New-Object System.Drawing.Printing.PrinterResolution
        $resolution.Kind = [System.Drawing.Printing.PrinterResolutionKind]::Custom
        $resolution.X = 300
        $resolution.Y = 300
        $document.DefaultPageSettings.PrinterResolution = $resolution

        $timings.printerSetupMs = $clock.ElapsedMilliseconds - $setupStart
        $boundsStart = $clock.ElapsedMilliseconds
        # Same exact non-white pixel bounds; scan the locked pixels in compiled
        # code instead of making 270,000 GetPixel calls from PowerShell.
        $inkBounds = [LabelNative]::InkBounds($bitmap)
        $timings.boundsMs = $clock.ElapsedMilliseconds - $boundsStart
        $driverStart = $clock.ElapsedMilliseconds
        $measurement = $document.PrinterSettings.CreateMeasurementGraphics($document.DefaultPageSettings, $false)
        try {
            # Capture the configured page once. Re-reading PrintableArea and
            # HardMargin properties repeatedly reopens this shared driver.
            # Its measurement HDC reports default stock, so use PageSettings
            # for the requested custom stock and Graphics for actual DPI.
            $paperSize = $document.DefaultPageSettings.PaperSize
            $printerPage = [pscustomobject]@{
                Width = $paperSize.Width
                Height = $paperSize.Height
                DpiX = $measurement.DpiX
                DpiY = $measurement.DpiY
                PrintableArea = $document.DefaultPageSettings.PrintableArea
            }
            Assert-PrinterPage $printerPage
            $printerInfo = [pscustomobject]@{
                name = $PrinterName
                dpiX = $printerPage.DpiX
                dpiY = $printerPage.DpiY
                paperWidthInches = $printerPage.Width / 100.0
                paperHeightInches = $printerPage.Height / 100.0
                printableAreaHundredthsInch = [pscustomobject]@{
                    x = $printerPage.PrintableArea.X
                    y = $printerPage.PrintableArea.Y
                    width = $printerPage.PrintableArea.Width
                    height = $printerPage.PrintableArea.Height
                }
            }
        }
        finally { $measurement.Dispose() }
        $timings.driverCheckMs = $clock.ElapsedMilliseconds - $driverStart

        if ($Print) {
            $script:pagesSent = 0
            $document.add_PrintPage({
                param($sender, $eventArgs)
                # The stock and ink were checked above. Recheck the effective
                # page bounds and DPI on each copy using the existing event;
                # identical copies share the validated portrait printable area.
                $page = [pscustomobject]@{
                    Width = $eventArgs.PageBounds.Width
                    Height = $eventArgs.PageBounds.Height
                    DpiX = $eventArgs.Graphics.DpiX
                    DpiY = $eventArgs.Graphics.DpiY
                    PrintableArea = $printerPage.PrintableArea
                }
                Assert-PrinterPage $page
                $eventArgs.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Display
                $eventArgs.Graphics.PageScale = 1
                $eventArgs.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
                $eventArgs.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
                $eventArgs.Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
                $destination = New-Object System.Drawing.RectangleF((-$page.PrintableArea.X), (-$page.PrintableArea.Y), $paperWidth, $paperHeight)
                $eventArgs.Graphics.DrawImage($bitmap, $destination, (New-Object System.Drawing.RectangleF(0, 0, $pageWidth, $pageHeight)), [System.Drawing.GraphicsUnit]::Pixel)
                $script:pagesSent += 1
                $eventArgs.HasMorePages = $script:pagesSent -lt $copyPlan.PagesToSend
            })
            $submitStart = $clock.ElapsedMilliseconds
            $document.Print()
            $timings.submitMs = $clock.ElapsedMilliseconds - $submitStart
        }
    }

    [pscustomobject]@{ ok = $true; printed = [bool]$Print; printerReady = [bool]($Print -or $CheckPrinter); printer = $printerInfo; copies = $copies; copyPlan = $copyPlan; stickersPerCopy = 2; outputPath = $OutputPath; widthDots = $pageWidth; heightDots = $pageHeight; dpi = 300; layoutVersion = $layout.version; timings = $timings; totalMs = $clock.ElapsedMilliseconds } | ConvertTo-Json -Depth 5 -Compress
}
catch {
    [pscustomobject]@{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
finally {
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($document) { $document.Dispose() }
}
