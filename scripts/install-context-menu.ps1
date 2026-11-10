# Install / uninstall "Open with MoYue" context-menu entries (per-user, no admin needed)
param([switch]$Uninstall)

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "打开书.cmd"
$exts = @(".epub", ".pdf", ".mobi", ".azw", ".azw3", ".prc", ".docx", ".doc", ".txt", ".fb2", ".html")

foreach ($ext in $exts) {
  $key = "HKCU:\Software\Classes\SystemFileAssociations\$ext\shell\MoYue"
  if ($Uninstall) {
    if (Test-Path $key) {
      Remove-Item -Path $key -Recurse -Force
      Write-Host "[MoYue] removed context menu for $ext"
    }
    continue
  }
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name "(Default)" -Value "用墨阅打开" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $key -Name "Icon" -Value $exe -PropertyType String -Force | Out-Null
  New-Item -Path "$key\command" -Force | Out-Null
  Set-ItemProperty -Path "$key\command" -Name "(Default)" -Value "`"$exe`" `"%1`""
  Write-Host "[MoYue] added context menu for $ext"
}

if (-not $Uninstall) {
  Write-Host "[MoYue] done. Right-click a supported ebook and choose '用墨阅打开'."
}
