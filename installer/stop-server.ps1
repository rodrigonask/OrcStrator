<#
.SYNOPSIS
    Stop OrcStrator's own background server before an uninstall.
.DESCRIPTION
    Run by the uninstaller ([UninstallRun] in OrcStrator.iss) before any file
    is removed, so a running server cannot keep files locked and leave the
    uninstall half done. It stops ONLY the process the launcher recorded in
    <data root>\server-process.json, and only when that process is still
    running from <data root>\app. Anything else, it leaves alone. It never
    fails the uninstall: every problem is swallowed.
#>
param([string]$DataRoot = "")

function Stop-OrcServerForUninstall {
    param([string]$DataRoot = "", [int]$WaitSeconds = 10)
    try {
        if (-not $DataRoot) { $DataRoot = $env:ORCSTRATOR_DATA_DIR }
        if (-not $DataRoot) { $DataRoot = Join-Path $env:LOCALAPPDATA "OrcStrator" }
        $DataRoot = $DataRoot.Trim().TrimEnd('\')
        $rec = Join-Path $DataRoot "server-process.json"
        if (-not (Test-Path -LiteralPath $rec)) { return 'no-record' }
        $info = [System.IO.File]::ReadAllText($rec) | ConvertFrom-Json
        $procId = 0
        if (-not $info -or -not [int]::TryParse(("" + $info.pid), [ref]$procId) -or $procId -le 0) { return 'no-record' }
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p) { return 'not-running' }
        $exe = $null
        try { $exe = $p.Path } catch { }
        if (-not $exe) {
            try { $exe = (Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction Stop).ExecutablePath } catch { }
        }
        if (-not $exe) { return 'not-ours' }
        # Same ownership rule as the launcher's Test-OrcOwnedProcess: the
        # recorded PID, running from inside <data root>\app. A reused PID
        # belongs to some other program and is never touched.
        $app = Join-Path $DataRoot "app"
        if (-not (Test-Path -LiteralPath $app)) { return 'not-ours' }
        $appFull = [System.IO.Path]::GetFullPath((Get-Item -LiteralPath $app -Force).FullName).TrimEnd('\') + '\'
        $exeFull = if (Test-Path -LiteralPath $exe) { [System.IO.Path]::GetFullPath((Get-Item -LiteralPath $exe -Force).FullName) } else { [System.IO.Path]::GetFullPath($exe) }
        if (-not $exeFull.StartsWith($appFull, [System.StringComparison]::OrdinalIgnoreCase)) { return 'not-ours' }
        & taskkill.exe /PID $procId /T /F 2>$null | Out-Null
        for ($i = 0; $i -lt ($WaitSeconds * 4); $i++) {
            if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { return 'stopped' }
            Start-Sleep -Milliseconds 250
        }
        return 'still-running'
    } catch {
        return 'error'
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    [void](Stop-OrcServerForUninstall -DataRoot $DataRoot)
    exit 0
}
