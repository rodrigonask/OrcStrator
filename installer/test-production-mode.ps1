# Prove the production boot path
# actually works before anything is built on top of it.
#
# Boots the BUILT server (NODE_ENV=production, node server/dist/index.js) and
# asserts that a single-port deployment really serves the whole app: API,
# static assets, SPA deep links, WebSocket, and the Host/Origin guard.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-production-mode.ps1
#
# SAFETY: never touches port 3334 or ~/.orcstrator-v2. Runs on its own port
# against a throwaway ORCSTRATOR_DATA_DIR, and pre-creates an empty DB file so
# initDb() does NOT auto-import the v1 database. That import matters: the
# startup audit tree-kills any instance PID it considers orphaned, and real
# PIDs from a copied v1 DB can collide with unrelated live processes.

param(
    [int]$Port = 3400
)

Add-Type -AssemblyName System.Net.Http

$RepoRoot  = Split-Path -Parent $PSScriptRoot
$ServerDir = Join-Path $RepoRoot "server"
$DataDir   = Join-Path $env:TEMP "orc-prodtest-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$LogFile   = Join-Path $env:TEMP "orc-prodtest-server.log"
$Base      = "http://localhost:$Port"

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

# --- preflight -------------------------------------------------------------
if ($Port -eq 3334) { throw "Refusing to run on 3334: that is the real server's port." }
if (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "Port $Port is already in use. Pass -Port <free port>."
}
foreach ($d in @("$RepoRoot\shared\dist", "$RepoRoot\client\dist", "$RepoRoot\server\dist")) {
    if (-not (Test-Path $d)) { throw "Missing $d - run 'npm run build' first." }
}

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
# Block the v1 auto-import (see SAFETY above): an existing DB_PATH short-circuits it.
[System.IO.File]::WriteAllBytes((Join-Path $DataDir "orcstrator.db"), @())

Write-Host "Repo:     $RepoRoot"
Write-Host "Data dir: $DataDir"
Write-Host "Port:     $Port`n"

