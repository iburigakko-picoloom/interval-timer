Add-Type -AssemblyName System.Drawing
foreach ($size in @(192, 512)) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#2457d6'))
  $graphics.ScaleTransform(($size / 512.0), ($size / 512.0))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 25)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawEllipse($pen, 121, 144, 270, 270)
  $graphics.DrawLine($pen, 256, 106, 256, 144)
  $graphics.DrawLine($pen, 218, 99, 294, 99)
  $graphics.DrawLine($pen, 357, 169, 381, 145)
  $graphics.DrawLine($pen, 256, 204, 256, 279)
  $graphics.DrawLine($pen, 256, 279, 308, 309)
  $target = Join-Path $PSScriptRoot "timer-$size.png"
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
