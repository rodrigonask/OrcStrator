# Git auto-update is ON only in an official clone (installer\release\official-release.config.json
# present in the checkout) or when ORC_GIT_AUTO_UPDATE=1. A source build runs its
# checkout as it is: no fetch, no pull, no banner.
#
# Drives the real functions (pulled from setup.ps1 by AST) against a throwaway
# git history in TEMP with a local bare origin that is one commit AHEAD of the
# clone, so "nothing was pulled" and "the new commit was pulled" are both
# observable on disk, not just in a log line.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-git-auto-update.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
function Get-Fn([string]$Name) {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $Name in setup.ps1" }
    return $fn
}
foreach ($name in @('Invoke-UiPump','Run-Cmd','Test-GitAuthFailure','Invoke-GitRetry','Get-UpstreamRef','Find-Exe',
                    'Set-UpdateBanner','Test-OrcGitAutoUpdate','Hide-OrcUpdateBanner','Invoke-OrcBootPull','Check-ForUpdates')) {
    Invoke-Expression (Get-Fn $name).Extent.Text
}

$script:GitSilentEnv = @{ GIT_TERMINAL_PROMPT = "0"; GCM_INTERACTIVE = "never" }
function Log { param([string]$Msg) }

# Record every network git call the launcher makes, then run it for real.
$realInvoke = ${function:Invoke-GitRetry}
$script:GitCalls = New-Object System.Collections.ArrayList
function Invoke-GitRetry {
    param([string]$Cmd, [string]$CmdArgs, [string]$WorkDir, [int]$TimeoutSec = 60, [hashtable]$EnvVars)
    [void]$script:GitCalls.Add($CmdArgs)
    & $realInvoke $Cmd $CmdArgs -WorkDir $WorkDir -TimeoutSec $TimeoutSec -EnvVars $EnvVars
}

# Stand-ins for the launcher's globals
$script:Green   = [System.Drawing.Color]::FromArgb(0, 200, 100)
$script:Yellow  = [System.Drawing.Color]::FromArgb(230, 180, 40)
$script:Red     = [System.Drawing.Color]::FromArgb(220, 70, 70)
$script:TextDim = [System.Drawing.Color]::FromArgb(150, 150, 160)
$script:LogFile = "$env:TEMP\orc-git-auto-update-test.log"
$form = New-Object System.Windows.Forms.Form
$btnUpdate = New-Object System.Windows.Forms.Button
$form.Controls.Add($btnUpdate)
# Control.Visible reads false for any control whose form was never shown, so
# read the control's OWN visible flag (STATE_VISIBLE = 0x2), which is exactly
# what Hide-OrcUpdateBanner and Set-UpdateBanner set.
$getState = [System.Windows.Forms.Control].GetMethod('GetState', [System.Reflection.BindingFlags]'NonPublic,Instance')
function Test-BannerShown { return [bool]$getState.Invoke($btnUpdate, @([int]2)) }

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$git = Find-Exe "git"
if (-not $git) { throw "git not found" }
$tmp    = Join-Path $env:TEMP "orc-autoupd-test-$([guid]::NewGuid().ToString('N').Substring(0,6))"
$src    = "$tmp-src"
$origin = "$tmp-origin.git"
$savedAutoUpdate = $env:ORC_GIT_AUTO_UPDATE
$env:ORC_GIT_AUTO_UPDATE = $null

function Rev([string]$Dir, [string]$Ref) { return ((& $git -C $Dir rev-parse $Ref 2>$null) -join "").Trim() }

function New-OfficialConfig {
    param([string]$Root)
    $d = Join-Path $Root "installer\release"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Set-Content -Path (Join-Path $d "official-release.config.json") -Value '{ "test": true }' -Encoding ascii
}

# A clone sitting at c1 whose remote-tracking ref also says c1, while the
# origin already holds c2. Only a real fetch/pull can learn about c2.
function New-StaleClone {
    param([string]$Dir)
    & $git clone --quiet $origin $Dir 2>&1 | Out-Null
    if (-not (Test-Path $Dir)) { throw "clone failed: $Dir" }
    & $git -C $Dir reset --hard --quiet $script:c1 2>&1 | Out-Null
    & $git -C $Dir update-ref refs/remotes/origin/main $script:c1 2>&1 | Out-Null
}