# --- boot ------------------------------------------------------------------
$bat = Join-Path $env:TEMP "orc-prodtest-$([guid]::NewGuid().ToString('N').Substring(0,6)).bat"
Set-Content -Path $bat -Encoding ASCII -Value @(
    "@echo off",
    "cd /d `"$ServerDir`"",
    "set `"NODE_ENV=production`"",
    "set `"PORT=$Port`"",
    "set `"ORCSTRATOR_DATA_DIR=$DataDir`"",
    "node dist/index.js > `"$LogFile`" 2>&1"
)

$proc = $null
try {
    $proc = Start-Process cmd.exe -ArgumentList "/c", "`"$bat`"" -WindowStyle Hidden -PassThru
    Write-Host "Server starting (launcher PID $($proc.Id))..." -ForegroundColor DarkGray

    $http = New-Object System.Net.Http.HttpClient
    $http.Timeout = [TimeSpan]::FromSeconds(10)

    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $r = $http.GetAsync("$Base/api/health").GetAwaiter().GetResult()
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
    }
    if (-not $healthy) {
        Write-Host "`nServer never became healthy. Log tail:" -ForegroundColor Red
        if (Test-Path $LogFile) { Get-Content $LogFile -Tail 30 | ForEach-Object { "    $_" } }
        throw "production server did not boot"
    }
    Write-Host "Server healthy.`n" -ForegroundColor DarkGray

    function Get-Resp {
        param([string]$Path, [hashtable]$Headers)
        $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$Base$Path")
        if ($Headers) {
            foreach ($k in $Headers.Keys) {
                if ($k -ieq 'Host') { $req.Headers.Host = $Headers[$k] }
                else { $req.Headers.TryAddWithoutValidation($k, $Headers[$k]) | Out-Null }
            }
        }
        $resp = $http.SendAsync($req).GetAwaiter().GetResult()
        return @{
            Status = [int]$resp.StatusCode
            Body   = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            Type   = if ($resp.Content.Headers.ContentType) { $resp.Content.Headers.ContentType.MediaType } else { "" }
        }
    }

    Write-Host "== API ==" -ForegroundColor Cyan
    $r = Get-Resp "/api/health"
    Check "GET /api/health is 200" ($r.Status -eq 200) "got $($r.Status)"
    Check "health reports status ok" ($r.Body -match '"status"\s*:\s*"ok"') "got $($r.Body)"

    Write-Host "`n== Static client (the whole point of single-port) ==" -ForegroundColor Cyan
    $r = Get-Resp "/"
    Check "GET / is 200" ($r.Status -eq 200) "got $($r.Status)"
    Check "GET / serves HTML" ($r.Type -eq 'text/html') "got '$($r.Type)'"
    Check "GET / has the SPA root div" ($r.Body -match 'id="root"') "body did not contain the mount point"
    $asset = $null
    if ($r.Body -match '(/assets/[A-Za-z0-9._-]+\.js)') { $asset = $Matches[1] }
    Check "index.html references a built JS bundle" ($null -ne $asset) "no /assets/*.js found in index.html"
    if ($asset) {
        $a = Get-Resp $asset
        Check "GET $asset is 200" ($a.Status -eq 200) "got $($a.Status)"
        Check "asset is served as JavaScript" ($a.Type -match 'javascript') "got '$($a.Type)'"
    }

    Write-Host "`n== SPA fallback vs API 404 ==" -ForegroundColor Cyan
    $r = Get-Resp "/pipeline"
    Check "deep link /pipeline is 200 (not 404)" ($r.Status -eq 200) "got $($r.Status)"
    Check "deep link returns index.html" ($r.Body -match 'id="root"') "did not get the SPA shell"
    $r = Get-Resp "/api/definitely-not-a-route"
    Check "unknown /api route is 404" ($r.Status -eq 404) "got $($r.Status)"
    Check "unknown /api route returns JSON, not the SPA shell" ($r.Body -notmatch 'id="root"') "API 404 leaked index.html"

    Write-Host "`n== Host / Origin guard ==" -ForegroundColor Cyan
    $r = Get-Resp "/api/health" @{ Host = 'evil.com' }
    Check "DNS-rebinding Host is rejected 403" ($r.Status -eq 403) "got $($r.Status)"
    $r = Get-Resp "/api/health" @{ Origin = 'http://evil.com' }
    Check "cross-site Origin is rejected 403" ($r.Status -eq 403) "got $($r.Status)"
    $r = Get-Resp "/api/health" @{ Origin = "http://localhost:$Port" }
    Check "the app's OWN origin is allowed on port $Port" ($r.Status -eq 200) "got $($r.Status) - ALLOWED_ORIGINS does not follow PORT"
    $r = Get-Resp "/api/health" @{ Origin = "http://127.0.0.1:$Port" }
    Check "own origin via 127.0.0.1 is allowed" ($r.Status -eq 200) "got $($r.Status)"
    $r = Get-Resp "/api/health" @{ Host = "127.0.0.1:$Port" }
    Check "loopback Host on a custom port is allowed" ($r.Status -eq 200) "got $($r.Status)"

    Write-Host "`n== WebSocket ==" -ForegroundColor Cyan
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $wsOk = $false; $wsErr = ""
    try {
        $ws.Options.SetRequestHeader("Origin", "http://localhost:$Port")
        $cts = New-Object System.Threading.CancellationTokenSource(10000)
        $ws.ConnectAsync([Uri]"ws://localhost:$Port/ws", $cts.Token).GetAwaiter().GetResult() | Out-Null
        $wsOk = ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open)
    } catch { $wsErr = $_.Exception.Message }
    Check "WS /ws upgrade succeeds on the single port" $wsOk $wsErr
    if ($wsOk) {
        # The server sends nothing on connect (ws/handler.ts) - it answers a
        # ping with a pong. A round trip proves bidirectional messaging over
        # the single port, which is stronger than waiting for a greeting.
        $got = ""
        try {
            $out = [System.Text.Encoding]::UTF8.GetBytes('{"type":"ping"}')
            $outSeg = New-Object System.ArraySegment[byte] -ArgumentList @(,$out)
            $ctsS = New-Object System.Threading.CancellationTokenSource(5000)
            $ws.SendAsync($outSeg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ctsS.Token).GetAwaiter().GetResult() | Out-Null

            $buf = New-Object 'byte[]' 8192
            $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buf)
            $ctsR = New-Object System.Threading.CancellationTokenSource(5000)
            $res = $ws.ReceiveAsync($seg, $ctsR.Token).GetAwaiter().GetResult()
            $got = [System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
        } catch { $got = "ERROR: $($_.Exception.Message)" }
        Check "WS ping gets a pong back" ($got -match '"type"\s*:\s*"pong"') "got '$got'"
        try { $ws.Dispose() } catch { }
    }
}
finally {
    Write-Host "`nCleaning up..." -ForegroundColor DarkGray
    # Kill by PORT, not by our launcher PID: cmd.exe /c spawns node as a child
    # and exits, so the node process is what actually holds the port.
    foreach ($c in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
        if ($c.OwningProcess -gt 0) {
            Write-Host "    killing PID $($c.OwningProcess) on port $Port" -ForegroundColor DarkGray
            & taskkill /PID $c.OwningProcess /T /F 2>&1 | Out-Null
        }
    }
    if ($proc -and -not $proc.HasExited) { try { & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null } catch { } }
    Remove-Item $bat -Force -ErrorAction SilentlyContinue
    Remove-Item $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    $still = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count
    Write-Host "    port $Port still listening: $($still -gt 0)" -ForegroundColor DarkGray
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
