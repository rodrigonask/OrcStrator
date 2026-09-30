# Port handling of an INSTALLED OrcStrator: it never
# kills a process it did not start. Only a process recorded in the launcher's
# own state file AND running an exe from inside its own app folder is "ours".
#
# Uses REAL listeners on scratch ports and the REAL functions from setup.ps1
# (AST-extracted). Never touches 3334/5174 or any real data dir.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-port-ownership.ps1

param([int]$BasePort = 3431)

if ($BasePort -le 3334 -and $BasePort + 10 -ge 3334) { throw "Pick a -BasePort range away from 3334" }
if ($BasePort -le 5174 -and $BasePort + 10 -ge 5174) { throw "Pick a -BasePort range away from 5174" }

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
foreach ($name in @('Find-Exe', 'Invoke-UiPump', 'Get-OrcServerStateFile', 'Read-OrcServerProcess', 'Save-OrcServerProcess',
                    'Clear-OrcServerProcess', 'Test-OrcPathInside', 'Get-OrcProcessPath', 'Get-OrcProcessLabel',
                    'Test-OrcOwnedProcess', 'Get-OrcPortListeners', 'Resolve-OrcServerPort', 'Stop-OrcOwnedServer',
                    'Stop-OrcStrator')) {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $name in setup.ps1" }
    Invoke-Expression $fn.Extent.Text
}
function Log { param([string]$Msg) if ($env:ORC_TEST_VERBOSE) { Write-Host "    [log] $Msg" -ForegroundColor DarkGray } }
$script:Headless = $true

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}
function Test-Accepting([int]$P) {
    try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $P); $ok = $c.Connected; $c.Close(); return $ok } catch { return $false }
}
function Wait-Listening([int]$P) {
    for ($i = 0; $i -lt 40; $i++) { if ((Get-OrcPortListeners -Port $P).Count -gt 0) { return $true }; Start-Sleep -Milliseconds 250 }
    return $false
}

$sandbox = Join-Path $env:TEMP "orc-port-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$StateDir = Join-Path $sandbox "data"                           # read by Get-OrcServerStateFile
$script:ArtifactRoot = Join-Path $StateDir "app"
New-Item -ItemType Directory -Path $script:ArtifactRoot -Force | Out-Null

$foreignPort = $BasePort
$ownPort = $BasePort + 3
$outsidePort = $BasePort + 6
$foreign = $null; $ownProc = $null; $outsideProc = $null
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "This test needs node on PATH (it plays the part of the bundled runtime)" }
$listenJs = Join-Path $sandbox "listen.js"
Set-Content $listenJs "require('net').createServer(()=>{}).listen(+process.argv[2],'127.0.0.1');setInterval(()=>{},1e6)" -Encoding ASCII

