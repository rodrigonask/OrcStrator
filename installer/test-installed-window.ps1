# The installed-mode launcher WINDOW, built by the real setup.ps1 code:
#   - developer-only rows are hidden, the rest carry plain outcome names
#   - a skipped or timed-out Claude sign-in leaves a visible "Log in" button
#   - the plain subtitle, and no developer words anywhere in the window
#   - the installed-mode error box: one action plus "Copy details"
# and renders each state to a PNG (-OutDir) so the wording can be eyeballed.
#
# How: copies setup.ps1 into a sandbox with NO .git, writes a synthetic
# release config into that copy exactly like a release build does (so it runs
# in installed mode), cuts it just before it would start the launch flow, and
# appends the checks below. Nothing is started, installed, downloaded or opened.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-installed-window.ps1 [-OutDir C:\tmp\orc-ux]
param([string]$OutDir = "")

. (Join-Path $PSScriptRoot "release\release-lib.ps1")
# release-lib turns strict mode on; the launcher does not run under it.
Set-StrictMode -Off
$TestUpdateBaseUrl = 'https://updates.example.com'
$TestKey = New-OrcSigningKey -Bits 2048

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$marker = 'LAUNCH FORM + START SETUP IN BACKGROUND'
$sandbox = Join-Path $env:TEMP "orc-window-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
if (-not $OutDir) { $OutDir = Join-Path $sandbox "png" }

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$probe = @'

