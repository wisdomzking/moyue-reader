param(
  [string]$Open = "",
  [int]$Port = 7788,
  [switch]$NoBrowser
)

# Thin wrapper around scripts/launch.js (kept for compatibility).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "[墨阅] 未找到 Node.js，请先安装 Node.js 20+。" -ForegroundColor Red
  exit 1
}

$launchArgs = @((Join-Path $root "scripts\launch.js"), "--port", "$Port")
if ($Open -and $Open.Trim().Length -gt 0) {
  $launchArgs += @("--open", $Open)
}
if ($NoBrowser) {
  $launchArgs += "--no-browser"
}
& $node @launchArgs
exit $LASTEXITCODE
