@echo off
rem Crowd density data publisher - Windows launcher
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found in PATH. Install Python 3.11+ first.
    pause
    exit /b 1
)

python run.py %*
echo.
echo Server stopped.
pause
