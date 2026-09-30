# Launcher self-update.
#
# OrcStrator.exe runs the ACTIVE version's verified launcher,
# <data root>\app\versions\<current.txt>\installer\setup.ps1, with
# -LauncherRoot {app}, and falls back to {app}\installer\setup.ps1. The C#
# starter and setup.ps1's Resolve-OrcLauncherScript (used for relaunches) must
# make the SAME choice, so this compiles the REAL OrcStrator.cs, runs it in
# --print-launcher mode against scratch layouts, and compares it case by case
# with the REAL PowerShell function (AST-extracted). It also launches the
# starter for real once, through a path with spaces, to prove the arguments
# arrive intact.
#
# Scratch only: a temp sandbox for {app} and the data root, env vars restored.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-launcher-self-update.ps1

Set-StrictMode -Off
$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$StarterSrc = Join-Path $PSScriptRoot "starter\OrcStrator.cs"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
foreach ($name in @('Resolve-OrcLauncherScript', 'Test-OrcLauncherRootArg', 'Get-OrcRelaunchArgs')) {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $name in setup.ps1" }
    Invoke-Expression $fn.Extent.Text
}

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$Marker = "orc-starter-contract: launcher-root-v1"
# A space in the path on purpose: every quoting bug shows up here.
$sandbox = Join-Path $env:TEMP "orc starter test $([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null
# Long form: CI's %TEMP% is an 8.3 name (RUNNER~1), and both resolvers return
# long paths, so the expected values must be long too.
$sandbox = [System.IO.Path]::GetFullPath($sandbox)
$app = Join-Path $sandbox "Programs\OrcStrator"
$data = Join-Path $sandbox "data root"
$lad = Join-Path $sandbox "lad"
$saved = @{}
foreach ($n in 'ORCSTRATOR_DATA_DIR', 'LOCALAPPDATA') { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }

function Write-Text([string]$Path, [string]$Text) {
    $d = Split-Path -Parent $Path
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function New-VersionLauncher([string]$DataRoot, [string]$Version, [switch]$NoMarker) {
    $body = if ($NoMarker) { "param([string]`$Out)`r`n" } else { "# $Marker`r`nparam([string]`$LauncherRoot, [string]`$Out)`r`n" }
    $body += "if (`$Out) { [System.IO.File]::WriteAllText(`$Out, `"script=`$PSCommandPath``r``nlauncherRoot=`$LauncherRoot``r``nargs=`$(`$args -join '|')``r``n`") }`r`n"
    Write-Text (Join-Path $DataRoot "app\versions\$Version\installer\setup.ps1") $body
}
function Set-Current([string]$DataRoot, [string]$Text, [switch]$Bom) {
    $p = Join-Path $DataRoot "app\current.txt"
    Write-Text $p $Text
    if ($Bom) { [System.IO.File]::WriteAllText($p, $Text, (New-Object System.Text.UTF8Encoding($true))) }
}
function Invoke-Starter([string]$Exe) {
    $out = Join-Path $sandbox ("print-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + ".txt")
    $p = Start-Process -FilePath $Exe -ArgumentList '--print-launcher', "`"$out`"" -Wait -PassThru -WindowStyle Hidden
    $h = @{ exit = $p.ExitCode }
    if (Test-Path $out) {
        foreach ($l in [System.IO.File]::ReadAllLines($out)) { $i = $l.IndexOf('='); if ($i -gt 0) { $h[$l.Substring(0, $i)] = $l.Substring($i + 1) } }
    }
    return $h
}
function Compare-Case {
    <# Run both resolvers on the current layout and env; check they agree and match $Want. #>
    param([string]$Name, [string]$Exe, [string]$AppDir, [string]$WantSource, [string]$WantScript)
    $ps = Resolve-OrcLauncherScript -LauncherRoot $AppDir
    $cs = Invoke-Starter $Exe
    $okPs = ($ps.Source -eq $WantSource) -and ($ps.Script -eq $WantScript)
    $okCs = ($cs.exit -eq 0) -and ($cs.source -eq $WantSource) -and ($cs.script -eq $WantScript)
    $agree = ($ps.Script -eq $cs.script) -and ($ps.Source -eq $cs.source) -and ("" + $ps.LauncherRootArg -eq "" + $cs.launcherRoot)
    Check "$Name (setup.ps1)" $okPs "got $($ps.Source) $($ps.Script) [$($ps.Reason)]"
    Check "$Name (OrcStrator.exe)" $okCs "got exit=$($cs.exit) $($cs.source) $($cs.script)"
    Check "$Name (both agree, incl. -LauncherRoot)" $agree "ps=$($ps.LauncherRootArg) cs=$($cs.launcherRoot)"
}

