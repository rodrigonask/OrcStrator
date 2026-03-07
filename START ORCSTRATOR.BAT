@echo off
setlocal enabledelayedexpansion
title OrcStrator

set SERVER_PORT=3333
set CLIENT_PORT=5173
set BASE=%~dp0
set KILLED=0

echo.
echo  =========================================
echo    ORCSTRATOR ^|  Server :3333  Client :5173
echo  =========================================
echo.

:: ── Check Node.js ───────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [error] Node.js not found.
    echo.
    echo  Install it from https://nodejs.org or run:
    echo    winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo  [ok]   Node %%v

:: ── Install dependencies if needed ──────────────────────────
if not exist "%BASE%node_modules\" (
    echo  [setup] Installing dependencies... this may take a minute.
    echo.
    cd /d "%BASE%"
    call npm install
    if errorlevel 1 (
        echo.
        echo  [error] npm install failed. Check the output above.
        pause
        exit /b 1
    )
    echo.
    echo  [ok]   Dependencies installed.
    echo.
)

:: ── Kill server process (port 3333) ──────────────────────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%SERVER_PORT%" ^| findstr "LISTENING"') do (
    if not "%%p"=="" (
        echo  [stop] server  PID=%%p
        taskkill /PID %%p /F /T >nul 2>&1
        set KILLED=1
    )
)

:: ── Kill client process (port 5173) ──────────────────────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%CLIENT_PORT%" ^| findstr "LISTENING"') do (
    if not "%%p"=="" (
        echo  [stop] client  PID=%%p
        taskkill /PID %%p /F /T >nul 2>&1
        set KILLED=1
    )
)

if "!KILLED!"=="1" (
    echo  [wait] ports clearing...
    timeout /t 2 /nobreak >nul
    echo  [boot] rebooting
) else (
    echo  [boot] cold start
)

echo.

:: ── Start server ─────────────────────────────────────────────
echo  [run]  server  ^> http://localhost:%SERVER_PORT%
start "OrcStrator Server [:3333]" cmd /k "cd /d "%BASE%server" && npm run dev"

timeout /t 3 /nobreak >nul

:: ── Start client ─────────────────────────────────────────────
echo  [run]  client  ^> http://localhost:%CLIENT_PORT%
start "OrcStrator Client [:5173]" cmd /k "cd /d "%BASE%client" && npm run dev"

timeout /t 4 /nobreak >nul

:: ── Open browser ─────────────────────────────────────────────
echo  [open] http://localhost:%CLIENT_PORT%
start "" "http://localhost:%CLIENT_PORT%"

echo.
echo  Server  : http://localhost:%SERVER_PORT%
echo  Client  : http://localhost:%CLIENT_PORT%
echo  Monitor : sidebar -> MONITOR button
echo.
