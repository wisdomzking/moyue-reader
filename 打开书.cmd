@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
if "%~1"=="" (
  echo 用法：把电子书文件拖到本文件上，或：打开书.cmd "D:\Books\xxx.epub"
  pause
  exit /b 1
)
node "%ROOT%scripts\launch.js" --port 7788 --open "%~1"
if errorlevel 1 pause
