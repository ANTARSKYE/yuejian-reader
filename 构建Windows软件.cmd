@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 构建阅见 Windows 软件
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
if errorlevel 1 (
  echo.
  echo 构建失败，请查看上方错误。
) else (
  echo.
  echo 构建完成：dist\reader.exe
)
pause
