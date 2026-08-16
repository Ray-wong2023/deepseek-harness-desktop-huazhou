# Rebuild build/icon.ico with BMP(DIB) frames instead of PNG-compressed frames.
# rcedit (used by electron-builder's exe icon injection) only understands
# classic BMP frames; PNG-compressed ICOs make it silently skip the icon.
# Usage: pwsh scripts/rebuild-ico.ps1 [-Source <path-to-ico>] [-Out <path-to-ico>]
param(
  [string]$Source = "$PSScriptRoot\..\build\icon.ico",
  [string]$Out = "$PSScriptRoot\..\build\icon.ico"
)
Add-Type -AssemblyName System.Drawing

$srcBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Source))
$count = [BitConverter]::ToUInt16($srcBytes, 4)
$frames = @()
for ($i = 0; $i -lt $count; $i++) {
  $off = 6 + $i * 16
  $w = $srcBytes[$off]; $h = $srcBytes[$off + 1]
  $size = [BitConverter]::ToUInt32($srcBytes, $off + 8)
  $dataOff = [BitConverter]::ToUInt32($srcBytes, $off + 12)
  $png = New-Object byte[] $size
  [Array]::Copy($srcBytes, $dataOff, $png, 0, $size)
  $ms = New-Object System.IO.MemoryStream(,$png)
  $bmp = New-Object System.Drawing.Bitmap([System.Drawing.Image]::FromStream($ms))
  $frames += ,@($w, $h, $bmp)
  $ms.Dispose()
}
Write-Host "decoded $($frames.Count) frames from $Source"

$outBytes = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($outBytes)
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$frames.Count)

$entries = @()
foreach ($f in $frames) {
  $w = $f[0]; $h = $f[1]; $bmp = $f[2]
  $wReal = if ($w -eq 0) { 256 } else { [int]$w }
  $hReal = if ($h -eq 0) { 256 } else { [int]$h }
  $rect = New-Object System.Drawing.Rectangle(0, 0, $wReal, $hReal)
  $bmp32 = $bmp.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $locked = $bmp32.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $locked.Stride
  $raw = New-Object byte[] ($stride * $hReal)
  [System.Runtime.InteropServices.Marshal]::Copy($locked.Scan0, $raw, 0, $raw.Length)
  $bmp32.UnlockBits($locked); $bmp32.Dispose(); $bmp.Dispose()

  # XOR data: bottom-up BGRA rows
  $xor = New-Object System.IO.MemoryStream
  for ($y = $hReal - 1; $y -ge 0; $y--) {
    $rowStart = $y * $stride
    for ($x = 0; $x -lt $wReal; $x++) {
      $b = $raw[$rowStart + $x * 4]; $g = $raw[$rowStart + $x * 4 + 1]; $r = $raw[$rowStart + $x * 4 + 2]; $a = $raw[$rowStart + $x * 4 + 3]
      $xor.WriteByte($b); $xor.WriteByte($g); $xor.WriteByte($r); $xor.WriteByte($a)
    }
  }
  $xorBytes = $xor.ToArray()
  # AND mask: all zeros (alpha channel carries transparency)
  $andRowBytes = [math]::Ceiling($wReal / 32) * 4
  $andBytes = New-Object byte[] ($andRowBytes * $hReal)
  $dibSize = 40 + $xorBytes.Length + $andBytes.Length
  $entries += ,@{ w = $w; h = $h; size = $dibSize; xor = $xorBytes; and = $andBytes }
  $xor.Dispose()
}

$offset = 6 + $frames.Count * 16
foreach ($e in $entries) {
  $bw.Write([Byte]$e.w); $bw.Write([Byte]$e.h)
  $bw.Write([Byte]0); $bw.Write([Byte]0)   # palette
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)  # planes, bpp
  $bw.Write([UInt32]$e.size); $bw.Write([UInt32]$offset)
  $offset += $e.size
}
foreach ($e in $entries) {
  $ew = if ($e.w -eq 0) { 256 } else { [int]$e.w }
  $eh = if ($e.h -eq 0) { 256 } else { [int]$e.h }
  $bw.Write([Int32]40)                    # biSize
  $bw.Write([Int32]$ew)
  $bw.Write([Int32]($eh * 2))             # XOR+AND
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]0)                    # BI_RGB
  $bw.Write([UInt32]0)                    # biSizeImage
  $bw.Write([Int32]0); $bw.Write([Int32]0)
  $bw.Write([UInt32]0); $bw.Write([UInt32]0)
  $bw.Write($e.xor); $bw.Write($e.and)
}
$bw.Flush()
[System.IO.File]::WriteAllBytes((Resolve-Path $Out), $outBytes.ToArray())
$bw.Dispose(); $outBytes.Dispose()
Write-Host "wrote BMP-frame ICO: $Out ($((Get-Item (Resolve-Path $Out)).Length) bytes, $($entries.Count) frames)"