try {
    Write-Host "== A foreign program holds the port ==" -ForegroundColor Cyan
    $foreign = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $foreignPort)
    $foreign.Start()
    Check "Test-OrcOwnedProcess says the foreign listener is NOT ours" (-not (Test-OrcOwnedProcess -ProcessId $PID))
    $r = Resolve-OrcServerPort -Preferred $foreignPort -Explicit $true
    Check "explicit port held by a foreign program -> conflict" ($r.Action -eq 'conflict') "got $($r.Action)"
    Check "conflict message names the holder" ($r.Message -match "PID $PID" -and $r.Message -match 'did not stop it') $r.Message
    $r = Resolve-OrcServerPort -Preferred $foreignPort -Explicit $false
    Check "default port held by a foreign program -> moves to the next free port" ($r.Action -eq 'moved' -and $r.Port -eq ($foreignPort + 1)) "got $($r.Action) $($r.Port)"
    Check "moved message says nothing was stopped" ($r.Message -match 'Nothing was stopped') $r.Message
    Stop-OrcOwnedServer -Pids @($PID) -Port $foreignPort
    Check "Stop-OrcOwnedServer leaves the foreign listener running" (Test-Accepting $foreignPort)

    # Installed-mode shutdown: the old layer 2 killed ANY listener on the
    # launcher's ports. In artifact mode it must not.
    $script:ArtifactMode = $true; $script:JobOk = $false; $script:ServerPid = $null; $script:ClientPid = $null
    $script:ShutdownDone = $false
    $ServerPort = $foreignPort; $ClientPort = $foreignPort
    Stop-OrcStrator
    Check "Stop-OrcStrator (installed mode) leaves the foreign listener running" (Test-Accepting $foreignPort)

    Write-Host "`n== Our own server (state file + exe inside the app folder) ==" -ForegroundColor Cyan
    $rt = Join-Path $script:ArtifactRoot "versions\9.9.9\runtime"
    New-Item -ItemType Directory -Path $rt -Force | Out-Null
    $ownNode = Join-Path $rt "node.exe"
    Copy-Item $node $ownNode
    $ownProc = Start-Process -FilePath $ownNode -ArgumentList "`"$listenJs`"", $ownPort -PassThru -WindowStyle Hidden
    Check "own server is listening" (Wait-Listening $ownPort)
    $r = Resolve-OrcServerPort -Preferred $ownPort -Explicit $true
    Check "before it is recorded, it is NOT ours (conflict)" ($r.Action -eq 'conflict') "got $($r.Action)"
    Save-OrcServerProcess -ProcessId $ownProc.Id -ExePath $ownNode -Port $ownPort -Version "9.9.9"
    Check "recorded + exe inside the app folder -> ours" (Test-OrcOwnedProcess -ProcessId $ownProc.Id)
    $r = Resolve-OrcServerPort -Preferred $ownPort -Explicit $true
    Check "Resolve-OrcServerPort reports it as own" ($r.Action -eq 'own' -and @($r.OwnPids) -contains $ownProc.Id) "got $($r.Action)"
    Stop-OrcOwnedServer -Pids $r.OwnPids -Port $ownPort
    Check "our own server was stopped" (-not (Test-Accepting $ownPort))
    Check "the foreign listener is STILL running" (Test-Accepting $foreignPort)

    Write-Host "`n== Recorded PID but the exe lives outside the app folder ==" -ForegroundColor Cyan
    $outsideProc = Start-Process -FilePath $node -ArgumentList "`"$listenJs`"", $outsidePort -PassThru -WindowStyle Hidden
    Check "outside server is listening" (Wait-Listening $outsidePort)
    Save-OrcServerProcess -ProcessId $outsideProc.Id -ExePath $node -Port $outsidePort -Version "9.9.9"
    Check "state-file match alone is NOT enough" (-not (Test-OrcOwnedProcess -ProcessId $outsideProc.Id))
    Stop-OrcOwnedServer -Pids @($outsideProc.Id) -Port $outsidePort
    Check "it survives Stop-OrcOwnedServer" (Test-Accepting $outsidePort)
    $script:ShutdownDone = $false
    Stop-OrcStrator
    Check "it survives Stop-OrcStrator (installed mode)" (Test-Accepting $outsidePort)

    Write-Host "`n== Path containment ==" -ForegroundColor Cyan
    Check "inside" (Test-OrcPathInside -Path "C:\a\app\versions\1\runtime\node.exe" -Dir "C:\a\app")
    Check "sibling with a shared prefix is outside" (-not (Test-OrcPathInside -Path "C:\a\app-evil\node.exe" -Dir "C:\a\app"))
    Check "dot-dot escape is outside" (-not (Test-OrcPathInside -Path "C:\a\app\..\node.exe" -Dir "C:\a\app"))
    Check "case-insensitive" (Test-OrcPathInside -Path "c:\A\APP\x.exe" -Dir "C:\a\app")
}
finally {
    if ($foreign) { try { $foreign.Stop() } catch { } }
    foreach ($p in @($ownProc, $outsideProc)) { if ($p -and -not $p.HasExited) { try { Stop-Process -Id $p.Id -Force } catch { } } }
    Start-Sleep -Milliseconds 300
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