# ---- appended by test-installed-window.ps1 ----
$results = New-Object System.Collections.ArrayList
function Rec([string]$Name, [bool]$Ok, [string]$Detail = "") { [void]$results.Add([ordered]@{ name = $Name; ok = $Ok; detail = $Detail }) }
function Save-Png($Ctl, [string]$Name) {
    $bmp = New-Object System.Drawing.Bitmap($Ctl.Width, $Ctl.Height)
    $Ctl.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $Ctl.Width, $Ctl.Height)))
    $path = Join-Path $env:ORC_TEST_PNG_DIR $Name
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return $path
}
$devWords = 'Not needed|Backend|backend|App engine|Version control|Build tools|Packages|App setup|Orchestration|Multi-Instance|ORC_PORT|-Port|git'
try {
    Rec "sandbox copy runs in installed mode" ([bool]$script:ArtifactMode)
    $form.StartPosition = "Manual"
    $form.Location = New-Object System.Drawing.Point(-3000, -3000)
    $form.ShowInTaskbar = $false
    Set-OrcInstalledLayout
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()

    Rec "plain subtitle" ($lblSub.Text -eq 'Run several Claude chats side by side') $lblSub.Text
    foreach ($i in 0, 1, 2, 3, 7) { Rec "developer row $i is hidden" (-not $stepLabels[$i].Visible) }
    $names = @{ 6 = 'Files'; 4 = 'Claude'; 5 = 'Sign-in'; 8 = 'Starting'; 9 = 'Ready' }
    foreach ($i in $names.Keys) { Rec "row $i is named '$($names[$i])' and visible" ($stepLabels[$i].Visible -and $stepLabels[$i].Text -eq $names[$i]) $stepLabels[$i].Text }
    $ys = @(6, 4, 5, 8, 9 | ForEach-Object { $stepLabels[$_].Location.Y })
    Rec "visible rows run top to bottom in launch order" ((($ys | Sort-Object) -join ',') -eq ($ys -join ',') -and ($ys | Select-Object -Unique).Count -eq 5) ($ys -join ',')
    Rec "progress counts only the visible steps" ($progress.Maximum -eq 5) "$($progress.Maximum)"

    # A launch where Claude is installed but the first sign-in timed out.
    Set-StepSkip 0 "System ready"; Set-StepSkip 1 "Not needed"; Set-StepSkip 3 "Not needed"
    Set-StepOk 6 "OrcStrator 2.1.1 installed"
    Set-StepOk 2 "Ready"
    Set-StepOk 4 "Claude AI ready"
    $script:ClaudeExe = "C:\fake\claude.exe"
    Set-OrcSignInResult -Auth @{ LoggedIn = $false; Method = 'none' } -TimedOut $true
    Rec "sign-in row says what to do" ($stepLabels[5].Text -eq 'Not signed in to Claude. Click Log in.') $stepLabels[5].Text
    Rec "timed-out sign-in is a clear red status" ($lblStatus.Text -eq 'Sign-in timed out. Click Log in to try again.' -and $lblStatus.ForeColor -eq $script:Red) $lblStatus.Text
    Rec "Log in button is visible" ($btnLogin.Visible)
    Set-StepOk 7 "App prepared"
    Set-StepOk 8 "OrcStrator is running"
    Set-StepOk 9 "Ready. OrcStrator opened in your browser."
    $script:AppPort = 3399
    $btnOpen.Enabled = $true
    Set-OrcStatus "OrcStrator is running. Click Log in to sign in to Claude." 'yellow'
    Set-UpdateBanner -Title "Could not check for updates" -Sub "You are on version 2.1.1." -ColorKey 'dim'
    Rec "progress is full once running" ($progress.Value -eq $progress.Maximum) "$($progress.Value)/$($progress.Maximum)"
    [System.Windows.Forms.Application]::DoEvents()
    $shown = @($stepLabels | Where-Object { $_.Visible } | ForEach-Object { $_.Text }) + $lblSub.Text + $lblStatus.Text
    $bad = @($shown | Where-Object { $_ -cmatch $devWords })
    Rec "no developer words in the window" ($bad.Count -eq 0) ($bad -join ' | ')
    [void](Save-Png $form "installed-window-not-signed-in.png")

    # The same window after "Log in" succeeded: updated in place.
    Set-OrcSignInResult -Auth @{ LoggedIn = $true; Method = 'oauth' }
    Rec "after sign-in the row turns into a success" ($stepLabels[5].Text -eq 'Signed in to Claude') $stepLabels[5].Text
    Rec "after sign-in the Log in button goes away" (-not $btnLogin.Visible)
    Rec "after sign-in the status is back to running" ($lblStatus.Text -eq 'OrcStrator is running!') $lblStatus.Text
    Set-UpdateBanner -Title "Up to date" -Sub "Version 2.1.1" -ColorKey 'green'
    [System.Windows.Forms.Application]::DoEvents()
    [void](Save-Png $form "installed-window-signed-in.png")

    # The installed-mode error box.
    $details = Get-OrcErrorDetails -Title "Port In Use" -Msg "m" -Details "Port 3334 is in use by another program: node.exe (PID 1)."
    Rec "details carry the raw reason and the log path" ($details -match 'PID 1' -and $details -match [regex]::Escape($LogFile))
    $dlg = New-OrcErrorDialog -Title "Port In Use" -Msg "Another program is using port 3334, which OrcStrator needs." `
        -Action "Close the other program using port 3334 and click Restart." -Details $details
    $dlg.StartPosition = "Manual"
    $dlg.Location = New-Object System.Drawing.Point(-3000, -3000)
    $dlg.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $btnTexts = @($dlg.Controls | Where-Object { $_ -is [System.Windows.Forms.Button] } | ForEach-Object { $_.Text })
    Rec "error box offers Copy details and OK" (($btnTexts -contains 'Copy details') -and ($btnTexts -contains 'OK')) ($btnTexts -join ',')
    $labels = @($dlg.Controls | Where-Object { $_ -is [System.Windows.Forms.Label] } | ForEach-Object { $_.Text })
    Rec "error box does not show the log path inline" (-not ($labels -join ' ' -match [regex]::Escape($LogFile)))
    Rec "error box ends with one plain action" ($labels[-1] -eq 'Close the other program using port 3334 and click Restart.') ($labels -join ' | ')
    [void](Save-Png $dlg "installed-error-dialog.png")
    $dlg.Close()

    # User-facing strings in the installed flow and the update banner.
    $src = Get-Content -LiteralPath $env:ORC_TEST_SETUP_SRC -Raw
    $flow = [regex]::Match($src, '(?s)function Invoke-OrcInstalledLaunch \{.*?\r?\n\}\r?\n').Value
    Rec "installed flow found" ($flow.Length -gt 1000)
    foreach ($gone in 'Backend running', 'Backend did not start', 'App engine bundled', 'Not logged in (you can log in later)') {
        Rec "installed flow no longer says '$gone'" (-not $flow.Contains($gone))
    }
    Rec "no user-facing text names the -Port switch or ORC_PORT" (-not ($src -match '"[^"\r\n]*(-Port switch|ORC_PORT setting)[^"\r\n]*"'))
    $shutdown = [regex]::Match($src, '(?s)\$btnShutdown\.Add_Click\(\{.*?MessageBox\]::Show\(\s*"([^"]*)"').Groups[1].Value
    Rec "shutdown dialog is plain" ($shutdown.StartsWith('This closes OrcStrator and stops every running chat.')) $shutdown
    $upd = [regex]::Match($src, '(?s)function Check-ForArtifactUpdates \{.*?\r?\n\}\r?\n').Value
    Rec "update check failure is plain" ($upd.Contains('"Could not check for updates"') -and $upd.Contains('You are on version $current.'))
    Rec "unverified update is plain" ($upd.Contains('This update could not be verified and was not installed. We will try again later.'))
    Rec "download link in error boxes is the release config's public one" ($script:DownloadUrl -eq 'https://updates.example.com/download/latest') $script:DownloadUrl
    Rec "sign-in intro tells the user what happens" ($script:ClaudeLoginIntro -eq 'Your browser will open. Sign in there, then come back here. You have 3 minutes.')
} catch {
    Rec "probe ran without an error" $false "$_ @ $($_.InvocationInfo.ScriptLineNumber)"
} finally {
    try { $form.Hide(); $form.Dispose() } catch { }
    [System.IO.File]::WriteAllText($env:ORC_TEST_RESULT, (ConvertTo-Json -InputObject @($results) -Depth 4))
}
exit 0
'@

try {
    $appDir = Join-Path $sandbox "app\installer"
    New-Item -ItemType Directory -Path $appDir -Force | Out-Null
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $icon = Join-Path $PSScriptRoot "icon.ico"
    if (Test-Path $icon) { Copy-Item $icon (Join-Path $appDir "icon.ico") }

    $src = [System.IO.File]::ReadAllText($SetupPath)
    # The source launcher has updates OFF: no update URL, no trusted key.
    $srcTrust = Get-OrcLauncherTrust -SetupText $src
    Check "source setup.ps1 ships no update URL" ($srcTrust.UpdateBaseUrl -eq '') "got '$($srcTrust.UpdateBaseUrl)'"
    Check "source setup.ps1 trusts no release key" (@($srcTrust.ReleasePublicKeys).Count -eq 0) "got $(@($srcTrust.ReleasePublicKeys).Count)"
    $src = Set-OrcLauncherReleaseConfig -SetupText $src -PublicKeyXml @($TestKey.PublicXml) -UpdateBaseUrl $TestUpdateBaseUrl
    $cut = $src.IndexOf($marker)
    Check "setup.ps1 has the launch marker" ($cut -gt 0)
    $cut = $src.LastIndexOf("`n", $cut)
    $script = $src.Substring(0, $cut) + "`r`n" + $probe
    $probePath = Join-Path $appDir "setup.ps1"
    [System.IO.File]::WriteAllText($probePath, $script, (New-Object System.Text.UTF8Encoding($false)))

    $resultPath = Join-Path $sandbox "result.json"
    $saved = @{}
    foreach ($n in 'ORCSTRATOR_DATA_DIR', 'ORC_UPDATE_BASE_URL', 'ORC_TEST_PNG_DIR', 'ORC_TEST_RESULT', 'ORC_TEST_SETUP_SRC') { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
    try {
        $env:ORCSTRATOR_DATA_DIR = Join-Path $sandbox "data"
        $env:ORC_UPDATE_BASE_URL = "http://127.0.0.1:9"
        $env:ORC_TEST_PNG_DIR = (Resolve-Path $OutDir).Path
        $env:ORC_TEST_RESULT = $resultPath
        $env:ORC_TEST_SETUP_SRC = $SetupPath
        & powershell -NoProfile -ExecutionPolicy Bypass -STA -File $probePath | Out-Null
    } finally {
        foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n], 'Process') }
    }

    Check "the probe wrote its results" (Test-Path $resultPath)
    if (Test-Path $resultPath) {
        # ConvertFrom-Json as an ARGUMENT: piped, PS 5.1 hands back the whole
        # array as one object and every check would collapse into one.
        $rows = ConvertFrom-Json -InputObject (Get-Content $resultPath -Raw)
        Check "the probe reported its checks" (@($rows).Count -ge 30) "$(@($rows).Count)"
        foreach ($r in $rows) { Check $r.name ($r.ok -eq $true) $r.detail }
    }
    foreach ($png in 'installed-window-not-signed-in.png', 'installed-window-signed-in.png', 'installed-error-dialog.png') {
        $p = Join-Path $OutDir $png
        Check "rendered $png" ((Test-Path $p) -and (Get-Item $p).Length -gt 2000)
    }
    Write-Host "PNGs: $OutDir"
}
finally {
    # Keep the PNGs when the caller asked for them somewhere of their own.
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
