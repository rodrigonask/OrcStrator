#Requires -Version 5.1
<#
.SYNOPSIS
    OrcStrator GUI Installer & Launcher
.DESCRIPTION
    WinForms GUI that checks/installs all dependencies, builds the project,
    launches server + client, and opens the browser.
#>

param(
    [switch]$SkipUpdates
)

# ── Assemblies ─────────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ── Paths ──────────────────────────────────────────────────────
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Split-Path -Parent $ScriptDir
$ServerDir   = Join-Path $RepoRoot "server"
$ClientDir   = Join-Path $RepoRoot "client"
$IconPath    = Join-Path $ScriptDir "icon.ico"
$LogFile     = Join-Path $env:TEMP "orcstrator-install.log"
$ServerPort  = 3333
$ClientPort  = 5173
$RepoUrl     = "https://github.com/rodrigonask/orcstrator.git"

# ── Theme Detection + Colors ───────────────────────────────────
# Auto-detect Windows light/dark mode from registry
$script:IsDarkMode = $false
try {
    $regVal = Get-ItemPropertyValue -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize" -Name "AppsUseLightTheme" -ErrorAction SilentlyContinue
    $script:IsDarkMode = ($regVal -eq 0)
} catch {
    $script:IsDarkMode = $false  # Default to light mode
}

# Theme palettes
$DarkTheme = @{
    Bg        = [System.Drawing.Color]::FromArgb(24, 24, 32)
    BgPanel   = [System.Drawing.Color]::FromArgb(34, 34, 46)
    BgLog     = [System.Drawing.Color]::FromArgb(18, 18, 24)
    Text      = [System.Drawing.Color]::FromArgb(228, 228, 231)
    TextDim   = [System.Drawing.Color]::FromArgb(140, 140, 155)
    Green     = [System.Drawing.Color]::FromArgb(74, 222, 128)
    GreenDark = [System.Drawing.Color]::FromArgb(22, 163, 74)
    Red       = [System.Drawing.Color]::FromArgb(248, 113, 113)
    Yellow    = [System.Drawing.Color]::FromArgb(250, 204, 21)
    Accent    = [System.Drawing.Color]::FromArgb(167, 139, 250)
    BtnBg     = [System.Drawing.Color]::FromArgb(34, 34, 46)
}

$LightTheme = @{
    Bg        = [System.Drawing.Color]::FromArgb(250, 250, 252)
    BgPanel   = [System.Drawing.Color]::FromArgb(255, 255, 255)
    BgLog     = [System.Drawing.Color]::FromArgb(245, 245, 248)
    Text      = [System.Drawing.Color]::FromArgb(24, 24, 32)
    TextDim   = [System.Drawing.Color]::FromArgb(100, 100, 115)
    Green     = [System.Drawing.Color]::FromArgb(22, 163, 74)
    GreenDark = [System.Drawing.Color]::FromArgb(21, 128, 61)
    Red       = [System.Drawing.Color]::FromArgb(220, 38, 38)
    Yellow    = [System.Drawing.Color]::FromArgb(161, 98, 7)
    Accent    = [System.Drawing.Color]::FromArgb(109, 40, 217)
    BtnBg     = [System.Drawing.Color]::FromArgb(255, 255, 255)
}

function Get-Theme {
    if ($script:IsDarkMode) { return $DarkTheme } else { return $LightTheme }
}

# Initialize current theme colors as script-scoped variables for easy access
$t = Get-Theme
$BgDark      = $t.Bg
$BgPanel     = $t.BgPanel
$Green       = $t.Green
$GreenDim    = $t.GreenDark
$Red         = $t.Red
$Yellow      = $t.Yellow
$TextPrimary = $t.Text
$TextDim     = $t.TextDim
$Accent      = $t.Accent

# ── Fonts ──────────────────────────────────────────────────────
$FontTitle   = New-Object System.Drawing.Font("Segoe UI", 18, [System.Drawing.FontStyle]::Bold)
$FontSub     = New-Object System.Drawing.Font("Segoe UI", 9)
$FontMono    = New-Object System.Drawing.Font("Cascadia Code,Consolas,Courier New", 9)
$FontMonoSm  = New-Object System.Drawing.Font("Cascadia Code,Consolas,Courier New", 8)
$FontBtn     = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$FontStep    = New-Object System.Drawing.Font("Segoe UI", 9.5)

# ── Generate Icon if missing ───────────────────────────────────
function New-OrcIcon {
    param([string]$OutPath)
    # 32x32 pixel art orc icon — dark bg, green orc face, purple accents
    $bmp = New-Object System.Drawing.Bitmap(32, 32)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

    # Palette
    $dk   = [System.Drawing.Color]::FromArgb(255, 18, 18, 24)
    $gr   = [System.Drawing.Color]::FromArgb(255, 34, 197, 94)
    $grd  = [System.Drawing.Color]::FromArgb(255, 22, 101, 52)
    $pur  = [System.Drawing.Color]::FromArgb(255, 139, 92, 246)
    $wh   = [System.Drawing.Color]::FromArgb(255, 228, 228, 231)
    $red  = [System.Drawing.Color]::FromArgb(255, 239, 68, 68)
    $yel  = [System.Drawing.Color]::FromArgb(255, 234, 179, 8)

    # Background circle
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $bgBrush = New-Object System.Drawing.SolidBrush($dk)
    $g.FillEllipse($bgBrush, 0, 0, 31, 31)

    # Orc face (green rounded rect)
    $faceBrush = New-Object System.Drawing.SolidBrush($gr)
    $g.FillEllipse($faceBrush, 8, 7, 16, 18)

    # Darker green jaw
    $jawBrush = New-Object System.Drawing.SolidBrush($grd)
    $g.FillEllipse($jawBrush, 10, 17, 12, 8)

    # Eyes (white with dark pupils)
    $eyeBrush = New-Object System.Drawing.SolidBrush($wh)
    $pupilBrush = New-Object System.Drawing.SolidBrush($dk)
    # Left eye
    $g.FillEllipse($eyeBrush, 11, 11, 5, 5)
    $g.FillEllipse($pupilBrush, 13, 12, 2, 3)
    # Right eye
    $g.FillEllipse($eyeBrush, 18, 11, 5, 5)
    $g.FillEllipse($pupilBrush, 19, 12, 2, 3)

    # Tusks (small yellow triangles from jaw)
    $tuskBrush = New-Object System.Drawing.SolidBrush($yel)
    $g.FillPolygon($tuskBrush, @(
        (New-Object System.Drawing.Point(12, 20)),
        (New-Object System.Drawing.Point(14, 20)),
        (New-Object System.Drawing.Point(13, 24))
    ))
    $g.FillPolygon($tuskBrush, @(
        (New-Object System.Drawing.Point(18, 20)),
        (New-Object System.Drawing.Point(20, 20)),
        (New-Object System.Drawing.Point(19, 24))
    ))

    # Horns (purple)
    $hornBrush = New-Object System.Drawing.SolidBrush($pur)
    $g.FillPolygon($hornBrush, @(
        (New-Object System.Drawing.Point(8, 12)),
        (New-Object System.Drawing.Point(11, 8)),
        (New-Object System.Drawing.Point(4, 3))
    ))
    $g.FillPolygon($hornBrush, @(
        (New-Object System.Drawing.Point(24, 12)),
        (New-Object System.Drawing.Point(21, 8)),
        (New-Object System.Drawing.Point(28, 3))
    ))

    $g.Dispose()

    # Save as .ico using proper Windows API
    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)
    $fs = New-Object System.IO.FileStream($OutPath, [System.IO.FileMode]::Create)
    $icon.Save($fs)
    $fs.Close()
    $icon.Dispose()
    $bmp.Dispose()
}

