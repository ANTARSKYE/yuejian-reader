@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8123
set NO_BROWSER=
title Yuejian Reading Assistant
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" server.py
) else (
  python server.py
)
pause
