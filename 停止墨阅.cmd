@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\stop.ps1"
pause
