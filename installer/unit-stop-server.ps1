# The uninstaller stops OrcStrator's own server first, and nothing
# else. Runs stop-server.ps1's function against a scratch data root with
# processes this test starts itself (copies of ping.exe), never a real app.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\unit-stop-server.ps1
param([string]$InstallerDir = "")

$ErrorActionPreference = 'Stop'
if (-not $InstallerDir) { $InstallerDir = $PSScriptRoot }

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$script = Join-Path $InstallerDir "stop-server.ps1"
$iss = Join-Path $InstallerDir "OrcStrator.iss"
$bi = Join-Path $InstallerDir "release\Build-Installer.ps1"
Check "installer/stop-server.ps1 exists" (Test-Path $script)
$issText = if (Test-Path $iss) { [System.IO.File]::ReadAllText($iss) } else { '' }
Check "the uninstaller runs it before removing files ([UninstallRun])" ($issText -match '(?s)\[UninstallRun\][^\[]*stop-server\.ps1[^\[]*waituntilterminated')
Check "the uninstaller passes the same data root the launcher uses" ($issText -match '\{code:OrcDataRootParam\}' -and $issText -match 'function OrcDataRootParam')
Check "Build-Installer ships it" ((Test-Path $bi) -and ([System.IO.File]::ReadAllText($bi) -match 'stop-server\.ps1'))

if (Test-Path $script) {
    . $script
    $tmp = Join-Path $env:TEMP "orc-unit-stop-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    $data = Join-Path $tmp "data"
    $appBin = Join-Path $data "app\versions\9.9.9\runtime"
    New-Item -ItemType Directory -Force $appBin | Out-Null
    $ping = Join-Path $env:WINDIR "System32\PING.EXE"
    $ownExe = Join-Path $appBin "node.exe"
    Copy-Item $ping $ownExe
    $started = @()
    function Start-Pinger([string]$Exe) {
        $p = Start-Process -FilePath $Exe -ArgumentList '-n', '60', '127.0.0.1' -WindowStyle Hidden -PassThru
        $script:started += $p
        return $p
    }
    function Write-Record([int]$ProcId) {
        [System.IO.File]::WriteAllText((Join-Path $data "server-process.json"), (@{ pid = $ProcId; exe = 'x'; port = 3399 } | ConvertTo-Json))
    }
    try {
        Remove-Item (Join-Path $data "server-process.json") -ErrorAction SilentlyContinue
        Check "no record: nothing to do" ((Stop-OrcServerForUninstall -DataRoot $data) -eq 'no-record')

        $own = Start-Pinger $ownExe
        Start-Sleep -Milliseconds 300
        Write-Record $own.Id
        $r = Stop-OrcServerForUninstall -DataRoot $data -WaitSeconds 10
        Check "our own server (recorded PID, running from <data>\app) is stopped" ($r -eq 'stopped') "got '$r'"
        Check "and it is really gone" (-not (Get-Process -Id $own.Id -ErrorAction SilentlyContinue))

        $foreign = Start-Pinger $ping
        Start-Sleep -Milliseconds 300
        Write-Record $foreign.Id
        $r = Stop-OrcServerForUninstall -DataRoot $data -WaitSeconds 2
        Check "a recorded PID now used by another program is left alone" ($r -eq 'not-ours') "got '$r'"
        Check "and that program is still running" ([bool](Get-Process -Id $foreign.Id -ErrorAction SilentlyContinue))

        Write-Record 999999
        Check "a recorded PID that is not running: nothing to do" ((Stop-OrcServerForUninstall -DataRoot $data) -eq 'not-running')

        [System.IO.File]::WriteAllText((Join-Path $data "server-process.json"), 'not json {')
        Check "a garbled record never throws" ((Stop-OrcServerForUninstall -DataRoot $data) -in @('error', 'no-record'))

        $env:ORCSTRATOR_DATA_DIR = $data
        $own2 = Start-Pinger $ownExe
        Start-Sleep -Milliseconds 300
        Write-Record $own2.Id
        Check "with no -DataRoot it uses ORCSTRATOR_DATA_DIR, like the launcher" ((Stop-OrcServerForUninstall -WaitSeconds 10) -eq 'stopped')

        # The script as the uninstaller runs it: exits 0 whatever happens.
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script -DataRoot (Join-Path $tmp 'no-such-root') | Out-Null
        Check "run as a script it always exits 0 (never fails the uninstall)" ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
    } finally {
        Remove-Item Env:ORCSTRATOR_DATA_DIR -ErrorAction SilentlyContinue
        foreach ($p in $started) { if (-not $p.HasExited) { try { $p.Kill() } catch { } } }
        Start-Sleep -Milliseconds 300
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`n$pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
exit 0
