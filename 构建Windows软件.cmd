@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 构建阅见 Windows 软件
"%~dp0.desktop-venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --onefile --windowed --name reader --icon "assets\yuejian.ico" --add-data "index.html;." --add-data "assets;assets" --hidden-import webview.platforms.edgechromium --hidden-import clr_loader desktop.py
echo.
echo 构建完成：dist\reader.exe
pause
