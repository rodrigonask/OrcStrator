@echo off
title OrcStrator
:: Launch the GUI installer/launcher
:: Bypasses execution policy for this process only — no system-wide changes
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\setup.ps1" %*
if errorlevel 1 (
    echo.
    echo  Something went wrong. Check the window above for details.
    echo  You can also try running installer\setup.ps1 directly in PowerShell.
    echo.
    pause
)
