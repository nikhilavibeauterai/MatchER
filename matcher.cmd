@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
    py -3.13 "%~dp0launch.py" %*
) else (
    python "%~dp0launch.py" %*
)
if errorlevel 1 (
    echo.
    echo Install Python 3.13 from https://www.python.org/downloads/ or use a desktop release.
    pause
    exit /b 1
)
