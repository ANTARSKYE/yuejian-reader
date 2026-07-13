@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8123
set NO_BROWSER=
title Yuejian Reading Assistant
python server.py
pause
