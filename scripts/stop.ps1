# MoYue Reader stop script
param([int]$Port = 7788)

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  Write-Host "[MoYue] no server listening on port $Port"
  exit 0
}
$proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $proc.Id -Force
  Write-Host "[MoYue] stopped server (pid $($proc.Id))"
} else {
  Write-Host "[MoYue] could not find the process"
}
