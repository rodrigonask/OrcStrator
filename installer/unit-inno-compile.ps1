# Compile installer\OrcStrator.iss with Inno Setup and check the result: the
# script compiles, and with CodeSign on Inno hands the uninstaller
# to the sign tool and refuses to build when the tool did not really sign it.
# Compile only: the setup exe it produces is deleted, never run.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\unit-inno-compile.ps1
param([string]$InstallerDir = "")

$ErrorActionPreference = 'Stop'
if (-not $InstallerDir) { $InstallerDir = $PSScriptRoot }

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

# $env:ISCC names the compiler directly (a run with a scratch LOCALAPPDATA cannot see a
# per-user install); otherwise the standard install locations.
$iscc = @($env:ISCC, (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'), (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
          (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) {
    # On CI (windows-latest ships Inno Setup 6) a missing compiler is a failure, not a skip.
    if ($env:CI) { Check "Inno Setup (ISCC.exe) is available" $false; exit 1 }
    Write-Host "  SKIP  Inno Setup not installed on this machine" -ForegroundColor DarkYellow; exit 0
}

$base = Join-Path $env:TEMP "orc-unit-iscc-$([guid]::NewGuid().ToString('N').Substring(0,6))"
$stage = Join-Path $base 'stage'
try {
    New-Item -ItemType Directory -Force (Join-Path $stage 'launcher\installer'), (Join-Path $stage 'staging'), (Join-Path $base 'out') | Out-Null
    Copy-Item (Join-Path $InstallerDir 'EULA.txt') (Join-Path $stage 'launcher\EULA.txt')
    Copy-Item (Join-Path $InstallerDir 'icon.ico') (Join-Path $stage 'launcher\installer\icon.ico')
    if (Test-Path (Join-Path $InstallerDir 'stop-server.ps1')) { Copy-Item (Join-Path $InstallerDir 'stop-server.ps1') (Join-Path $stage 'launcher\installer\stop-server.ps1') }
    Set-Content (Join-Path $stage 'staging\manifest.json') '{}'
    $common = @('/Q', '/DAppVersion=9.9.9-test', '/DNumericVersion=9.9.9', "/DStageDir=$stage", "/DOutputDir=$(Join-Path $base 'out')")
    $iss = Join-Path $InstallerDir 'OrcStrator.iss'

    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $o = & $iscc @common $iss 2>&1; $code = $LASTEXITCODE
    $ErrorActionPreference = $eap
    Check "OrcStrator.iss compiles" ($code -eq 0) (($o | Select-Object -Last 3) -join ' | ')
    Check "it produced the setup exe" (Test-Path (Join-Path $base 'out\OrcStrator-Setup-9.9.9-test.exe'))

    # A stand-in sign tool that records what it is asked to sign and signs nothing.
    $log = Join-Path $base 'signed.txt'
    $fake = Join-Path $base 'fakesign.cmd'
    Set-Content $fake "@echo %~1>>`"$log`"`r`n@exit /b 0" -Encoding ASCII
    $ErrorActionPreference = 'Continue'
    $o2 = & $iscc @common "/SOrcSign=`$q$fake`$q `$f" '/DCodeSign=1' $iss 2>&1; $code2 = $LASTEXITCODE
    $ErrorActionPreference = $eap
    $asked = if (Test-Path $log) { @(Get-Content $log) } else { @() }
    Check "with CodeSign, Inno hands the uninstaller to the sign tool" (@($asked | Where-Object { $_ -match 'uninst' }).Count -ge 1) ($asked -join ', ')
    Check "and refuses to build when the tool did not really sign it" (($code2 -ne 0) -and (($o2 | Out-String) -match 'does not have a digital signature')) "exit $code2"
} finally {
    Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
exit 0