if (-not (Test-Path $IconPath)) {
    try { New-OrcIcon -OutPath $IconPath } catch { }
}

# ══════════════════════════════════════════════════════════════
#  BUILD THE FORM
# ══════════════════════════════════════════════════════════════

$form = New-Object System.Windows.Forms.Form
$form.Text = "OrcStrator"
$form.Size = New-Object System.Drawing.Size(560, 700)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false
$form.BackColor = $BgDark
$form.ForeColor = $TextPrimary
if (Test-Path $IconPath) {
    try { $form.Icon = New-Object System.Drawing.Icon($IconPath) } catch { }
}

# ── Title ──────────────────────────────────────────────────────
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "ORCSTRATOR"
$lblTitle.Font = $FontTitle
$lblTitle.ForeColor = $Green
$lblTitle.AutoSize = $true
$lblTitle.Location = New-Object System.Drawing.Point(20, 16)
$form.Controls.Add($lblTitle)

$lblSub = New-Object System.Windows.Forms.Label
$lblSub.Text = "Multi-Instance Claude Orchestration Platform"
$lblSub.Font = $FontSub
$lblSub.ForeColor = $TextDim
$lblSub.AutoSize = $true
$lblSub.Location = New-Object System.Drawing.Point(22, 50)
$form.Controls.Add($lblSub)

# ── Theme Toggle Button ───────────────────────────────────────
$btnTheme = New-Object System.Windows.Forms.Button
$btnTheme.Text = if ($script:IsDarkMode) { "Light" } else { "Dark" }
$btnTheme.Font = $FontSub
$btnTheme.Size = New-Object System.Drawing.Size(56, 26)
$btnTheme.Location = New-Object System.Drawing.Point(469, 18)
$btnTheme.FlatStyle = "Flat"
$btnTheme.FlatAppearance.BorderColor = $TextDim
$btnTheme.FlatAppearance.BorderSize = 1
$btnTheme.BackColor = $BgPanel
$btnTheme.ForeColor = $TextDim
$btnTheme.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnTheme.Add_Click({ Apply-Theme (-not $script:IsDarkMode) })
$form.Controls.Add($btnTheme)

# ── Steps Panel ────────────────────────────────────────────────
$panelSteps = New-Object System.Windows.Forms.Panel
$panelSteps.Location = New-Object System.Drawing.Point(20, 80)
$panelSteps.Size = New-Object System.Drawing.Size(505, 310)
$panelSteps.BackColor = $BgPanel
$panelSteps.BorderStyle = if ($script:IsDarkMode) { "None" } else { "FixedSingle" }
$panelSteps.Padding = New-Object System.Windows.Forms.Padding(12, 10, 12, 10)
$form.Controls.Add($panelSteps)

# Step labels — we'll create 10 rows
$stepLabels = @()
$stepIcons  = @()
$stepNames = @(
    "winget"
    "Git"
    "Node.js + npm"
    "C++ Build Tools"
    "Claude CLI"
    "Authentication"
    "npm packages"
    "Build"
    "Server"
    "Client"
)

for ($i = 0; $i -lt $stepNames.Count; $i++) {
    $y = 8 + ($i * 29)

    $icon = New-Object System.Windows.Forms.Label
    $icon.Text = [char]0x2022  # bullet
    $icon.Font = $FontStep
    $icon.ForeColor = $TextDim
    $icon.Location = New-Object System.Drawing.Point(12, $y)
    $icon.Size = New-Object System.Drawing.Size(22, 22)
    $icon.TextAlign = "MiddleCenter"
    $panelSteps.Controls.Add($icon)
    $stepIcons += $icon

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $stepNames[$i]
    $lbl.Font = $FontStep
    $lbl.ForeColor = $TextDim
    $lbl.Location = New-Object System.Drawing.Point(36, $y)
    $lbl.Size = New-Object System.Drawing.Size(460, 22)
    $lbl.TextAlign = "MiddleLeft"
    $lbl.AutoEllipsis = $true
    $panelSteps.Controls.Add($lbl)
    $stepLabels += $lbl
}

# ── Progress Bar ───────────────────────────────────────────────
$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(20, 400)
$progress.Size = New-Object System.Drawing.Size(505, 8)
$progress.Style = "Continuous"
$progress.Minimum = 0
$progress.Maximum = $stepNames.Count
$progress.Value = 0
$form.Controls.Add($progress)

# ── Status Label ───────────────────────────────────────────────
$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Text = "Initializing..."
$lblStatus.Font = $FontMono
$lblStatus.ForeColor = $TextDim
$lblStatus.Location = New-Object System.Drawing.Point(20, 416)
$lblStatus.Size = New-Object System.Drawing.Size(505, 20)
$form.Controls.Add($lblStatus)

# ── Log Box (collapsed, expandable) ───────────────────────────
$txtLog = New-Object System.Windows.Forms.RichTextBox
$txtLog.Location = New-Object System.Drawing.Point(20, 442)
$txtLog.Size = New-Object System.Drawing.Size(505, 100)
$txtLog.BackColor = $t.BgLog
$txtLog.ForeColor = $TextDim
$txtLog.Font = $FontMonoSm
$txtLog.ReadOnly = $true
$txtLog.BorderStyle = "None"
$txtLog.ScrollBars = "Vertical"
$txtLog.Visible = $false
$form.Controls.Add($txtLog)

$btnToggleLog = New-Object System.Windows.Forms.LinkLabel
$btnToggleLog.Text = "Show log"
$btnToggleLog.Font = $FontMonoSm
$btnToggleLog.LinkColor = $TextDim
$btnToggleLog.ActiveLinkColor = $Accent
$btnToggleLog.Location = New-Object System.Drawing.Point(20, 442)
$btnToggleLog.AutoSize = $true
$btnToggleLog.Add_Click({
    if ($txtLog.Visible) {
        $txtLog.Visible = $false
        $btnToggleLog.Text = "Show log"
        $btnToggleLog.Location = New-Object System.Drawing.Point(20, 442)
        $form.Size = New-Object System.Drawing.Size(560, 700)
    } else {
        $txtLog.Visible = $true
        $txtLog.Location = New-Object System.Drawing.Point(20, 462)
        $btnToggleLog.Text = "Hide log"
        $btnToggleLog.Location = New-Object System.Drawing.Point(20, 442)
        $form.Size = New-Object System.Drawing.Size(560, 820)
    }
})
$form.Controls.Add($btnToggleLog)

