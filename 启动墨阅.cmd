@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
node "%ROOT%scripts\launch.js" --port 7788
if errorlevel 1 pause