$dirs = @($src, $origin)
try {
    # Fixture history: c1 - c2 on main. Plumbing only: no hooks, no editor.
    & $git init --quiet $src 2>&1 | Out-Null
    & $git -C $src symbolic-ref HEAD refs/heads/main 2>&1 | Out-Null
    Set-Content -Path (Join-Path $src "README.txt") -Value "auto-update test fixture" -Encoding ascii
    & $git -C $src add README.txt 2>&1 | Out-Null
    $tree = ((& $git -C $src write-tree) -join "").Trim()
    $id = @('-c', 'user.name=autoupd-test', '-c', 'user.email=autoupd-test@invalid')
    $script:c1 = ((& $git -C $src @id commit-tree $tree -m "c1") -join "").Trim()
    $script:c2 = ((& $git -C $src @id commit-tree $tree -p $script:c1 -m "c2: the newer commit") -join "").Trim()
    & $git -C $src update-ref refs/heads/main $script:c2 2>&1 | Out-Null
    & $git clone --bare --quiet $src $origin 2>&1 | Out-Null
    if ((Rev $origin 'refs/heads/main') -ne $script:c2) { throw "fixture origin is not at c2" }

    Write-Host "`n== Test-OrcGitAutoUpdate ==" -ForegroundColor Cyan
    $bareDir = "$tmp-plain"; $dirs += $bareDir
    New-Item -ItemType Directory -Force -Path $bareDir | Out-Null
    Check "no config, no env -> OFF" (-not (Test-OrcGitAutoUpdate -Root $bareDir -Override ""))
    Check "ORC_GIT_AUTO_UPDATE=1 -> ON" (Test-OrcGitAutoUpdate -Root $bareDir -Override "1")
    Check "ORC_GIT_AUTO_UPDATE=0 -> OFF" (-not (Test-OrcGitAutoUpdate -Root $bareDir -Override "0"))
    Check "ORC_GIT_AUTO_UPDATE=true -> OFF (only 1 opts in)" (-not (Test-OrcGitAutoUpdate -Root $bareDir -Override "true"))
    New-OfficialConfig -Root $bareDir
    Check "official-release config present -> ON" (Test-OrcGitAutoUpdate -Root $bareDir -Override "")
    $dirCfg = "$tmp-dircfg"; $dirs += $dirCfg
    New-Item -ItemType Directory -Force -Path (Join-Path $dirCfg "installer\release\official-release.config.json") | Out-Null
    Check "a directory named like the config is not the config" (-not (Test-OrcGitAutoUpdate -Root $dirCfg -Override ""))

    Write-Host "`n== (a) source build: no config, no env -> no fetch, no pull, no banner ==" -ForegroundColor Cyan
    $a = "$tmp-a"; $dirs += $a
    New-StaleClone -Dir $a
    $RepoRoot = $a
    $script:GitCalls.Clear()
    $btnUpdate.Visible = $true
    Check-ForUpdates
    Check "Check-ForUpdates made no git network call" ($script:GitCalls.Count -eq 0) "calls: $($script:GitCalls -join ', ')"
    Check "remote-tracking ref untouched (no fetch)" ((Rev $a 'refs/remotes/origin/main') -eq $script:c1)
    Check "no update offered" (-not $script:UpdateAvailable)
    Check "no sign-in offered" (-not $script:UpdateAuthNeeded)
    Check "banner hidden" (-not (Test-BannerShown))
    Check "banner not clickable" (-not $btnUpdate.Enabled)
    Check "banner title empty" ([string]::IsNullOrEmpty($script:UpdateTitle)) "got '$($script:UpdateTitle)'"
    $p = Invoke-OrcBootPull -Git $git -Root $a
    Check "boot pull not attempted" (-not $p.Attempted) "reason '$($p.Reason)'"
    Check "boot pull says why" ($p.Reason -eq 'git auto-update is off') "got '$($p.Reason)'"
    Check "no git network call at all" ($script:GitCalls.Count -eq 0) "calls: $($script:GitCalls -join ', ')"
    Check "HEAD still at c1 (newer commit NOT pulled)" ((Rev $a 'HEAD') -eq $script:c1)

    Write-Host "`n== (b) official clone: config present -> today's behaviour ==" -ForegroundColor Cyan
    $b = "$tmp-b"; $dirs += $b
    New-StaleClone -Dir $b
    New-OfficialConfig -Root $b
    $RepoRoot = $b
    $script:GitCalls.Clear()
    Check-ForUpdates
    Check "Check-ForUpdates fetched" (@($script:GitCalls) -contains 'fetch --quiet') "calls: $($script:GitCalls -join ', ')"
    Check "banner visible" (Test-BannerShown)
    Check "banner says 'Update available'" ($script:UpdateTitle -eq 'Update available') "got '$($script:UpdateTitle)'"
    Check "1 commit behind" ($script:CommitsBehind -eq 1) "got $($script:CommitsBehind)"
    Check "clickable" ($btnUpdate.Enabled)
    $p = Invoke-OrcBootPull -Git $git -Root $b
    Check "boot pull attempted" ($p.Attempted)
    Check "boot pull ran pull --ff-only" (@($script:GitCalls) -contains 'pull --ff-only')
    Check "boot pull moved HEAD (caller relaunches)" ($p.Moved)
    Check "HEAD now at c2 (newer commit pulled)" ((Rev $b 'HEAD') -eq $script:c2)
    Check "ShaAfter is the new HEAD" ($p.ShaAfter -eq $script:c2)
    Check-ForUpdates
    Check "then 'Up to date'" ($script:UpdateTitle -eq 'Up to date') "got '$($script:UpdateTitle)'"

    Write-Host "`n== (c) source build opted in with ORC_GIT_AUTO_UPDATE=1 ==" -ForegroundColor Cyan
    $c = "$tmp-c"; $dirs += $c
    New-StaleClone -Dir $c
    $RepoRoot = $c
    $env:ORC_GIT_AUTO_UPDATE = "1"
    try {
        $script:GitCalls.Clear()
        Check-ForUpdates
        Check "fetched" (@($script:GitCalls) -contains 'fetch --quiet')
        Check "banner visible, 'Update available'" ((Test-BannerShown) -and $script:UpdateTitle -eq 'Update available') "got '$($script:UpdateTitle)'"
        $p = Invoke-OrcBootPull -Git $git -Root $c
        Check "pulled c2" ($p.Moved -and (Rev $c 'HEAD') -eq $script:c2)
    } finally { $env:ORC_GIT_AUTO_UPDATE = $null }

    Write-Host "`n== Wiring in setup.ps1 ==" -ForegroundColor Cyan
    $runSetup = (Get-Fn 'Run-Setup').Extent.Text
    Check "Run-Setup boot pull goes through Invoke-OrcBootPull" ($runSetup -match 'Invoke-OrcBootPull' -and $runSetup -notmatch 'pull --ff-only')
    Check "Run-Setup gates the boot pull on Test-OrcGitAutoUpdate" ($runSetup -match '\$gitAutoUpdate = Test-OrcGitAutoUpdate' -and $runSetup -match '-and \$gitAutoUpdate\)')
    $click = $ast.FindAll({ param($n)
        $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -eq 'Add_Click' -and $n.Expression.Extent.Text -eq '$btnUpdate'
    }, $true) | Select-Object -First 1
    $clickText = if ($click) { $click.Extent.Text } else { "" }
    $gateAt = $clickText.IndexOf('Test-OrcGitAutoUpdate')
    Check "update click handler found" ([bool]$click)
    Check "click handler gates before its sign-in fetch" ($gateAt -ge 0 -and $gateAt -lt $clickText.IndexOf('fetch"'))
    Check "click handler gates before its pull" ($gateAt -ge 0 -and $gateAt -lt $clickText.IndexOf('pull --ff-only'))
    Check "Check-ForUpdates gates before its fetch" ((Get-Fn 'Check-ForUpdates').Extent.Text.IndexOf('Test-OrcGitAutoUpdate') -lt (Get-Fn 'Check-ForUpdates').Extent.Text.IndexOf('fetch --quiet'))

    Write-Host "`n== Existing official installs keep updating ==" -ForegroundColor Cyan
    $repo = Split-Path -Parent $PSScriptRoot
    $cfg = Join-Path $repo "installer\release\official-release.config.json"
    if (Test-Path -LiteralPath $cfg) {
        Check "this checkout carries the official config, so git auto-update stays ON" (Test-OrcGitAutoUpdate -Root $repo -Override "")
        & $git -C $repo ls-files --error-unmatch "installer/release/official-release.config.json" > $null 2>&1
        Check "the config is tracked, so every official clone and pull has it" ($LASTEXITCODE -eq 0)
    } else {
        Check "source build (no official config): git auto-update is OFF" (-not (Test-OrcGitAutoUpdate -Root $repo -Override ""))
    }
}
finally {
    $env:ORC_GIT_AUTO_UPDATE = $savedAutoUpdate
    foreach ($d in $dirs) {
        if ($d -and (Test-Path $d)) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