# ── Action Buttons ─────────────────────────────────────────────
$btnOpen = New-Object System.Windows.Forms.Button
$btnOpen.Text = "Open OrcStrator"
$btnOpen.Font = $FontBtn
$btnOpen.Size = New-Object System.Drawing.Size(160, 48)
$btnOpen.Location = New-Object System.Drawing.Point(20, 540)
$btnOpen.FlatStyle = "Flat"
$btnOpen.FlatAppearance.BorderColor = $Green
$btnOpen.FlatAppearance.BorderSize = 2
$btnOpen.BackColor = $BgPanel
$btnOpen.ForeColor = $Green
$btnOpen.Enabled = $false
$btnOpen.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnOpen.Add_Click({
    Start-Process "http://localhost:$ClientPort"
})
$form.Controls.Add($btnOpen)

$btnShortcut = New-Object System.Windows.Forms.Button
$btnShortcut.Text = "Desktop Shortcut"
$btnShortcut.Font = $FontSub
$btnShortcut.Size = New-Object System.Drawing.Size(160, 48)
$btnShortcut.Location = New-Object System.Drawing.Point(192, 540)
$btnShortcut.FlatStyle = "Flat"
$btnShortcut.FlatAppearance.BorderColor = $Accent
$btnShortcut.FlatAppearance.BorderSize = 1
$btnShortcut.BackColor = $BgPanel
$btnShortcut.ForeColor = $Accent
$btnShortcut.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnShortcut.Add_Click({
    try {
        $desktop = [System.Environment]::GetFolderPath("Desktop")
        $batPath = Join-Path $RepoRoot "orcstrator.bat"
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut((Join-Path $desktop "OrcStrator.lnk"))
        $shortcut.TargetPath = $batPath
        $shortcut.WorkingDirectory = $RepoRoot
        $shortcut.Description = "Launch OrcStrator"
        if (Test-Path $IconPath) { $shortcut.IconLocation = $IconPath }
        $shortcut.Save()
        [System.Windows.Forms.MessageBox]::Show(
            "Desktop shortcut created!`nDouble-click 'OrcStrator' on your desktop to launch.",
            "Shortcut Created",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Could not create shortcut: $_",
            "Error",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
    }
})
$form.Controls.Add($btnShortcut)

$btnShutdown = New-Object System.Windows.Forms.Button
$btnShutdown.Text = "Shutdown All"
$btnShutdown.Font = $FontSub
$btnShutdown.Size = New-Object System.Drawing.Size(160, 48)
$btnShutdown.Location = New-Object System.Drawing.Point(364, 540)
$btnShutdown.FlatStyle = "Flat"
$btnShutdown.FlatAppearance.BorderColor = $Red
$btnShutdown.FlatAppearance.BorderSize = 1
$btnShutdown.BackColor = $BgPanel
$btnShutdown.ForeColor = $Red
$btnShutdown.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnShutdown.Add_Click({
    $confirm = [System.Windows.Forms.MessageBox]::Show(
        "This will stop the OrcStrator server and client.`nAny running Claude instances will be terminated.`n`nContinue?",
        "Shutdown OrcStrator",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($confirm -eq [System.Windows.Forms.DialogResult]::Yes) {
        $lblStatus.Text = "Shutting down..."
        $lblStatus.ForeColor = $script:Red
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()

        Stop-OrcStrator

        $lblStatus.Text = "Shut down. Closing in 3s..."
        $lblStatus.ForeColor = $script:TextDim
        $btnOpen.Enabled = $false
        $btnShutdown.Enabled = $false
        $form.Refresh()

        $closeTimer = New-Object System.Windows.Forms.Timer
        $closeTimer.Interval = 3000
        $closeTimer.Add_Tick({
            $closeTimer.Stop()
            $closeTimer.Dispose()
            $form.Close()
        })
        $closeTimer.Start()
    }
})
$form.Controls.Add($btnShutdown)

# ── Update Banner (full width, below action buttons) ──────────
$FontUpdateTitle = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$FontUpdateSub   = New-Object System.Drawing.Font("Segoe UI", 8.5)

$btnUpdate = New-Object System.Windows.Forms.Button
$btnUpdate.Size = New-Object System.Drawing.Size(505, 52)
$btnUpdate.Location = New-Object System.Drawing.Point(20, 596)
$btnUpdate.FlatStyle = "Flat"
$btnUpdate.FlatAppearance.BorderColor = $TextDim
$btnUpdate.FlatAppearance.BorderSize = 1
$btnUpdate.BackColor = $BgPanel
$btnUpdate.ForeColor = $TextDim
$btnUpdate.Cursor = [System.Windows.Forms.Cursors]::Default
$btnUpdate.Enabled = $false
$btnUpdate.Visible = $true
$btnUpdate.TextAlign = "MiddleLeft"
$btnUpdate.Padding = New-Object System.Windows.Forms.Padding(0)
$script:UpdateAvailable = $false
$script:CommitsBehind = 0
$script:ServerPid = $null
$script:ClientPid = $null
$script:ShutdownDone = $false

# Custom paint for two-line text (title + subtitle)
$script:UpdateTitle = "Checking for updates..."
$script:UpdateSub = ""

$btnUpdate.Add_Paint({
    param($s, $e)
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $rect = $s.ClientRectangle
    $pad = 14

    # Title line
    $titleBrush = New-Object System.Drawing.SolidBrush($s.ForeColor)
    $g.DrawString($script:UpdateTitle, $FontUpdateTitle, $titleBrush, $pad, 6)
    $titleBrush.Dispose()

    # Subtitle line
    if ($script:UpdateSub) {
        $subColor = if ($script:IsDarkMode) {
            [System.Drawing.Color]::FromArgb(160, 160, 175)
        } else {
            [System.Drawing.Color]::FromArgb(100, 100, 115)
        }
        $subBrush = New-Object System.Drawing.SolidBrush($subColor)
        $g.DrawString($script:UpdateSub, $FontUpdateSub, $subBrush, $pad, 28)
        $subBrush.Dispose()
    }
})

$btnUpdate.Add_Click({
    if (-not $script:UpdateAvailable) { return }
    $btnUpdate.Enabled = $false
    $btnUpdate.Cursor = [System.Windows.Forms.Cursors]::Default
    $script:UpdateTitle = "Updating..."
    $script:UpdateSub = "Pulling latest changes from GitHub..."
    $btnUpdate.ForeColor = $script:Yellow
    $btnUpdate.FlatAppearance.BorderColor = $script:Yellow
    $btnUpdate.Invalidate()
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()

    $git = Find-Exe "git"
    $r = Run-Cmd $git "pull --ff-only" -WorkDir $RepoRoot -TimeoutSec 60
    [System.Windows.Forms.Application]::DoEvents()

    if ($r.ExitCode -eq 0) {
        $npm = Find-Exe "npm.cmd"
        if (-not $npm) { $npm = Find-Exe "npm" }
        $script:UpdateTitle = "Rebuilding..."
        $script:UpdateSub = "Compiling updated packages..."
        $btnUpdate.Invalidate()
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
        Run-Cmd $npm "run build -w shared" -WorkDir $RepoRoot -TimeoutSec 60
        [System.Windows.Forms.Application]::DoEvents()

        $script:UpdateAvailable = $false
        $script:UpdateTitle = "Updated successfully!"
        $script:UpdateSub = "Restart OrcStrator to apply changes."
        $btnUpdate.ForeColor = $script:Green
        $btnUpdate.FlatAppearance.BorderColor = $script:Green
    } else {
        $script:UpdateTitle = "Update failed"
        $script:UpdateSub = "Try running 'git pull' manually in the project folder."
        $btnUpdate.ForeColor = $script:Red
        $btnUpdate.FlatAppearance.BorderColor = $script:Red
    }
    $btnUpdate.Invalidate()
    $form.Refresh()
})
$form.Controls.Add($btnUpdate)

# ── Stop-OrcStrator (3-layer bulletproof kill) ─────────────────
function Stop-OrcStrator {
    if ($script:ShutdownDone) { return }
    $script:ShutdownDone = $true

    # Collect all PIDs to kill at once
    $pidsToKill = @()

    # Layer 1: Stored PIDs
    foreach ($pid in @($script:ServerPid, $script:ClientPid)) {
        if ($pid) { $pidsToKill += $pid }
    }

    # Layer 2: Anything listening on our ports
    foreach ($port in @($ServerPort, $ClientPort)) {
        try {
            @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) | ForEach-Object {
                if ($_.OwningProcess -gt 0) { $pidsToKill += $_.OwningProcess }
            }
        } catch { }
    }

    # Layer 3: cmd.exe windows with OrcStrator title
    try {
        Get-Process cmd -ErrorAction SilentlyContinue | Where-Object {
            $_.MainWindowTitle -like "*OrcStrator*"
        } | ForEach-Object { $pidsToKill += $_.Id }
    } catch { }

    # Kill all unique PIDs with process tree, fire-and-forget (fast)
    $pidsToKill | Sort-Object -Unique | ForEach-Object {
        try { & taskkill /PID $_ /T /F 2>$null } catch { }
    }

    $script:ServerPid = $null
    $script:ClientPid = $null
}

# ── Apply Theme Function ───────────────────────────────────────
function Apply-Theme {
    param([bool]$Dark)
    $script:IsDarkMode = $Dark
    $t = if ($Dark) { $DarkTheme } else { $LightTheme }

    # Update script-scoped color vars
    $script:BgDark      = $t.Bg
    $script:BgPanel     = $t.BgPanel
    $script:Green       = $t.Green
    $script:GreenDim    = $t.GreenDark
    $script:Red         = $t.Red
    $script:Yellow      = $t.Yellow
    $script:TextPrimary = $t.Text
    $script:TextDim     = $t.TextDim
    $script:Accent      = $t.Accent

    # Form
    $form.BackColor = $t.Bg
    $form.ForeColor = $t.Text

    # Title
    $lblTitle.ForeColor = $t.Green
    $lblSub.ForeColor = $t.TextDim

    # Theme button
    $btnTheme.Text = if ($Dark) { "Light" } else { "Dark" }
    $btnTheme.ForeColor = $t.TextDim
    $btnTheme.BackColor = $t.BgPanel
    $btnTheme.FlatAppearance.BorderColor = $t.TextDim

    # Steps panel
    $panelSteps.BackColor = $t.BgPanel
    $panelSteps.BorderStyle = if ($Dark) { "None" } else { "FixedSingle" }

    # Step icons/labels - preserve their state colors
    for ($i = 0; $i -lt $stepIcons.Count; $i++) {
        $ic = $stepIcons[$i]
        $lb = $stepLabels[$i]
        # Map old colors to new theme equivalents
        if ($ic.ForeColor.G -gt 150 -and $ic.ForeColor.R -lt 100) {
            # Was green (completed)
            $ic.ForeColor = $t.Green
            $lb.ForeColor = $t.Green
        } elseif ($ic.ForeColor.R -gt 200 -and $ic.ForeColor.G -lt 150 -and $ic.ForeColor.G -gt 100) {
            # Was yellow (active)
            $ic.ForeColor = $t.Yellow
            $lb.ForeColor = $t.Text
        } elseif ($ic.ForeColor.R -gt 200 -and $ic.ForeColor.G -lt 100) {
            # Was red (failed)
            $ic.ForeColor = $t.Red
            $lb.ForeColor = $t.Red
        } else {
            # Pending/dim
            $ic.ForeColor = $t.TextDim
            $lb.ForeColor = $t.TextDim
        }
    }

    # Status label - preserve state color
    if ($lblStatus.ForeColor.G -gt 150 -and $lblStatus.ForeColor.R -lt 100) {
        $lblStatus.ForeColor = $t.Green
    } elseif ($lblStatus.ForeColor.R -gt 200 -and $lblStatus.ForeColor.G -gt 100) {
        $lblStatus.ForeColor = $t.Yellow
    } elseif ($lblStatus.ForeColor.R -gt 200 -and $lblStatus.ForeColor.G -lt 100) {
        $lblStatus.ForeColor = $t.Red
    } else {
        $lblStatus.ForeColor = $t.TextDim
    }

    # Log box
    $txtLog.BackColor = $t.BgLog
    $txtLog.ForeColor = $t.TextDim
    $btnToggleLog.LinkColor = $t.TextDim
    $btnToggleLog.ActiveLinkColor = $t.Accent

    # Buttons
    $btnOpen.BackColor = $t.BtnBg
    $btnOpen.ForeColor = $t.Green
    $btnOpen.FlatAppearance.BorderColor = $t.Green

    $btnShortcut.BackColor = $t.BtnBg
    $btnShortcut.ForeColor = $t.Accent
    $btnShortcut.FlatAppearance.BorderColor = $t.Accent

    $btnShutdown.BackColor = $t.BtnBg
    $btnShutdown.ForeColor = $t.Red
    $btnShutdown.FlatAppearance.BorderColor = $t.Red

    $btnUpdate.BackColor = $t.BtnBg
    if (-not $script:UpdateAvailable) {
        $btnUpdate.ForeColor = $t.TextDim
        $btnUpdate.FlatAppearance.BorderColor = $t.TextDim
    }

    $form.Refresh()
}

# ══════════════════════════════════════════════════════════════
#  HELPER FUNCTIONS
# ══════════════════════════════════════════════════════════════

function Log {
    param([string]$Msg)
    $timestamp = Get-Date -Format "HH:mm:ss"
    $line = "[$timestamp] $Msg"
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
    $txtLog.AppendText("$line`r`n")
    $txtLog.ScrollToCaret()
}

function Set-StepActive {
    param([int]$Index, [string]$Msg)
    if ($Index -ge 0 -and $Index -lt $stepNames.Count) {
        $stepIcons[$Index].Text = [char]0x25B6  # right triangle
        $stepIcons[$Index].ForeColor = $script:Yellow
        $stepLabels[$Index].ForeColor = $script:TextPrimary
        if ($Msg) { $stepLabels[$Index].Text = "$($stepNames[$Index]) - $Msg" }
    }
    $lblStatus.Text = $(if ($Msg) { $Msg } else { $stepNames[$Index] })
    $lblStatus.ForeColor = $script:Yellow
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

function Set-StepOk {
    param([int]$Index, [string]$Detail)
    if ($Index -ge 0 -and $Index -lt $stepNames.Count) {
        $stepIcons[$Index].Text = [char]0x2714  # checkmark
        $stepIcons[$Index].ForeColor = $script:Green
        $stepLabels[$Index].ForeColor = $script:Green
        if ($Detail) {
            $stepLabels[$Index].Text = "$($stepNames[$Index]) - $Detail"
        }
    }
    $progress.Value = [Math]::Min($Index + 1, $progress.Maximum)
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

function Set-StepFail {
    param([int]$Index, [string]$Msg)
    if ($Index -ge 0 -and $Index -lt $stepNames.Count) {
        $stepIcons[$Index].Text = [char]0x2718  # X mark
        $stepIcons[$Index].ForeColor = $script:Red
        $stepLabels[$Index].ForeColor = $script:Red
        if ($Msg) {
            $stepLabels[$Index].Text = "$($stepNames[$Index]) - $Msg"
        }
    }
    $lblStatus.Text = $Msg
    $lblStatus.ForeColor = $script:Red
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

function Set-StepSkip {
    param([int]$Index, [string]$Msg)
    if ($Index -ge 0 -and $Index -lt $stepNames.Count) {
        $stepIcons[$Index].Text = [char]0x2013  # en dash
        $stepIcons[$Index].ForeColor = $script:TextDim
        $stepLabels[$Index].ForeColor = $script:TextDim
        if ($Msg) {
            $stepLabels[$Index].Text = "$($stepNames[$Index]) - $Msg"
        }
    }
    $progress.Value = [Math]::Min($Index + 1, $progress.Maximum)
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

function Show-Error {
    param([string]$Title, [string]$Msg)
    $lblStatus.Text = $Msg
    $lblStatus.ForeColor = $script:Red
    $form.Refresh()
    [System.Windows.Forms.MessageBox]::Show(
        "$Msg`n`nCheck the log for details:`n$LogFile",
        $Title,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
}

function Refresh-EnvPath {
    # Pull fresh PATH from registry to pick up winget/msi installs
    try {
        $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath    = [System.Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path    = "$machinePath;$userPath"
    } catch { }
    # Add common install locations
    $extras = @(
        "$env:ProgramFiles\Git\cmd",
        "$env:ProgramFiles\nodejs",
        "${env:ProgramFiles(x86)}\Git\cmd",
        "$env:APPDATA\npm",
        "$env:LOCALAPPDATA\Programs\nodejs",
        "$env:USERPROFILE\.local\bin"
    )
    foreach ($p in $extras) {
        if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) {
            $env:Path = "$p;$($env:Path)"
        }
    }
}

function Find-Exe {
    param([string]$Name)
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    return $null
}

function Run-Cmd {
    param([string]$Cmd, [string]$CmdArgs, [string]$WorkDir, [int]$TimeoutSec = 300)
    Log "Running: $Cmd $CmdArgs"

    # Use a temp .bat to reliably handle paths with spaces + capture output
    $uid = [guid]::NewGuid().ToString('N').Substring(0,8)
    $outFile = Join-Path $env:TEMP "orc_out_$uid.tmp"
    $errFile = Join-Path $env:TEMP "orc_err_$uid.tmp"
    $batFile = Join-Path $env:TEMP "orc_run_$uid.bat"

    # Write a one-line bat that runs the command with proper quoting
    Set-Content -Path $batFile -Value "@`"$Cmd`" $CmdArgs > `"$outFile`" 2> `"$errFile`"" -Encoding ASCII

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/c `"$batFile`""
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }

    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch {
        Log "Failed to start: $Cmd - $_"
        return @{ ExitCode = -1; Output = ""; Error = "Failed to start: $_" }
    }

    # Poll for completion while keeping the UI responsive
    $deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
    while (-not $proc.HasExited) {
        [System.Windows.Forms.Application]::DoEvents()
        if ([DateTime]::Now -gt $deadline) {
            try { $proc.Kill() } catch { }
            Log "TIMEOUT after ${TimeoutSec}s"
            break
        }
        Start-Sleep -Milliseconds 150
    }

    $stdout = ""; $stderr = ""
    try { if (Test-Path $outFile) { $stdout = [System.IO.File]::ReadAllText($outFile).Trim() } } catch { }
    try { if (Test-Path $errFile) { $stderr = [System.IO.File]::ReadAllText($errFile).Trim() } } catch { }
    Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
    Remove-Item $batFile -Force -ErrorAction SilentlyContinue

    if ($stdout) { Log $stdout.Substring(0, [Math]::Min($stdout.Length, 500)) }
    if ($stderr) { Log "STDERR: $($stderr.Substring(0, [Math]::Min($stderr.Length, 500)))" }

    return @{
        ExitCode = $proc.ExitCode
        Output   = $stdout
        Error    = $stderr
    }
}

function Test-TcpPort {
    param([int]$Port, [switch]$Verbose)
    # Check if anything is listening on this port (works for both IPv4 and IPv6)
    try {
        $listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
        $found = $listener.Count -gt 0
        if ($Verbose) {
            if ($found) {
                $addrs = ($listener | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) PID=$($_.OwningProcess)" }) -join ", "
                Log "  Port ${Port}: LISTENING ($addrs)"
            } else {
                # Check all states on this port for debugging
                $all = @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue)
                if ($all.Count -gt 0) {
                    $states = ($all | Group-Object State | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ", "
                    Log "  Port ${Port}: not listening (states: $states)"
                } else {
                    Log "  Port ${Port}: no connections at all"
                }
            }
        }
        return $found
    } catch {
        if ($Verbose) { Log "  Port ${Port}: check error - $_" }
        return $false
    }
}

# ══════════════════════════════════════════════════════════════
#  UPDATE CHECK
# ══════════════════════════════════════════════════════════════

function Check-ForUpdates {
    Log "Checking for OrcStrator updates..."
    $script:UpdateTitle = "Checking for updates..."
    $script:UpdateSub = ""
    $btnUpdate.Invalidate()
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()

    $git = Find-Exe "git"
    if (-not $git) {
        $script:UpdateTitle = "Updates unavailable"
        $script:UpdateSub = "Git not found."
        $btnUpdate.Invalidate()
        return
    }

    # Get local HEAD date
    try {
        $localDate = (& $git -C $RepoRoot log -1 --format="%ci" 2>&1) -join ""
        $localCommitDate = [DateTime]::Parse($localDate.Trim())
        $daysOld = [Math]::Floor(([DateTime]::Now - $localCommitDate).TotalDays)
    } catch {
        $daysOld = -1
        Log "Could not read local commit date: $_"
    }

    # Fetch from remote (quick, just metadata)
    $fetchResult = Run-Cmd $git "fetch --quiet" -WorkDir $RepoRoot -TimeoutSec 15
    [System.Windows.Forms.Application]::DoEvents()

    # Count commits behind
    try {
        $behindOutput = (& $git -C $RepoRoot rev-list "HEAD..origin/master" --count 2>&1) -join ""
        $script:CommitsBehind = [int]$behindOutput.Trim()
    } catch {
        $script:CommitsBehind = 0
        Log "Could not check commits behind: $_"
    }

    $daysText = if ($daysOld -le 0) { "today" } elseif ($daysOld -eq 1) { "yesterday" } else { "$daysOld days ago" }
    Log "Update check: $($script:CommitsBehind) commits behind, local is ${daysOld} days old"

    if ($script:CommitsBehind -gt 0) {
        $script:UpdateAvailable = $true
        $btnUpdate.Enabled = $true
        $btnUpdate.Cursor = [System.Windows.Forms.Cursors]::Hand
        $updatesWord = if ($script:CommitsBehind -eq 1) { "update" } else { "updates" }
        $script:UpdateTitle = "Update available"
        $script:UpdateSub = "Click to update. Last updated $daysText - $($script:CommitsBehind) new $updatesWord"
        $btnUpdate.ForeColor = $script:Yellow
        $btnUpdate.FlatAppearance.BorderColor = $script:Yellow
        $btnUpdate.FlatAppearance.BorderSize = 2
    } else {
        $script:UpdateAvailable = $false
        $btnUpdate.Enabled = $false
        $btnUpdate.Cursor = [System.Windows.Forms.Cursors]::Default
        $script:UpdateTitle = "Up to date"
        $script:UpdateSub = "Last updated $daysText"
        $btnUpdate.ForeColor = $script:Green
        $btnUpdate.FlatAppearance.BorderColor = $script:Green
        $btnUpdate.FlatAppearance.BorderSize = 1
    }
    $btnUpdate.Invalidate()
    $form.Refresh()
}

# ══════════════════════════════════════════════════════════════
#  INSTALLATION LOGIC (runs after form is shown)
# ══════════════════════════════════════════════════════════════

function Run-Setup {
    $needsRestart = $false
    Log "OrcStrator setup started - $(Get-Date)"
    Log "Repo root: $RepoRoot"

    # ── Step 0: winget ─────────────────────────────────────────
    Set-StepActive 0
    $winget = Find-Exe "winget"
    if ($winget) {
        Log "winget found: $winget"
        Set-StepOk 0
    } else {
        Set-StepFail 0 "Not found"
        Show-Error "winget Required" "winget is not installed.`n`nOpen the Microsoft Store, search for 'App Installer', and install it.`nThen run OrcStrator again."
        return
    }

    # ── Step 1: Git ────────────────────────────────────────────
    Set-StepActive 1
    $git = Find-Exe "git"
    if ($git) {
        try { $ver = (& $git --version 2>&1) -join " " } catch { $ver = "found" }
        Log "Git: $ver"
        Set-StepOk 1 $ver
    } else {
        Set-StepActive 1 "Installing via winget..."
        Log "Git not found, installing..."
        $r = Run-Cmd $winget "install Git.Git --accept-source-agreements --accept-package-agreements" -TimeoutSec 300
        Refresh-EnvPath
        $git = Find-Exe "git"
        if ($git) {
            Set-StepOk 1 "Installed"
            $needsRestart = $true
        } else {
            Set-StepFail 1 "Install failed"
            Show-Error "Git Installation Failed" "Could not install Git automatically.`nPlease install Git from https://git-scm.com and try again."
            return
        }
    }

    # ── Step 2: Node.js + npm ──────────────────────────────────
    Set-StepActive 2
    $node = Find-Exe "node"
    $npm  = Find-Exe "npm.cmd"
    if (-not $npm) { $npm = Find-Exe "npm" }
    if ($node -and $npm) {
        try { $nodeVer = (& $node -v 2>&1) -join " " } catch { $nodeVer = "?" }
        try { $npmVer  = (& $npm -v 2>&1) -join " " } catch { $npmVer = "?" }
        Log "Node $nodeVer, npm $npmVer"
        Set-StepOk 2 "Node $nodeVer / npm $npmVer"
    } else {
        Set-StepActive 2 "Installing Node.js 22 via winget..."
        Log "Node/npm not found, installing..."
        $r = Run-Cmd $winget "install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements" -TimeoutSec 300
        if ($r.ExitCode -ne 0) {
            $r = Run-Cmd $winget "install OpenJS.NodeJS.22 --accept-source-agreements --accept-package-agreements" -TimeoutSec 300
        }
        Refresh-EnvPath
        $node = Find-Exe "node"
        $npm  = Find-Exe "npm"
        if ($node -and $npm) {
            Set-StepOk 2 "Installed"
            $needsRestart = $true
        } else {
            Set-StepFail 2 "Install failed"
            Show-Error "Node.js Installation Failed" "Could not install Node.js automatically.`nPlease install Node.js from https://nodejs.org and try again."
            return
        }
    }

    # ── Step 3: C++ Build Tools ────────────────────────────────
    Set-StepActive 3
    $hasVcTools = $false
    # Check vswhere
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) { $hasVcTools = $true }
    # Check VS directories
    if (-not $hasVcTools) {
        $vsDirs = @(
            "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools",
            "$env:ProgramFiles\Microsoft Visual Studio\2022\BuildTools",
            "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\BuildTools"
        )
        foreach ($d in $vsDirs) {
            if (Test-Path $d) { $hasVcTools = $true; break }
        }
    }
    # Check cl.exe
    if (-not $hasVcTools) {
        $cl = Find-Exe "cl"
        if ($cl) { $hasVcTools = $true }
    }

    if ($hasVcTools) {
        Log "C++ Build Tools found"
        Set-StepOk 3
    } else {
        Set-StepActive 3 "Installing... (this takes a few minutes)"
        Log "C++ Build Tools not found, installing..."
        $r = Run-Cmd $winget 'install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' -TimeoutSec 600
        if ($r.ExitCode -eq 0) {
            Set-StepOk 3 "Installed (restart recommended)"
            Log "C++ Build Tools installed - restart may be needed"
            $needsRestart = $true
        } else {
            # Not fatal - try to continue, npm install will fail if truly needed
            Set-StepFail 3 "Install may have failed"
            Log "C++ Build Tools install returned non-zero: $($r.ExitCode)"
            Log "Continuing anyway - npm install will reveal if this is needed"
        }
    }

    # ── Restart gate ───────────────────────────────────────────
    if ($needsRestart) {
        # Refresh once more
        Refresh-EnvPath
        # Check if the critical tools work now
        $canContinue = (Find-Exe "node") -and (Find-Exe "npm") -and (Find-Exe "git")
        if (-not $canContinue) {
            $lblStatus.Text = "Dependencies installed - please restart and run again"
            $lblStatus.ForeColor = $Yellow
            [System.Windows.Forms.MessageBox]::Show(
                "Some dependencies were just installed and need a fresh terminal session.`n`nPlease close this window and double-click orcstrator.bat again.",
                "Restart Required",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Information
            )
            return
        }
    }

    # ── Step 4: Claude CLI ─────────────────────────────────────
    Set-StepActive 4
    # Prefer claude.cmd on Windows (the .exe can hang trying interactive setup)
    $claude = Find-Exe "claude.cmd"
    if (-not $claude) { $claude = Find-Exe "claude" }
    if ($claude) {
        # Read version from npm package.json instead of spawning claude (which can hang)
        $ver = "installed"
        $claudePkgJson = Join-Path $env:APPDATA "npm\node_modules\@anthropic-ai\claude-code\package.json"
        if (Test-Path $claudePkgJson) {
            try {
                $pkg = Get-Content $claudePkgJson -Raw | ConvertFrom-Json
                $ver = $pkg.version
            } catch { }
        }
        Log "Claude CLI found at: $claude (v$ver)"
        Set-StepOk 4 "v$ver"
    } else {
        Set-StepActive 4 "Installing via npm..."
        Log "Claude CLI not found, installing..."
        $npmExe = Find-Exe "npm.cmd"
        if (-not $npmExe) { $npmExe = Find-Exe "npm" }
        $r = Run-Cmd $npmExe "install -g @anthropic-ai/claude-code" -TimeoutSec 120
        Refresh-EnvPath
        $claude = Find-Exe "claude"
        if (-not $claude) { $claude = Find-Exe "claude.cmd" }
        if ($claude) {
            Set-StepOk 4 "Installed"
        } else {
            Set-StepFail 4 "Install failed"
            Show-Error "Claude CLI Failed" "Could not install Claude CLI.`nTry manually: npm install -g @anthropic-ai/claude-code"
            return
        }
    }

    # Ensure claude.cmd shim exists (OrcStrator spawns .cmd on Windows)
    $claudeCmd = Find-Exe "claude.cmd"
    if (-not $claudeCmd) {
        $claudeExe = Find-Exe "claude"
        if ($claudeExe) {
            $claudeDir = Split-Path $claudeExe
            $shimPath = Join-Path $claudeDir "claude.cmd"
            try {
                Set-Content -Path $shimPath -Value "@echo off`r`n`"%~dp0claude.exe`" %*" -Encoding ASCII
                Log "Created claude.cmd shim at $shimPath"
            } catch {
                Log "Warning: Could not create claude.cmd shim: $_"
            }
        }
    }

    # ── Step 5: Claude Auth ────────────────────────────────────
    Set-StepActive 5
    # Use the credentials file check instead of spawning claude (which can hang)
    $credPath = Join-Path $env:USERPROFILE ".claude\.credentials.json"
    Log "Checking credentials at: $credPath"
    $isAuthed = $false
    if (Test-Path $credPath) {
        Log "Credentials file exists"
        try {
            $credRaw = Get-Content $credPath -Raw -Encoding UTF8
            Log "Credentials file size: $($credRaw.Length) chars"
            $creds = $credRaw | ConvertFrom-Json
            $hasOauth = $null -ne $creds.claudeAiOauth
            Log "Has claudeAiOauth: $hasOauth"
            if ($hasOauth) { $isAuthed = $true }
        } catch {
            Log "ERROR parsing credentials: $_"
        }
    } else {
        Log "Credentials file not found"
    }
    if ($isAuthed) {
        Log "Claude is authenticated (credentials found)"
        Set-StepOk 5
    } else {
        Set-StepActive 5 "Login required..."
        Log "Claude not authenticated, prompting login"
        $lblStatus.Text = "A browser window will open - please log in to Claude"
        $lblStatus.ForeColor = $Yellow
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()

        # Launch login in a visible window so user can interact
        $loginProc = Start-Process -FilePath $claude -ArgumentList "login" -PassThru
        # Poll until login finishes, keeping UI alive
        $loginDeadline = [DateTime]::Now.AddSeconds(120)
        while (-not $loginProc.HasExited -and [DateTime]::Now -lt $loginDeadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 200
        }
        if (-not $loginProc.HasExited) {
            try { $loginProc.Kill() } catch { }
        }
        Refresh-EnvPath
        # Re-check credentials file
        $isAuthed = $false
        if (Test-Path $credPath) {
            try {
                $creds = Get-Content $credPath -Raw | ConvertFrom-Json
                if ($creds.claudeAiOauth) { $isAuthed = $true }
            } catch { }
        }
        if ($isAuthed) {
            Set-StepOk 5
        } else {
            Set-StepFail 5 "Not authenticated"
            Log "Auth failed - continuing anyway"
            # Don't block - user can login later
        }
    }

    # ── Step 6: Repository + npm install ───────────────────────
    Set-StepActive 6

    # Check if we're in a valid repo
    $hasRepo = (Test-Path (Join-Path $RepoRoot "package.json")) -and (Test-Path $ServerDir)
    if (-not $hasRepo) {
        Set-StepActive 6 "Cloning repository..."
        Log "Repository not found at $RepoRoot, cloning..."
        $cloneTarget = Join-Path (Split-Path $RepoRoot) "orcstrator"
        $r = Run-Cmd $git "clone $RepoUrl `"$cloneTarget`"" -TimeoutSec 120
        if ($r.ExitCode -ne 0) {
            Set-StepFail 6 "Clone failed"
            Show-Error "Git Clone Failed" "Could not clone the repository.`nCheck your internet connection."
            return
        }
        # Update paths
        $script:RepoRoot = $cloneTarget
        $script:ServerDir = Join-Path $cloneTarget "server"
        $script:ClientDir = Join-Path $cloneTarget "client"
    }

    # Git pull
    if (-not $SkipUpdates) {
        Set-StepActive 6 "Checking for updates..."
        $r = Run-Cmd $git "pull --ff-only" -WorkDir $RepoRoot -TimeoutSec 30
        Log "git pull: $($r.Output)"
    }

    # npm install
    $hasModules = Test-Path (Join-Path $RepoRoot "node_modules\.package-lock.json")
    if ($hasModules) {
        Log "node_modules present"
        Set-StepOk 6
    } else {
        Set-StepActive 6 "Installing npm packages... (this may take a few minutes)"
        Log "Running npm install..."
        $r = Run-Cmd $npm "install" -WorkDir $RepoRoot -TimeoutSec 600
        if ($r.ExitCode -ne 0) {
            Set-StepFail 6 "npm install failed"
            Show-Error "npm install Failed" "npm install failed.`n`nThis is often caused by missing C++ Build Tools.`n`nError: $($r.Error)`n`nTry:`n1. Install Visual Studio Build Tools with 'Desktop C++' workload`n2. Open a new terminal and run: cd `"$RepoRoot`" && npm install"
            return
        }
        Set-StepOk 6
    }

    # ── Step 7: Build shared ───────────────────────────────────
    Set-StepActive 7
    $sharedDist = Join-Path $RepoRoot "shared\dist\index.js"
    if (Test-Path $sharedDist) {
        Log "shared/dist already built"
        Set-StepOk 7
    } else {
        Set-StepActive 7 "Compiling..."
        Log "Building shared types..."
        $r = Run-Cmd $npm "run build -w shared" -WorkDir $RepoRoot -TimeoutSec 60
        if ($r.ExitCode -ne 0) {
            Set-StepFail 7 "Build failed"
            Show-Error "Build Failed" "Could not build shared types package.`n`nError: $($r.Error)"
            return
        }
        Set-StepOk 7
    }

    # ══════════════════════════════════════════════════════════
    #  LAUNCH
    # ══════════════════════════════════════════════════════════

    # Kill existing processes on our ports (with tree kill)
    Log "Checking for existing processes on ports $ServerPort and $ClientPort..."
    foreach ($port in @($ServerPort, $ClientPort)) {
        try {
            @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) | ForEach-Object {
                if ($_.OwningProcess -gt 0) {
                    Log "Killing PID $($_.OwningProcess) on port $port (tree kill)"
                    & taskkill /PID $($_.OwningProcess) /T /F 2>$null
                }
            }
        } catch { }
    }

    # Wait until ports are actually free before spawning new processes
    $portWait = 0
    while ($portWait -lt 15) {
        [System.Windows.Forms.Application]::DoEvents()
        $s = @(Get-NetTCPConnection -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue)
        $c = @(Get-NetTCPConnection -LocalPort $ClientPort -State Listen -ErrorAction SilentlyContinue)
        if ($s.Count -eq 0 -and $c.Count -eq 0) { break }
        $portWait++
        Log "Waiting for ports to free... ($portWait)"
        Start-Sleep -Milliseconds 500
    }

    # ── Step 8: Start Server ───────────────────────────────────
    Set-StepActive 8 "Launching..."
    Log "Starting server from: $ServerDir"
    $serverLog = Join-Path $env:TEMP "orcstrator-server.log"
    $serverProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "cd /d `"$ServerDir`" && npm run dev > `"$serverLog`" 2>&1" -WindowStyle Hidden -PassThru
    $script:ServerPid = $serverProc.Id
    Log "Server started (hidden), PID: $($script:ServerPid), log: $serverLog"

    # Give the process a few seconds to spawn before checking
    for ($w = 0; $w -lt 6; $w++) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 500
    }

    # Now poll for the port
    $seconds = 3
    $maxSeconds = 60
    $found = $false
    Log "Polling for server on port $ServerPort..."
    while ($seconds -lt $maxSeconds) {
        # Log verbose every 5 seconds for debugging
        $verbose = (($seconds % 5) -eq 0)
        if ($verbose) {
            if (Test-TcpPort $ServerPort -Verbose) { $found = $true; break }
        } else {
            if (Test-TcpPort $ServerPort) { $found = $true; break }
        }
        $seconds++
        Set-StepActive 8 "Waiting... (${seconds}s)"
        # Sleep ~1s in small chunks to keep UI alive
        for ($w = 0; $w -lt 4; $w++) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 250
        }
    }
    if ($found) {
        Log "Server is running on port $ServerPort"
        Set-StepOk 8 "port $ServerPort"
    } else {
        # One last verbose check for the log
        Test-TcpPort $ServerPort -Verbose | Out-Null
        Set-StepFail 8 "no response after ${maxSeconds}s"
        Show-Error "Server Start Failed" "The server didn't respond within ${maxSeconds} seconds.`nCheck the Server window for errors."
        return
    }

    # ── Step 9: Start Client ───────────────────────────────────
    Set-StepActive 9 "Launching..."
    Log "Starting client from: $ClientDir"
    $clientLog = Join-Path $env:TEMP "orcstrator-client.log"
    $clientProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "cd /d `"$ClientDir`" && npm run dev > `"$clientLog`" 2>&1" -WindowStyle Hidden -PassThru
    $script:ClientPid = $clientProc.Id
    Log "Client started (hidden), PID: $($script:ClientPid), log: $clientLog"

    # Give Vite a few seconds to start up
    for ($w = 0; $w -lt 8; $w++) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 500
    }

    # Poll for the port
    $seconds = 4
    $maxSeconds = 45
    $found = $false
    Log "Polling for client on port $ClientPort..."
    while ($seconds -lt $maxSeconds) {
        $verbose = (($seconds % 5) -eq 0)
        if ($verbose) {
            if (Test-TcpPort $ClientPort -Verbose) { $found = $true; break }
        } else {
            if (Test-TcpPort $ClientPort) { $found = $true; break }
        }
        $seconds++
        Set-StepActive 9 "Waiting... (${seconds}s)"
        for ($w = 0; $w -lt 4; $w++) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 250
        }
    }
    if ($found) {
        Log "Client is running on port $ClientPort"
        Set-StepOk 9 "port $ClientPort"
    } else {
        Test-TcpPort $ClientPort -Verbose | Out-Null
        Set-StepFail 9 "no response after ${maxSeconds}s"
        Log "Client may still be starting..."
    }

    # ── Done! ──────────────────────────────────────────────────
    Start-Process "http://localhost:$ClientPort"
    $lblStatus.Text = "OrcStrator is running!"
    $lblStatus.ForeColor = $script:Green
    $btnOpen.Enabled = $true
    $btnOpen.FlatAppearance.BorderColor = $script:Green
    $btnOpen.ForeColor = $script:Green
    $form.Refresh()

    Log "Setup complete!"

    # ── Check for updates in background ───────────────────────
    Check-ForUpdates
}

# ══════════════════════════════════════════════════════════════
#  LAUNCH FORM + START SETUP IN BACKGROUND
# ══════════════════════════════════════════════════════════════

# ── Wire FormClosing to clean up processes on ANY close method ──
$form.Add_FormClosing({
    $lblStatus.Text = "Shutting down safely..."
    $lblStatus.ForeColor = $script:Yellow
    $btnOpen.Enabled = $false
    $btnShutdown.Enabled = $false
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    Stop-OrcStrator
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    $timer.Stop()
    $timer.Dispose()
    Run-Setup
})
$timer.Start()

[void]$form.ShowDialog()
$form.Dispose()
