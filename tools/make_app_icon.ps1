# Construye el .ico del escritorio a partir del lockup completo del logo:
# recorta SOLO el simbolo VC (el texto "WeConnect / Two pilots - One cockpit"
# es ilegible a 32px) y lo compone centrado sobre un cuadrado redondeado
# oscuro, para que el icono tenga contraste tanto en escritorio claro como
# oscuro -- el simbolo es blanco y sobre fondo transparente desaparecia.
param(
    [string]$Source = "C:\Users\darwi\Downloads\shared-cockpit-backup\apps\desktop-ui\logos\We Connect - Logo.png",
    [string]$Destination = "C:\Users\darwi\Downloads\shared-cockpit-backup\apps\desktop-ui\logos\app-icon.ico",
    [string]$PreviewDir = ""
)

Add-Type -AssemblyName System.Drawing

# Bounding box del simbolo VC dentro del lockup, medido sobre el PNG de 1254x1254
# (las otras dos bandas con contenido, Y 740..832 y Y 888..920, son el texto).
$cropX = 307; $cropY = 364; $cropW = 655; $cropH = 302
$bg = [System.Drawing.ColorTranslator]::FromHtml("#0a0a0a")   # mismo fondo que la ventana de la app

function New-RoundedPath([int]$size, [single]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap([System.Drawing.Image]$src, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Cuadrado redondeado de fondo. Radio ~22% del lado, proporcion tipica de
    # iconos de app en Windows 11.
    $path = New-RoundedPath $size ([single]($size * 0.22))
    $brush = New-Object System.Drawing.SolidBrush $bg
    $g.FillPath($brush, $path)
    $brush.Dispose()
    $path.Dispose()

    # El simbolo ocupa el 68% del ancho, centrado, manteniendo su relacion de
    # aspecto (es mas ancho que alto).
    $targetW = $size * 0.68
    $scale = $targetW / $cropW
    $targetH = $cropH * $scale
    $destRect = New-Object System.Drawing.RectangleF(
        [single](($size - $targetW) / 2), [single](($size - $targetH) / 2),
        [single]$targetW, [single]$targetH)
    $srcRect = New-Object System.Drawing.RectangleF($cropX, $cropY, $cropW, $cropH)
    $g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

    $g.Dispose()
    return $bmp
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source).Path)

$images = @()
foreach ($size in $sizes) {
    $bmp = New-IconBitmap $src $size
    if ($PreviewDir -and $size -ge 48) {
        $bmp.Save((Join-Path $PreviewDir "preview-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $images += , @{ Size = $size; Bytes = $ms.ToArray() }
    $ms.Dispose()
}
$src.Dispose()

# Contenedor ICO con entradas PNG (soportado desde Windows Vista).
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$images.Count)
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $w.Write([Byte]$dim); $w.Write([Byte]$dim); $w.Write([Byte]0); $w.Write([Byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$img.Bytes.Length); $w.Write([UInt32]$offset)
    $offset += $img.Bytes.Length
}
foreach ($img in $images) { $w.Write($img.Bytes) }
$w.Flush()
[System.IO.File]::WriteAllBytes($Destination, $out.ToArray())
$w.Dispose(); $out.Dispose()

"Escrito $Destination ($((Get-Item $Destination).Length) bytes, resoluciones: $($sizes -join ', '))"
