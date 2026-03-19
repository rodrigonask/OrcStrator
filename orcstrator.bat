@echo off
setlocal enabledelayedexpansion
title OrcStrator

set SERVER_PORT=3333
set CLIENT_PORT=5173
set BASE=%~dp0
set KILLED=0
set NEED_RESTART=0

echo.
echo  =========================================
echo    ORCSTRATOR ^|  Server :3333  Client :5173
echo  =========================================
echo.

:: ── Check winget ──────────────────────────────────────────────
where winget >nul 2>&1
if errorlevel 1 (
    echo  [error] winget not found. OrcStrator needs winget to install dependencies.
    echo          Update Windows or install App Installer from the Microsoft Store.
    echo.
    pause
    exit /b 1
)
echo  [ok]   winget

:: ── Check Git ─────────────────────────────────────────────────
where git >nul 2>&1
if not errorlevel 1 goto git_ok
if exist "%ProgramFiles%\Git\cmd\git.exe" (
    set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
    goto git_ok
)
echo  [warn] Git not found. Installing...
winget install Git.Git --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
    echo  [error] Git installation failed. Install manually: https://git-scm.com
    pause
    exit /b 1
)
set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
set NEED_RESTART=1
echo  [ok]   Git installed.
goto git_done
:git_ok
for /f "tokens=*" %%v in ('git --version') do echo  [ok]   %%v
:git_done

:: ── Check Node.js ─────────────────────────────────────────────
where node >nul 2>&1
if not errorlevel 1 goto node_ok
:: Node not in PATH — check default install location
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
    goto node_ok
)
echo  [warn] Node.js not found. Installing Node.js 22...
winget install OpenJS.NodeJS.22 --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
    echo  [error] Node.js installation failed. Install manually: https://nodejs.org
    pause
    exit /b 1
)
set "PATH=%ProgramFiles%\nodejs;%PATH%"
set NEED_RESTART=1
echo  [ok]   Node.js installed.
goto node_done
:node_ok
for /f "tokens=*" %%v in ('node -v') do echo  [ok]   Node %%v
:node_done

:: ── Check C++ Build Tools (needed for better-sqlite3) ─────────
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" goto vctools_ok
where cl >nul 2>&1
if not errorlevel 1 goto vctools_ok
echo  [warn] C++ Build Tools not found. Installing (needed for native modules)...
winget install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
if errorlevel 1 (
    echo  [error] Build Tools installation failed. Install manually:
    echo          https://visualstudio.microsoft.com/visual-cpp-build-tools/
    pause
    exit /b 1
)
set NEED_RESTART=1
echo  [ok]   C++ Build Tools installed.
goto vctools_done
:vctools_ok
echo  [ok]   C++ Build Tools
:vctools_done

:: ── Restart check ─────────────────────────────────────────────
if "!NEED_RESTART!"=="1" (
    echo.
    echo  =========================================
    echo    Dependencies were installed.
    echo    Please close this window and run
    echo    orcstrator.bat again.
    echo  =========================================
    echo.
    pause
    exit /b 0
)

:: ── Check Claude CLI ──────────────────────────────────────────
where claude >nul 2>&1
if not errorlevel 1 goto claude_found
:: Check common standalone install location
if exist "%USERPROFILE%\.local\bin\claude.exe" (
    set "PATH=%USERPROFILE%\.local\bin;%PATH%"
    goto claude_found
)
echo  [warn] Claude CLI not found. Installing...
call npm install -g @anthropic-ai/claude-code
if errorlevel 1 (
    echo  [error] Claude CLI installation failed. Install manually:
    echo          npm install -g @anthropic-ai/claude-code
    pause
    exit /b 1
)
echo  [ok]   Claude CLI installed.
goto claude_done
:claude_found
:: Ensure claude.cmd exists (app expects .cmd for Windows spawn)
where claude.cmd >nul 2>&1
if not errorlevel 1 goto claude_ok
:: claude.exe exists but no .cmd shim — create one next to the exe
for /f "tokens=*" %%p in ('where claude') do set "CLAUDE_DIR=%%~dpp"
echo @echo off> "!CLAUDE_DIR!claude.cmd"
echo "%%~dp0claude.exe" %%*>> "!CLAUDE_DIR!claude.cmd"
echo  [ok]   Created claude.cmd shim
:claude_ok
for /f "tokens=*" %%v in ('claude --version') do echo  [ok]   Claude %%v
:claude_done

:: ── Check Claude authentication ───────────────────────────────
claude auth status >nul 2>&1
if not errorlevel 1 goto auth_ok
echo.
echo  [auth] Claude CLI is not logged in.
echo         Please log in to continue. A browser window will open.
echo.
call claude login
if errorlevel 1 (
    echo  [error] Claude login failed. Run 'claude login' manually.
    pause
    exit /b 1
)
echo  [ok]   Claude authenticated.
goto auth_done
:auth_ok
echo  [ok]   Claude authenticated
:auth_done

echo.
echo  -----------------------------------------
echo    All dependencies OK. Starting app...
echo  -----------------------------------------
echo.

:: ── Install npm dependencies if needed ────────────────────────
if not exist "%BASE%node_modules\.bin\tsc" (
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

:: ── Build shared package if needed ────────────────────────────
if not exist "%BASE%shared\dist\" (
    echo  [build] Compiling shared types...
    cd /d "%BASE%"
    call npm run build -w shared
    if errorlevel 1 (
        echo.
        echo  [error] shared build failed. Check the output above.
        pause
        exit /b 1
    )
    echo  [ok]   Shared package built.
    echo.
)

:: ── Kill server process (port 3333) ───────────────────────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":%SERVER_PORT%" ^| findstr "LISTENING"') do (
    if not "%%p"=="" (
        echo  [stop] server  PID=%%p
        taskkill /PID %%p /F /T >nul 2>&1
        set KILLED=1
    )
)

:: ── Kill client process (port 5173) ───────────────────────────
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

:: ── Start server ──────────────────────────────────────────────
echo  [run]  server  ^> http://localhost:%SERVER_PORT%
start "OrcStrator Server [:3333]" /d "%BASE%server" cmd /k npm run dev

timeout /t 3 /nobreak >nul

:: ── Start client ──────────────────────────────────────────────
echo  [run]  client  ^> http://localhost:%CLIENT_PORT%
start "OrcStrator Client [:5173]" /d "%BASE%client" cmd /k npm run dev

timeout /t 4 /nobreak >nul

:: ── Open browser ──────────────────────────────────────────────
echo  [open] http://localhost:%CLIENT_PORT%
start "" http://localhost:%CLIENT_PORT%

echo.
echo  Server  : http://localhost:%SERVER_PORT%
echo  Client  : http://localhost:%CLIENT_PORT%
echo  Monitor : sidebar -^> MONITOR button
echo.
pause
