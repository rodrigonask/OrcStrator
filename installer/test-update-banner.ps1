# Drives Check-ForUpdates / Set-UpdateBanner (the real functions, pulled from
# setup.ps1 by AST) against a real WinForms button, through every branch:
# up-to-date, update-available, sign-in-needed, network-failure.
# Does NOT boot the server or client.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-update-banner.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
foreach ($name in @('Invoke-UiPump','Run-Cmd','Test-GitAuthFailure','Invoke-GitRetry','Get-UpstreamRef','Find-Exe','Set-UpdateBanner','Test-OrcGitAutoUpdate','Hide-OrcUpdateBanner','Check-ForUpdates')) {
    $fn = $ast.FindAll({ param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
    }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $name in setup.ps1" }
    Invoke-Expression $fn.Extent.Text
}

$script:GitSilentEnv = @{ GIT_TERMINAL_PROMPT = "0"; GCM_INTERACTIVE = "never" }
function Log { param([string]$Msg) }

# Stand-ins for the launcher's globals
$script:Green    = [System.Drawing.Color]::FromArgb(0, 200, 100)
$script:Yellow   = [System.Drawing.Color]::FromArgb(230, 180, 40)
$script:Red      = [System.Drawing.Color]::FromArgb(220, 70, 70)
$script:TextDim  = [System.Drawing.Color]::FromArgb(150, 150, 160)
$script:LogFile  = "$env:TEMP\orc-banner-test.log"
$form = New-Object System.Windows.Forms.Form
$btnUpdate = New-Object System.Windows.Forms.Button
$btnUpdate.FlatStyle = "Flat"
$form.Controls.Add($btnUpdate)

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}
function Show-State {
    Write-Host "    title='$($script:UpdateTitle)' sub='$($script:UpdateSub)'" -ForegroundColor DarkGray
    Write-Host "    color=$($script:UpdateColorKey) clickable=$($btnUpdate.Enabled) border=$($btnUpdate.FlatAppearance.BorderSize)" -ForegroundColor DarkGray
}

$git = Find-Exe "git"
if (-not $git) { throw "git not found" }
$tmp = Join-Path $env:TEMP "orc-banner-test-$([guid]::NewGuid().ToString('N').Substring(0,6))"
$src    = "$tmp-src"
$origin = "$tmp-origin.git"

# Build a throwaway history in TEMP instead of borrowing this checkout's, so
# the test runs the same in a shallow or single-commit clone. Plumbing only
# (write-tree / commit-tree / update-ref): no hooks, no editor, no identity
# taken from the machine. Shape, oldest first:
#   c1 - c2 - c3 - merge      (main, first-parent chain)
#          \       /
#           side --
# The tip is a merge on purpose: HEAD~2 then walks first parents to c2 while
# the reachable-set difference is 3 (c3, side, merge), which is the case
# Scenario 2 exists to get right.
function New-FixtureHistory {
    param([string]$Dir)
    & $git init --quiet $Dir 2>&1 | Out-Null
    & $git -C $Dir symbolic-ref HEAD refs/heads/main 2>&1 | Out-Null
    Set-Content -Path (Join-Path $Dir "README.txt") -Value "banner test fixture" -Encoding ascii
    & $git -C $Dir add README.txt 2>&1 | Out-Null
    $tree = ((& $git -C $Dir write-tree) -join "").Trim()
    $id = @('-c', 'user.name=banner-test', '-c', 'user.email=banner-test@invalid')
    $c1   = ((& $git -C $Dir @id commit-tree $tree -m "c1") -join "").Trim()
    $c2   = ((& $git -C $Dir @id commit-tree $tree -p $c1 -m "c2") -join "").Trim()
    $c3   = ((& $git -C $Dir @id commit-tree $tree -p $c2 -m "c3") -join "").Trim()
    $side = ((& $git -C $Dir @id commit-tree $tree -p $c2 -m "side") -join "").Trim()
    $tip  = ((& $git -C $Dir @id commit-tree $tree -p $c3 -p $side -m "merge side") -join "").Trim()
    & $git -C $Dir update-ref refs/heads/main $tip 2>&1 | Out-Null
    return $tip
}

function New-OfficialConfig {
    param([string]$Root)
    $d = Join-Path $Root "installer\release"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Set-Content -Path (Join-Path $d "official-release.config.json") -Value '{ "test": true }' -Encoding ascii
}
$savedAutoUpdate = $env:ORC_GIT_AUTO_UPDATE
$env:ORC_GIT_AUTO_UPDATE = $null