try {
    New-Item -ItemType Directory -Path $app, $data, $lad -Force | Out-Null
    Write-Text (Join-Path $app "installer\setup.ps1") "# $Marker`r`nparam([string]`$LauncherRoot, [string]`$Out)`r`nif (`$Out) { [System.IO.File]::WriteAllText(`$Out, `"script=`$PSCommandPath``r``nlauncherRoot=`$LauncherRoot``r``n`") }`r`n"

    Write-Host "== Compile the real starter ==" -ForegroundColor Cyan
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
    $exe = Join-Path $app "OrcStrator.exe"
    $cscOut = & $csc /nologo /target:winexe /optimize+ /debug- /platform:anycpu "/out:$exe" $StarterSrc 2>&1
    Check "OrcStrator.cs compiles with the Windows csc.exe" ($LASTEXITCODE -eq 0 -and (Test-Path $exe)) ($cscOut -join ' ')

    Write-Host "`n== The two copies of the rule are the same rule ==" -ForegroundColor Cyan
    $csText = [System.IO.File]::ReadAllText($StarterSrc)
    $psFn = ($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Resolve-OrcLauncherScript' }, $true) | Select-Object -First 1).Extent.Text
    $csRe = [regex]::Match($csText, 'VersionPattern = @"([^"]+)"').Groups[1].Value
    $psRe = [regex]::Match($psFn, "\`$versionPattern = '([^']+)'").Groups[1].Value
    Check "version regex identical in OrcStrator.cs and setup.ps1" ($csRe -and $csRe -eq $psRe) "cs='$csRe' ps='$psRe'"
    Check "contract marker identical" ($csText.Contains("ContractMarker = `"$Marker`"") -and $psFn.Contains($Marker))
    $setupText = [System.IO.File]::ReadAllText($SetupPath)
    Check "setup.ps1 itself carries the contract marker" ($setupText -match "(?m)^# $([regex]::Escape($Marker))\s*$")
    Check "setup.ps1 declares -LauncherRoot" ($ast.ParamBlock.Parameters.Name.VariablePath.UserPath -contains 'LauncherRoot')

    [Environment]::SetEnvironmentVariable('ORCSTRATOR_DATA_DIR', $data, 'Process')
    $appSetup = Join-Path $app "installer\setup.ps1"
    $vFull = { param($v) [System.IO.Path]::GetFullPath((Join-Path $data "app\versions\$v\installer\setup.ps1")) }

    Write-Host "`n== Which launcher runs ==" -ForegroundColor Cyan
    Compare-Case "no current.txt -> {app}" $exe $app 'app' $appSetup
    New-VersionLauncher $data "2.1.1-beta.2"
    Set-Current $data "2.1.1-beta.2"
    Compare-Case "verified active version -> its own launcher" $exe $app 'version' (& $vFull "2.1.1-beta.2")
    Set-Current $data "2.1.1-beta.2`r`n"
    Compare-Case "trailing newline in current.txt is trimmed" $exe $app 'version' (& $vFull "2.1.1-beta.2")
    Set-Current $data "2.1.1-beta.2" -Bom
    Compare-Case "a BOM in current.txt is ignored" $exe $app 'version' (& $vFull "2.1.1-beta.2")
    New-VersionLauncher $data "2.1.1-local"
    Set-Current $data "2.1.1-local"
    Compare-Case "a -local build version is accepted" $exe $app 'version' (& $vFull "2.1.1-local")
    New-VersionLauncher $data "2.2.0"
    Set-Current $data "2.2.0"
    Compare-Case "after an update to 2.2.0 the starter follows it" $exe $app 'version' (& $vFull "2.2.0")

    Write-Host "`n== Falls back to {app} on anything suspicious ==" -ForegroundColor Cyan
    Set-Current $data "2.3.0"
    Compare-Case "version dir missing" $exe $app 'app' $appSetup
    New-Item -ItemType Directory -Path (Join-Path $data "app\versions\2.3.0\server") -Force | Out-Null
    Compare-Case "version dir without installer\setup.ps1" $exe $app 'app' $appSetup
    New-VersionLauncher $data "2.4.0" -NoMarker
    Set-Current $data "2.4.0"
    Compare-Case "payload launcher predates -LauncherRoot (no marker)" $exe $app 'app' $appSetup
    # Traversal attempts. Each target exists and HAS the marker, so only the
    # validation stands between it and being run.
    Write-Text (Join-Path $data "app\evil\installer\setup.ps1") "# $Marker"
    Write-Text (Join-Path $sandbox "evil\installer\setup.ps1") "# $Marker"
    foreach ($bad in @('..\evil', '..\..\..\evil', '2.2.0\..\..\evil', 'C:\evil', '\\server\share', '2.2', 'v2.2.0', '2.2.0 x', '2.2.0-', '2.2.0-beta..1', '2.2.0-be_ta', '2.2.0+build', '')) {
        Set-Current $data $bad
        Compare-Case "current.txt '$bad' is rejected" $exe $app 'app' $appSetup
    }

    Write-Host "`n== Data root resolves like setup.ps1 ==" -ForegroundColor Cyan
    [Environment]::SetEnvironmentVariable('ORCSTRATOR_DATA_DIR', "  $data  ", 'Process')
    Set-Current $data "2.2.0"
    Compare-Case "ORCSTRATOR_DATA_DIR is trimmed" $exe $app 'version' (& $vFull "2.2.0")
    [Environment]::SetEnvironmentVariable('ORCSTRATOR_DATA_DIR', $null, 'Process')
    [Environment]::SetEnvironmentVariable('LOCALAPPDATA', $lad, 'Process')
    Compare-Case "no override and nothing in %LOCALAPPDATA%\OrcStrator -> {app}" $exe $app 'app' $appSetup
    New-VersionLauncher (Join-Path $lad "OrcStrator") "2.2.0"
    Set-Current (Join-Path $lad "OrcStrator") "2.2.0"
    Compare-Case "no override -> %LOCALAPPDATA%\OrcStrator" $exe $app 'version' ([System.IO.Path]::GetFullPath((Join-Path $lad "OrcStrator\app\versions\2.2.0\installer\setup.ps1")))
    [Environment]::SetEnvironmentVariable('ORCSTRATOR_DATA_DIR', $data, 'Process')

    Write-Host "`n== The developer path is untouched ==" -ForegroundColor Cyan
    $dev = Join-Path $sandbox "dev checkout"
    New-Item -ItemType Directory -Path (Join-Path $dev ".git"), (Join-Path $dev "installer") -Force | Out-Null
    Copy-Item $exe (Join-Path $dev "OrcStrator.exe")
    Write-Text (Join-Path $dev "installer\setup.ps1") "# $Marker"
    Compare-Case "a .git checkout always runs its own installer\setup.ps1" (Join-Path $dev "OrcStrator.exe") $dev 'dev' (Join-Path $dev "installer\setup.ps1")
    $repo = Split-Path -Parent $PSScriptRoot
    $r = Resolve-OrcLauncherScript -LauncherRoot $repo
    Check "this repo checkout resolves to its own launcher" ($r.Source -eq 'dev' -and $r.Script -eq (Join-Path $repo "installer\setup.ps1") -and -not $r.LauncherRootArg) "got $($r.Source) $($r.Script)"

    Write-Host "`n== -LauncherRoot validation in setup.ps1 ==" -ForegroundColor Cyan
    Check "an installed app folder is accepted" (Test-OrcLauncherRootArg $app)
    Check "a git checkout is refused" (-not (Test-OrcLauncherRootArg $dev))
    Check "a folder without installer\setup.ps1 is refused" (-not (Test-OrcLauncherRootArg (Join-Path $data "app")))
    Check "a missing folder is refused" (-not (Test-OrcLauncherRootArg (Join-Path $sandbox "nope")))
    Check "a relative path is refused" (-not (Test-OrcLauncherRootArg "Programs\OrcStrator"))
    Check "empty is refused" (-not (Test-OrcLauncherRootArg ""))

    Write-Host "`n== The launcher's own relaunch makes the same choice ==" -ForegroundColor Cyan
    $script:LauncherRoot = $app
    $script:LauncherScript = Join-Path $data "app\versions\2.1.1-beta.2\installer\setup.ps1"
    $script:ProductionMode = $true
    $script:ArtifactMode = $true
    Set-Current $data "2.2.0"
    $a = Get-OrcRelaunchArgs -SkipUpdates
    $joined = $a -join ' '
    Check "installed relaunch runs the ACTIVE version's launcher, quoted" ($joined -like "*-File `"$(& $vFull '2.2.0')`"*") $joined
    Check "and passes -LauncherRoot {app}, quoted" ($joined -like "*-LauncherRoot `"$app`"*") $joined
    Check "keeps -SkipUpdates and -Production" ($a -contains '-SkipUpdates' -and $a -contains '-Production')
    $script:ArtifactMode = $false; $script:ProductionMode = $false
    $script:LauncherScript = Join-Path $dev "installer\setup.ps1"
    $a = Get-OrcRelaunchArgs
    Check "developer relaunch re-runs the same script, no -LauncherRoot" (($a -join ' ') -like "*-File `"$($script:LauncherScript)`"*" -and $a -notcontains '-LauncherRoot') ($a -join ' ')

    Write-Host "`n== Real launch through the starter (path with spaces) ==" -ForegroundColor Cyan
    Set-Current $data "2.2.0"
    $got = Join-Path $sandbox "launched v.txt"
    $p = Start-Process -FilePath $exe -ArgumentList '-Out', "`"$got`"", '"extra arg"' -Wait -PassThru
    for ($i = 0; $i -lt 60 -and -not (Test-Path $got); $i++) { Start-Sleep -Milliseconds 250 }
    Check "starter exited 0" ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
    $h = @{}
    if (Test-Path $got) { foreach ($l in [System.IO.File]::ReadAllLines($got)) { $i = $l.IndexOf('='); if ($i -gt 0) { $h[$l.Substring(0, $i)] = $l.Substring($i + 1) } } }
    Check "the ACTIVE version's launcher ran" ($h.script -eq (& $vFull '2.2.0')) "got '$($h.script)'"
    Check "it received -LauncherRoot {app}" ($h.launcherRoot -eq $app) "got '$($h.launcherRoot)'"
    Check "pass-through arguments survived quoting" ($h.args -eq 'extra arg') "got '$($h.args)'"
    Remove-Item (Join-Path $data "app\current.txt") -Force
    $got2 = Join-Path $sandbox "launched app.txt"
    $p = Start-Process -FilePath $exe -ArgumentList '-Out', "`"$got2`"" -Wait -PassThru
    for ($i = 0; $i -lt 60 -and -not (Test-Path $got2); $i++) { Start-Sleep -Milliseconds 250 }
    $h = @{}
    if (Test-Path $got2) { foreach ($l in [System.IO.File]::ReadAllLines($got2)) { $i = $l.IndexOf('='); if ($i -gt 0) { $h[$l.Substring(0, $i)] = $l.Substring($i + 1) } } }
    Check "with nothing installed yet, {app}\installer\setup.ps1 ran" ($h.script -eq $appSetup) "got '$($h.script)'"
    Check "and got no -LauncherRoot" ("" + $h.launcherRoot -eq "") "got '$($h.launcherRoot)'"
}
finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
