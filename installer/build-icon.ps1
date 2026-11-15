param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = [Drawing.Bitmap]::new(64,64)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$background = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#176b55'))
$accent = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#b4e4c9'))
$shape = [Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(0,0,28,28,180,90); $shape.AddArc(35,0,28,28,270,90)
$shape.AddArc(35,35,28,28,0,90); $shape.AddArc(0,35,28,28,90,90); $shape.CloseFigure()
$graphics.FillPath($background,$shape)
$font = [Drawing.Font]::new('Arial',49,[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString('r',$font,[Drawing.Brushes]::White,12,0)
$graphics.FillEllipse($accent,44,44,10,10)
$icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
$file = [IO.File]::Create($OutputPath)
try { $icon.Save($file) } finally { $file.Dispose(); $icon.Dispose(); $font.Dispose(); $shape.Dispose(); $accent.Dispose(); $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