try {
    $fixtureTip = New-FixtureHistory -Dir $src
    if (-not $fixtureTip) { throw "could not build the fixture history" }
    & $git clone --bare --quiet $src $origin 2>&1 | Out-Null
    if (-not (Test-Path $origin)) { throw "bare origin clone failed" }
    Write-Host "Cloning from fixture origin: $origin" -ForegroundColor DarkGray

    Write-Host "`n== Scenario 1: local clone, in sync -> Up to date ==" -ForegroundColor Cyan
    & $git clone --quiet $origin $tmp 2>&1 | Out-Null
    if (-not (Test-Path $tmp)) { throw "clone failed" }
    $RepoRoot = $tmp
    # An official clone carries the release config, which is what turns git
    # auto-update on (Test-OrcGitAutoUpdate). Test-only file, never shipped.
    New-OfficialConfig -Root $tmp
    # Compare against whatever the clone actually tracks, not a hardcoded name
    $upRef = Get-UpstreamRef -Git $git -WorkDir $tmp
    Write-Host "    clone tracks: $upRef" -ForegroundColor DarkGray
    Check-ForUpdates
    Show-State
    Check "title is 'Up to date'" ($script:UpdateTitle -eq 'Up to date') "got '$($script:UpdateTitle)'"
    Check "green" ($script:UpdateColorKey -eq 'green')
    Check "not clickable" (-not $btnUpdate.Enabled)
    Check "UpdateAvailable false" (-not $script:UpdateAvailable)

    Write-Host "`n== Scenario 2: behind origin -> Update available ==" -ForegroundColor Cyan
    & $git -C $tmp reset --hard HEAD~2 --quiet 2>&1 | Out-Null
    # Ask git for the truth rather than assuming: HEAD~2 walks first parents,
    # so across a merge commit the reachable-set difference is more than 2.
    $expected = [int](((& $git -C $tmp rev-list "HEAD..$upRef" --count) -join "").Trim())
    Write-Host "    git says $expected commits behind" -ForegroundColor DarkGray
    Check-ForUpdates
    Show-State
    Check "title is 'Update available'" ($script:UpdateTitle -eq 'Update available') "got '$($script:UpdateTitle)'"
    Check "counts $expected commits behind" ($script:CommitsBehind -eq $expected) "got $($script:CommitsBehind)"
    Check "sub is pluralized" ($expected -gt 1 -and $script:UpdateSub -match "$expected new updates") "got '$($script:UpdateSub)'"
    Check "yellow" ($script:UpdateColorKey -eq 'yellow')
    Check "clickable, thick border" ($btnUpdate.Enabled -and $btnUpdate.FlatAppearance.BorderSize -eq 2)
    Check "UpdateAvailable true" ([bool]$script:UpdateAvailable)
    Check "UpdateAuthNeeded false" (-not $script:UpdateAuthNeeded)

    Write-Host "`n== Scenario 3: 1 commit behind -> singular wording ==" -ForegroundColor Cyan
    # Do not derive "1 behind" from history: when the tip is a merge commit,
    # tip~1..tip holds the merge plus the merged branch's commits, never 1.
    # Instead point the clone at a scratch bare upstream and add exactly one
    # single-parent commit on top of the tip there. Everything stays in TEMP.
    $bare = "$tmp-upstream.git"
    $branch = $upRef -replace '^origin/', ''
    & $git -C $tmp reset --hard $upRef --quiet 2>&1 | Out-Null
    & $git clone --bare --quiet $tmp $bare 2>&1 | Out-Null
    & $git -C $tmp remote set-url origin $bare 2>&1 | Out-Null
    $tip  = ((& $git -C $tmp rev-parse HEAD) -join "").Trim()
    $tree = ((& $git -C $tmp rev-parse "HEAD^{tree}") -join "").Trim()
    # commit-tree: plumbing, so no hooks and no editor; empty change on purpose
    $one = ((& $git -C $tmp -c user.name="banner-test" -c user.email="banner-test@invalid" `
        commit-tree $tree -p $tip -m "banner test: exactly one commit ahead") -join "").Trim()
    & $git -C $tmp push --quiet origin "${one}:refs/heads/$branch" 2>&1 | Out-Null
    & $git -C $tmp fetch --quiet 2>&1 | Out-Null
    $behind = [int](((& $git -C $tmp rev-list "HEAD..$upRef" --count) -join "").Trim())
    Write-Host "    git says $behind commit(s) behind" -ForegroundColor DarkGray
    Check "precondition: exactly 1 commit behind" ($behind -eq 1) "got $behind"
    Check-ForUpdates
    Show-State
    Check "sub says '1 new update' (singular)" ($script:UpdateSub -match '1 new update\b' -and $script:UpdateSub -notmatch 'updates') "got '$($script:UpdateSub)'"

    Write-Host "`n== Scenario 4: repo wants sign-in, no credentials -> Sign in to GitHub ==" -ForegroundColor Cyan
    # Point the clone at a private-looking remote and strip credential helpers,
    # so the fetch fails exactly the way an un-signed-in machine does. GitHub
    # answers an unknown repo like a private one: it asks for credentials.
    & $git -C $tmp remote set-url origin "https://github.com/example-owner/example-private-repo.git" 2>&1 | Out-Null
    & $git -C $tmp config credential.helper "" 2>&1 | Out-Null
    $realInvoke = ${function:Invoke-GitRetry}
    function Invoke-GitRetry {
        param([string]$Cmd, [string]$CmdArgs, [string]$WorkDir, [int]$TimeoutSec = 60, [hashtable]$EnvVars)
        # force the no-helper config through (git -c beats the repo config)
        $patched = "-c credential.helper= -c credential.helper=`"`" $CmdArgs"
        & $realInvoke $Cmd $patched -WorkDir $WorkDir -TimeoutSec $TimeoutSec -EnvVars $EnvVars
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Check-ForUpdates
    $sw.Stop()
    Show-State
    Write-Host "    elapsed=$([Math]::Round($sw.Elapsed.TotalSeconds,1))s" -ForegroundColor DarkGray
    Check "title is 'Sign in to GitHub'" ($script:UpdateTitle -eq 'Sign in to GitHub') "got '$($script:UpdateTitle)'"
    Check "UpdateAuthNeeded true (click routes to sign-in)" ([bool]$script:UpdateAuthNeeded)
    Check "clickable" ($btnUpdate.Enabled)
    Check "yellow" ($script:UpdateColorKey -eq 'yellow')
    Check "did NOT falsely claim 'Up to date'" ($script:UpdateTitle -ne 'Up to date')
    Check "fast fail, under 10s" ($sw.Elapsed.TotalSeconds -lt 10)
    ${function:Invoke-GitRetry} = $realInvoke

    Write-Host "`n== Scenario 5: unreachable host -> Update check failed (not auth) ==" -ForegroundColor Cyan
    & $git -C $tmp remote set-url origin "https://nonexistent-host-orcstrator-test.invalid/x.git" 2>&1 | Out-Null
    Check-ForUpdates
    Show-State
    Check "title is 'Update check failed'" ($script:UpdateTitle -eq 'Update check failed') "got '$($script:UpdateTitle)'"
    Check "does not ask for sign-in on a network error" (-not $script:UpdateAuthNeeded)
    Check "not clickable" (-not $btnUpdate.Enabled)
    Check "did NOT falsely claim 'Up to date'" ($script:UpdateTitle -ne 'Up to date')

    Write-Host "`n== Scenario 6: zip copy with no .git -> Updates unavailable ==" -ForegroundColor Cyan
    $zipCopy = "$tmp-zip"
    New-OfficialConfig -Root $zipCopy
    $RepoRoot = $zipCopy
    Check-ForUpdates
    Show-State
    Check "title is 'Updates unavailable'" ($script:UpdateTitle -eq 'Updates unavailable') "got '$($script:UpdateTitle)'"
    Check "sub explains it is not a checkout" ($script:UpdateSub -match 'not a git checkout') "got '$($script:UpdateSub)'"
    Check "does not blame the network" ($script:UpdateSub -notmatch 'reach GitHub')
    Check "not clickable" (-not $btnUpdate.Enabled)
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    if ($bare -and (Test-Path $bare)) { Remove-Item $bare -Recurse -Force -ErrorAction SilentlyContinue }
    $env:ORC_GIT_AUTO_UPDATE = $savedAutoUpdate
    foreach ($d in @($src, $origin, $zipCopy)) {
        if ($d -and (Test-Path $d)) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
