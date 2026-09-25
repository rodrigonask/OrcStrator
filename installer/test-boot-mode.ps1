# Tests Resolve-BootMode (the real function, pulled from setup.ps1 by AST)
# against a throwaway launcher-state file. Boot mode is sticky, so getting the
# persistence wrong would silently leave a user in the wrong mode forever.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-boot-mode.ps1

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
foreach ($name in @('Get-LauncherState','Save-LauncherState','Set-LauncherStateValue','Resolve-BootMode')) {
    $fn = $ast.FindAll({ param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
    }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $name in setup.ps1" }
    Invoke-Expression $fn.Extent.Text
}

$ServerPort = 3334
$ClientPort = 5174

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}
function Reset-State { if (Test-Path $script:StateFile) { Remove-Item $script:StateFile -Force } }

$StateFile = Join-Path $env:TEMP "orc-bootmode-test-$([guid]::NewGuid().ToString('N').Substring(0,8)).json"

try {
    Write-Host "`n== Default is dev mode ==" -ForegroundColor Cyan
    Reset-State
    $m = Resolve-BootMode -ProductionSwitch $false -DevSwitch $false
    Check "no switch, no state -> dev" ($m -eq $false) "got $m"
    Check "state file not created by a dev boot" (-not (Test-Path $StateFile))
    $port = if ($m) { $ServerPort } else { $ClientPort }
    Check "dev app port is 5174" ($port -eq 5174) "got $port"

    Write-Host "`n== -Production switches and persists ==" -ForegroundColor Cyan
    Reset-State
    $m = Resolve-BootMode -ProductionSwitch $true -DevSwitch $false
    Check "switch -> production" ($m -eq $true) "got $m"
    Check "state file written" (Test-Path $StateFile)
    $st = Get-Content $StateFile -Raw | ConvertFrom-Json
    Check "bootMode persisted as 'production'" ($st.bootMode -eq 'production') "got '$($st.bootMode)'"
    $port = if ($m) { $ServerPort } else { $ClientPort }
    Check "production app port is 3334" ($port -eq 3334) "got $port"

    Write-Host "`n== Stickiness: survives a relaunch with no switch ==" -ForegroundColor Cyan
    $m = Resolve-BootMode -ProductionSwitch $false -DevSwitch $false
    Check "no switch but state says production -> production" ($m -eq $true) "got $m"

    Write-Host "`n== Explicit dev state is respected ==" -ForegroundColor Cyan
    Set-LauncherStateValue -Name "bootMode" -Value "dev"
    $m = Resolve-BootMode -ProductionSwitch $false -DevSwitch $false
    Check "bootMode='dev' -> dev" ($m -eq $false) "got $m"
    $m = Resolve-BootMode -ProductionSwitch $true -DevSwitch $false
    Check "-Production overrides a stored 'dev'" ($m -eq $true) "got $m"
    $st = Get-Content $StateFile -Raw | ConvertFrom-Json
    Check "override is persisted back" ($st.bootMode -eq 'production') "got '$($st.bootMode)'"

    Write-Host "`n== -Dev is the escape hatch out of sticky production ==" -ForegroundColor Cyan
    Reset-State
    Resolve-BootMode -ProductionSwitch $true -DevSwitch $false | Out-Null
    $m = Resolve-BootMode -ProductionSwitch $false -DevSwitch $true
    Check "-Dev returns dev" ($m -eq $false) "got $m"
    $st = Get-Content $StateFile -Raw | ConvertFrom-Json
    Check "-Dev clears the sticky production state" ($st.bootMode -eq 'dev') "got '$($st.bootMode)'"
    $m = Resolve-BootMode -ProductionSwitch $false -DevSwitch $false
    Check "next plain launch stays in dev" ($m -eq $false) "got $m"
    $m = Resolve-BootMode -ProductionSwitch $true -DevSwitch $true
    Check "-Dev wins when both switches are passed" ($m -eq $false) "got $m"

    Write-Host "`n== Other launcher state is preserved ==" -ForegroundColor Cyan
    Reset-State
    Set-LauncherStateValue -Name "updatedToSha" -Value "abc1234"
    Resolve-BootMode -ProductionSwitch $true -DevSwitch $false | Out-Null
    $st = Get-Content $StateFile -Raw | ConvertFrom-Json
    Check "bootMode added" ($st.bootMode -eq 'production')
    Check "updatedToSha not clobbered" ($st.updatedToSha -eq 'abc1234') "got '$($st.updatedToSha)'"

    Write-Host "`n== Corrupt state file does not crash the launcher ==" -ForegroundColor Cyan
    Set-Content -Path $StateFile -Value "{ this is not json" -Encoding UTF8
    $crashed = $false
    try { $m = Resolve-BootMode -ProductionSwitch $false -DevSwitch $false } catch { $crashed = $true }
    Check "corrupt state is survivable" (-not $crashed)
    Check "corrupt state falls back to dev" ($m -eq $false) "got $m"
}
finally {
    if (Test-Path $StateFile) { Remove-Item $StateFile -Force -ErrorAction SilentlyContinue }
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
