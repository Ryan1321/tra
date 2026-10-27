$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\label-native.cs') -ReferencedAssemblies System.Drawing
foreach ($format in @([System.Drawing.Imaging.PixelFormat]::Format24bppRgb, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)) {
    $bitmap = New-Object System.Drawing.Bitmap(33, 9, $format)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        # An odd width exercises bitmap row padding, and a near-white pixel
        # must count as ink just as in the original clipping validation.
        $graphics.Clear([System.Drawing.Color]::White)
        $bitmap.SetPixel(3, 2, [System.Drawing.Color]::Black)
        $bitmap.SetPixel(32, 8, [System.Drawing.Color]::FromArgb(255, 255, 254))
        $bounds = [LabelNative]::InkBounds($bitmap)
        if ([Math]::Abs($bounds.X - 1) -gt 0.0001 -or [Math]::Abs($bounds.Y - 2 / 3.0) -gt 0.0001 -or
            [Math]::Abs($bounds.Width - 10) -gt 0.0001 -or [Math]::Abs($bounds.Height - 7 / 3.0) -gt 0.0001) { throw 'Incorrect ink bounds.' }
        if ($bitmap.GetPixel(32, 8).B -ne 254) { throw 'Scanning modified the image.' }
        # LockBits must have been released, allowing another draw and scan.
        $bitmap.SetPixel(0, 0, [System.Drawing.Color]::Black)
        $bounds = [LabelNative]::InkBounds($bitmap)
        if ($bounds.Left -ne 0 -or $bounds.Top -ne 0 -or $bounds.Right -ne 11 -or $bounds.Bottom -ne 3) { throw 'Edge pixels were lost.' }
        $graphics.Clear([System.Drawing.Color]::White)
        $rejected = $false
        try { [LabelNative]::InkBounds($bitmap) | Out-Null } catch { $rejected = $true }
        if (-not $rejected) { throw 'A blank sticker must not pass ink validation.' }
    }
    finally { $graphics.Dispose(); $bitmap.Dispose() }
}
Write-Output 'Ink bounds preserve edge pixels, near-white ink, row padding and image contents.'

# Exercise every allowed quantity against drivers that support no copies,
# only a few copies, or the Citizen's full range. This must never square the
# requested quantity or silently truncate it to the driver's limit.
foreach ($maximum in @(-1, 0, 1, 2, 19, 20, 99, 100, 32767)) {
    foreach ($copies in 1..100) {
        $plan = [LabelCopyPlan]::Create($copies, $maximum)
        if ($plan.DriverCopies * $plan.PagesToSend -ne $copies) { throw 'Copy count changed.' }
        if ($plan.DriverCopies -gt 1 -and $plan.DriverCopies -gt $maximum) { throw 'Driver copy limit exceeded.' }
        if ($copies -gt 1 -and $maximum -ge $copies -and ($plan.PagesToSend -ne 1 -or $plan.Mode -ne 'driver-copies')) { throw 'Capable driver must receive one page.' }
        if ($maximum -lt $copies -and ($plan.DriverCopies -ne 1 -or $plan.PagesToSend -ne $copies)) { throw 'Fallback must send exactly the requested pages.' }
    }
}
foreach ($copies in @(-1, 0, 101, 32768)) {
    $rejected = $false
    try { [LabelCopyPlan]::Create($copies, 32767) | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid copy quantity was accepted.' }
}
Write-Output 'Copy plans preserve quantities and send one page when the driver supports copies.'
