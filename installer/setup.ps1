#Requires -Version 5.1
<#
.SYNOPSIS
    OrcStrator GUI Installer & Launcher
.DESCRIPTION
    WinForms GUI that checks/installs all dependencies, builds the project,
    launches server + client, and opens the browser.
#>

param(
    [switch]$SkipUpdates,
    # Production boot: run the BUILT app
    # (node server/dist/index.js, NODE_ENV=production, single port) instead of
    # the dev toolchain (tsx watch + Vite on 5174). Dev mode stays the default
    # until the artifact updater ships. Sticky via launcher state "bootMode".
    [switch]$Production,
    # Escape hatch: force dev mode and clear a sticky -Production. Wins over
    # -Production, so the way back is always the known-good mode.
    [switch]$Dev,
    # Installed app only. Runs the whole launcher flow with no window and no
    # message boxes: installs the staged release through the verifying
    # updater, checks the channel, boots the server, prints ORC_URL=<url> and
    # writes the outcome as JSON to -ResultFile. Used by CI and scripted tests.
    [switch]$Headless,
    # Headless: stop the server again and exit once /api/health answers.
    [switch]$ExitAfterHealthCheck,
    # Headless: apply an available channel update before booting (the GUI
    # offers it as a click-to-update banner instead).
    [switch]$AutoUpdate,
    # Headless: install the Claude CLI if it is missing (the GUI always does).
    [switch]$InstallClaude,
    # Installed app: the port to serve on. 0 = $env:ORC_PORT, else 3334. An
    # explicit port that a foreign process holds is an error; the default
    # port moves to the next free one instead.
    [int]$Port = 0,
    # Headless: where to write the JSON outcome (url, port, version, ...).
    [string]$ResultFile = "",
    # Installed app only. The folder the installer put OrcStrator.exe in
    # ({app}). OrcStrator.exe runs the launcher from the ACTIVE version's
    # verified payload (<data root>\app\versions\<v>\installer\setup.ps1) so
    # launcher fixes and key rotations reach installs; this tells that copy
    # where the installer's files (staging, icon, OrcStrator.exe) live.
    # Empty: the folder above this script, as before.
    [string]$LauncherRoot = ""
)
# orc-starter-contract: launcher-root-v1
# OrcStrator.exe only hands a payload's setup.ps1 the -LauncherRoot argument
# when this marker is in the file. A payload from before the argument existed
# would fail to start on an unknown parameter, so the starter falls back to
# {app}\installer\setup.ps1 for those.

$script:Headless = [bool]$Headless

# Windows PowerShell 5.1 on an older .NET Framework can default to TLS 1.0/1.1,
# which the update server and GitHub refuse. On .NET 4.7+ the
# default is SystemDefault (0): Windows picks, TLS 1.3 included, and that is
# Microsoft's recommendation, so it is left alone. Only an explicit older list
# gets TLS 1.2 added; nothing is ever taken away.
try {
    $orcTls = [Net.ServicePointManager]::SecurityProtocol
    if ([int]$orcTls -ne 0 -and -not ($orcTls -band [Net.SecurityProtocolType]::Tls12)) {
        [Net.ServicePointManager]::SecurityProtocol = $orcTls -bor [Net.SecurityProtocolType]::Tls12
    }
} catch { }

# ── Assemblies ─────────────────────────────────────────────────
# Headless mode never builds a window, so it never loads WinForms.
if (-not $script:Headless) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
}

# ── Taskbar identity ───────────────────────────────────────────
# A WinForms window hosted by powershell.exe inherits PowerShell's taskbar
# identity, so the taskbar button shows the blue PowerShell icon instead of
# our window icon. Giving the launcher its own AppUserModelID detaches it from
# powershell.exe, so the taskbar uses the form's icon (the OrcStrator logo).
# Must run before the window is created. Degrades safely if shell32 is missing.
# The SAME id is stamped onto the Desktop/Start-Menu shortcuts (see Write-OrcLnk)
# so a pinned shortcut and this running window are ONE taskbar button (orc icon).
$AppUserModelId = "OrcStrator.Launcher"
if (-not $script:Headless) {
try {
    Add-Type -Namespace OrcShell -Name Taskbar -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("shell32.dll", SetLastError=true)]
public static extern void SetCurrentProcessExplicitAppUserModelID([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string AppID);
'@
    [OrcShell.Taskbar]::SetCurrentProcessExplicitAppUserModelID($AppUserModelId)
} catch { }
}

# Keep the window responsive during long waits. A no-op headless, where there
# is no window and WinForms is not even loaded.
function Invoke-UiPump {
    if (-not $script:Headless) { [System.Windows.Forms.Application]::DoEvents() }
}

# ── Process Job Object (reliable whole-tree shutdown) ─────────────
# Every process the launcher starts (server/client cmd.exe -> npm -> node ->
# claude.exe -> MCP children) is bound to this Windows Job Object. A single
# TerminateJobObject then kills the ENTIRE tree in one syscall, including
# grandchildren that have re-parented and that `taskkill /T` (which walks the
# live parent tree) silently misses. This is the launcher's most reliable
# teardown layer. Degrades safely: if the type or job can't be created,
# $script:JobOk stays $false and Stop-OrcStrator's existing port/PID/taskkill
# layers still run. The job is created with KILL_ON_JOB_CLOSE: when the launcher
# exits for ANY reason (button shutdown, window close, crash, or Windows force-
# killing it during OS shutdown) the kernel reaps the entire tree. That is the
# bulletproof backstop to the explicit Stop-OrcStrator teardown the buttons do.
$script:JobHandle = [IntPtr]::Zero
$script:JobOk     = $false
try {
    Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OrcJob {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr a, string n);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateJobObject(IntPtr j, uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfo);
    const uint PROCESS_TERMINATE = 0x0001;
    const uint PROCESS_SET_QUOTA = 0x0100;
    const int  JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    // KILL_ON_JOB_CLOSE: the kernel kills every job member the instant the
    // launcher's handle closes - normal exit, crash, OR Windows force-killing
    // the launcher during shutdown. Bulletproof backstop to explicit Terminate.
    // Falls back to a plain (still-terminable) job if the limit can't be set.
    public static IntPtr Create() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        ext.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr p = Marshal.AllocHGlobal(len);
        try {
            Marshal.StructureToPtr(ext, p, false);
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, p, (uint)len);
        } finally {
            Marshal.FreeHGlobal(p);
        }
        return job;
    }
    public static bool Assign(IntPtr job, int pid) {
        if (job == IntPtr.Zero) return false;
        IntPtr h = OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, (uint)pid);
        if (h == IntPtr.Zero) return false;
        bool ok = AssignProcessToJobObject(job, h);
        CloseHandle(h);
        return ok;
    }
    public static bool Terminate(IntPtr job) {
        if (job == IntPtr.Zero) return false;
        return TerminateJobObject(job, 1);
    }
}
"@
    $script:JobHandle = [OrcJob]::Create()
    $script:JobOk     = ($script:JobHandle -ne [IntPtr]::Zero)
} catch {
    $script:JobOk = $false
}

# ── Paths ──────────────────────────────────────────────────────
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Split-Path -Parent $ScriptDir

function Test-OrcLauncherRootArg {
    <#
      Accept -LauncherRoot only when it really is an installed app folder:
      it exists, it holds installer\setup.ps1, and it is NOT a git checkout.
      A developer checkout never runs a payload's launcher, so a .git folder
      here means the argument is wrong and the script's own folder wins.
    #>
    param([string]$Value)
    if (-not $Value) { return $false }
    try {
        if (-not [System.IO.Path]::IsPathRooted($Value)) { return $false }
        if (-not (Test-Path -LiteralPath $Value -PathType Container)) { return $false }
        if (Test-Path -LiteralPath (Join-Path $Value ".git")) { return $false }
        return (Test-Path -LiteralPath (Join-Path $Value "installer\setup.ps1") -PathType Leaf)
    } catch { return $false }
}

$script:LauncherRootArgIgnored = $false
if ($LauncherRoot) {
    if (Test-OrcLauncherRootArg $LauncherRoot) {
        # Running a verified payload's launcher out of app\versions\<v>. Behave
        # exactly as if started from {app}: same data root, same staging
        # folder, same icon, same shortcuts target.
        $RepoRoot  = [System.IO.Path]::GetFullPath($LauncherRoot.Trim().TrimEnd('\'))
        $ScriptDir = Join-Path $RepoRoot "installer"
    } else {
        $script:LauncherRootArgIgnored = $true
    }
}
$ServerDir   = Join-Path $RepoRoot "server"
$ClientDir   = Join-Path $RepoRoot "client"
$IconPath    = Join-Path $ScriptDir "icon.ico"
# Where the launcher itself lives. $RepoRoot is re-pointed at the active
# version in artifact mode; this never moves (the installer's staging folder
# and OrcStrator.exe sit here).
$script:LauncherRoot = $RepoRoot
# The script that is actually running (a payload copy or {app}'s own).
$script:LauncherScript = $MyInvocation.MyCommand.Path

# Windows PowerShell by full path, never by name: a powershell.exe earlier on
# PATH (or in the working folder) must not be what the launcher re-executes.
$script:PowerShellExe = Join-Path ([Environment]::GetFolderPath('System')) "WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $script:PowerShellExe)) { $script:PowerShellExe = "powershell.exe" }

function Resolve-OrcDataRoot {
    <#
      The data root: database, logs, launcher state and (installed mode)
      app\versions. ORCSTRATOR_DATA_DIR always wins, which is how tests use a
      scratch folder. A git checkout keeps the developer path it always had
      (%USERPROFILE%\.orcstrator-v2). An installed copy (no .git) uses
      %LOCALAPPDATA%\OrcStrator, the per-user app-data home on Windows.
    #>
    param(
        [string]$Root,
        [string]$Override = $env:ORCSTRATOR_DATA_DIR,
        [string]$LocalAppData = $env:LOCALAPPDATA,
        [string]$UserProfile = $env:USERPROFILE
    )
    if ($Override) { return $Override.Trim() }
    if (Test-Path (Join-Path $Root ".git")) { return (Join-Path $UserProfile ".orcstrator-v2") }
    return (Join-Path $LocalAppData "OrcStrator")
}

$StateDir    = Resolve-OrcDataRoot -Root $RepoRoot
$LogDir      = Join-Path $StateDir "logs"
$StateFile   = Join-Path $StateDir "launcher-state.json"
if (-not (Test-Path $LogDir)) {
    try { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null } catch { }
}
$LogFile     = Join-Path $LogDir "orcstrator-install.log"
# Artifact installs live beside the user data, never inside the git checkout,
# so the two update mechanisms can coexist during phases 2 and 3.
$script:ArtifactRoot = Join-Path $StateDir "app"
$ServerLog   = Join-Path $LogDir "orcstrator-server.log"
$ClientLog   = Join-Path $LogDir "orcstrator-client.log"
$ServerPort  = 3334
$ClientPort  = 5174

# The repository URL is only needed by the developer path (git clone / pull),
# so it is resolved at runtime and never baked into the shipped launcher:
# the checkout's own origin when .git exists, else $env:ORC_REPO_URL. $null
# means there is nothing to clone from; the caller reports that.
function Resolve-OrcRepoUrl {
    param([string]$Git = "git", [string]$Root = $RepoRoot)
    if (Test-Path (Join-Path $Root ".git")) {
        try {
            $u = ((& $Git -C $Root remote get-url origin 2>$null) -join "").Trim()
            if ($LASTEXITCODE -eq 0 -and $u) { return $u }
        } catch { }
    }
    if ($env:ORC_REPO_URL) { return $env:ORC_REPO_URL.Trim() }
    return $null
}

function Test-OrcGitAutoUpdate {
    <#
      Whether a developer checkout may update itself from git (the launch-time
      pull, the update check's fetch, the click-to-update banner). ON only in
      an official clone, recognised by installer\release\official-release.config.json
      in the checkout (the file is never exported to a source build), or when
      ORC_GIT_AUTO_UPDATE=1 opts a source build in. Anything else is a source
      build: it runs the checkout exactly as it is and never fetches or pulls.
    #>
    param(
        [string]$Root = $RepoRoot,
        [string]$Override = $env:ORC_GIT_AUTO_UPDATE
    )
    if ($Override -and $Override.Trim() -eq '1') { return $true }
    if (-not $Root) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Root "installer\release\official-release.config.json") -PathType Leaf)
}

# ── Boot mode ─────────────────────────────────────────────────
# Dev:        server (tsx watch) on 3334 + Vite client on 5174, app at 5174.
# Production: one node process on 3334 serving the built client statically.
# Resolved by Resolve-BootMode once the launcher-state helpers exist.
$script:ProductionMode = $false
$script:AppPort = $ClientPort

# ── Launcher state (persists across runs) ─────────────────────
function Get-LauncherState {
    if (Test-Path $StateFile) {
        try { return (Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { }
    }
    return New-Object PSObject
}

function Save-LauncherState {
    # Written to a temp file next to the real one, then swapped in, so a crash
    # or power cut mid-write can never leave a half-written state file (which
    # would silently drop the update channel and the install id).
    param($State)
    try {
        $json = $State | ConvertTo-Json -Depth 4
        $dir = Split-Path -Parent $StateFile
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $tmp = "$StateFile.$([guid]::NewGuid().ToString('N').Substring(0,8)).tmp"
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        try {
            # [NullString]::Value, not $null: PowerShell turns $null into ""
            # for a string argument, and "" is not a legal backup path.
            if (Test-Path -LiteralPath $StateFile) { [System.IO.File]::Replace($tmp, $StateFile, [NullString]::Value) }
            else { [System.IO.File]::Move($tmp, $StateFile) }
        } finally {
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        }
    } catch { }
}

function Set-LauncherStateValue {
    param([string]$Name, $Value)
    $state = Get-LauncherState
    if ($state.PSObject.Properties[$Name]) {
        $state.$Name = $Value
    } else {
        $state | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
    Save-LauncherState $state
}

# ── Resolve boot mode ──────────────────────────────────────────
function Resolve-BootMode {
    # -Production wins and is remembered; otherwise fall back to whatever was
    # chosen last. Persisting it means the choice survives the launcher's own
    # self-relaunches AND the desktop shortcut, which carries no switches.
    # -Dev wins over -Production: the escape hatch must always work.
    param([bool]$ProductionSwitch, [bool]$DevSwitch)
    if ($DevSwitch) {
        Set-LauncherStateValue -Name "bootMode" -Value "dev"
        return $false
    }
    if ($ProductionSwitch) {
        Set-LauncherStateValue -Name "bootMode" -Value "production"
        return $true
    }
    try {
        $st = Get-LauncherState
        if ($st.bootMode -eq 'production') { return $true }
    } catch { }
    return $false
}

$script:ProductionMode = Resolve-BootMode -ProductionSwitch ([bool]$Production) -DevSwitch ([bool]$Dev)
$script:AppPort = if ($script:ProductionMode) { $ServerPort } else { $ClientPort }

# Everything from here to the end of the window build is GUI only. Headless
# mode (CI, scripted tests) skips it: no theme, no fonts, no form, no controls.
if (-not $script:Headless) {

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
    # 32x32 pixel art orc icon - dark bg, green orc face, purple accents
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

# ── Build a crisp multi-size .ico from the app logo PNG ────────
function New-IcoFromPng {
    # Render a PNG into a multi-resolution .ico using GDI+. Pure .NET (no
    # Node/sharp) so it works this early in setup. Each frame is stored
    # PNG-compressed, which Windows supports since Vista.
    param([string]$SrcPng, [string]$OutIco, [int[]]$Sizes = @(16,24,32,48,64,128,256))
    $src = [System.Drawing.Image]::FromFile($SrcPng)
    try {
        $entries = @()
        foreach ($s in $Sizes) {
            $bmp = New-Object System.Drawing.Bitmap($s, $s)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.Clear([System.Drawing.Color]::Transparent)
            $g.DrawImage($src, 0, 0, $s, $s)
            $g.Dispose()
            $ms = New-Object System.IO.MemoryStream
            $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $entries += ,($ms.ToArray())
            $ms.Dispose(); $bmp.Dispose()
        }
    } finally { $src.Dispose() }

    $out = New-Object System.IO.MemoryStream
    $bw  = New-Object System.IO.BinaryWriter($out)
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$Sizes.Count)
    $offset = 6 + (16 * $Sizes.Count)
    for ($i = 0; $i -lt $Sizes.Count; $i++) {
        $s = $Sizes[$i]; $data = $entries[$i]
        $dim = if ($s -ge 256) { 0 } else { $s }
        $bw.Write([Byte]$dim); $bw.Write([Byte]$dim); $bw.Write([Byte]0); $bw.Write([Byte]0)
        $bw.Write([UInt16]1); $bw.Write([UInt16]32)
        $bw.Write([UInt32]$data.Length); $bw.Write([UInt32]$offset)
        $offset += $data.Length
    }
    foreach ($data in $entries) { $bw.Write($data) }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($OutIco, $out.ToArray())
    $bw.Dispose(); $out.Dispose()
}

# Generate the launcher/shortcut icon if missing. Prefer the real app logo
# (client/public/logo.png); fall back to the drawn orc only if it's absent.
if (-not (Test-Path $IconPath)) {
    $logoPng = Join-Path $RepoRoot "client\public\logo.png"
    $built = $false
    if (Test-Path $logoPng) {
        try { New-IcoFromPng -SrcPng $logoPng -OutIco $IconPath; $built = (Test-Path $IconPath) } catch { }
    }
    if (-not $built) {
        try { New-OrcIcon -OutPath $IconPath } catch { }
    }
}

# ── Shortcut helper: stamp AppUserModelID onto a .lnk ──────────────
# WScript.Shell can set a shortcut's target + icon but NOT its AppUserModelID.
# Windows resolves a taskbar PIN to a shortcut whose AppUserModelID matches the
# running window's id; without that match, pinning a powershell-hosted window
# falls back to powershell.exe's blue icon. This tiny COM helper (IShellLink +
# IPropertyStore) writes a .lnk WITH the id so the pin shows the OrcStrator orc.
# Degrades to WScript (icon only, no id) if the type can't compile.
$script:ShortcutHelperOk = $false
try {
    Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OrcShortcut {
    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class CShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr pfd, uint fl);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int c);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int c);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
        void GetHotkey(out short w);
        void SetHotkey(short w);
        void GetShowCmd(out int s);
        void SetShowCmd(int s);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string r, uint res);
        void Resolve(IntPtr hwnd, uint fl);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
    }
    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile {
        void GetClassID(out Guid c);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool r);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
    }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint c);
        void GetAt(uint i, out PROPERTYKEY k);
        void GetValue(ref PROPERTYKEY k, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY k, ref PROPVARIANT pv);
        void Commit();
    }
    public static void Write(string lnk, string target, string args, string workDir, string desc, string icon, string appId) {
        IShellLinkW link = (IShellLinkW)new CShellLink();
        link.SetPath(target);
        if (!string.IsNullOrEmpty(args))    link.SetArguments(args);
        if (!string.IsNullOrEmpty(workDir)) link.SetWorkingDirectory(workDir);
        if (!string.IsNullOrEmpty(desc))    link.SetDescription(desc);
        if (!string.IsNullOrEmpty(icon))    link.SetIconLocation(icon, 0);
        IPropertyStore store = (IPropertyStore)link;
        PROPERTYKEY k = new PROPERTYKEY();
        k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        k.pid = 5;
        PROPVARIANT pv = new PROPVARIANT();
        pv.vt = 31;
        pv.p = Marshal.StringToCoTaskMemUni(appId);
        store.SetValue(ref k, ref pv);
        store.Commit();
        Marshal.FreeCoTaskMem(pv.p);
        ((IPersistFile)link).Save(lnk, true);
    }
}
"@
    $script:ShortcutHelperOk = $true
} catch {
    $script:ShortcutHelperOk = $false
}

function Write-OrcLnk {
    # Write/refresh ONE OrcStrator .lnk -> orcstrator.bat, with the orc icon and
    # the shared AppUserModelId (so a pinned shortcut and the running window are
    # one taskbar button). Prefers the property-store helper; if it is missing,
    # falls back to WScript.Shell (sets icon + target only, no id).
    param([string]$LnkPath)
    $batPath = Join-Path $RepoRoot "orcstrator.bat"
    $workDir = $RepoRoot
    # An installed copy has no orcstrator.bat: its entry point is the
    # no-console starter the installer put next to the launcher.
    if ($script:ArtifactMode) {
        $batPath = Join-Path $script:LauncherRoot "OrcStrator.exe"
        $workDir = $script:LauncherRoot
    }
    $icon = if (Test-Path $IconPath) { $IconPath } else { "" }
    if ($script:ShortcutHelperOk) {
        [OrcShortcut]::Write($LnkPath, $batPath, "", $workDir, "Launch OrcStrator", $icon, $AppUserModelId)
    } else {
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($LnkPath)
        $sc.TargetPath = $batPath
        $sc.WorkingDirectory = $workDir
        $sc.Description = "Launch OrcStrator"
        if ($icon) { $sc.IconLocation = $icon }
        $sc.Save()
    }
}

# ── Shortcuts (shared by the button + auto-create on setup) ─────────
function New-DesktopShortcut {
    # Ensure OrcStrator shortcuts exist: Desktop (the visible launcher) AND the
    # Start Menu (so Windows can resolve a taskbar PIN to the orc icon instead
    # of powershell.exe). Default: only writes a link that is missing (idempotent,
    # no churn on re-launch). -Force: rewrite both (used by the button). Returns
    # $true if the Desktop link ends up present. Never throws.
    param([switch]$Force)
    $ok = $false
    try {
        $desktop = [System.Environment]::GetFolderPath("Desktop")
        $lnkPath = Join-Path $desktop "OrcStrator.lnk"
        if ($Force -or -not (Test-Path $lnkPath)) { Write-OrcLnk $lnkPath }
        $ok = (Test-Path $lnkPath)
    } catch {
        try { Log "Could not create desktop shortcut: $_" } catch { }
    }
    try {
        $programs = [System.Environment]::GetFolderPath("Programs")
        $smPath = Join-Path $programs "OrcStrator.lnk"
        if ($Force -or -not (Test-Path $smPath)) { Write-OrcLnk $smPath }
    } catch {
        try { Log "Could not create Start Menu shortcut: $_" } catch { }
    }
    return $ok
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

# Step labels - we'll create 10 rows
$stepLabels = @()
$stepIcons  = @()
$stepNames = @(
    "System requirements"
    "Version control"
    "App engine"
    "Build tools"
    "Claude AI"
    "Account"
    "Packages"
    "App setup"
    "Backend"
    "OrcStrator"
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

# -- Log in button (installed mode only) --
# Shown under the steps when Claude is installed but not signed in, so a
# skipped or timed-out sign-in is never a dead end. Runs the same
# `claude auth login` flow as first launch (Invoke-OrcClaudeLogin).
$btnLogin = New-Object System.Windows.Forms.Button
$btnLogin.Text = "Log in"
$btnLogin.Font = $FontBtn
$btnLogin.Size = New-Object System.Drawing.Size(150, 36)
$btnLogin.Location = New-Object System.Drawing.Point(36, 190)
$btnLogin.FlatStyle = "Flat"
$btnLogin.FlatAppearance.BorderColor = $Yellow
$btnLogin.FlatAppearance.BorderSize = 2
$btnLogin.BackColor = $BgPanel
$btnLogin.ForeColor = $Yellow
$btnLogin.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnLogin.Visible = $false
$btnLogin.Add_Click({
    if (-not $script:ClaudeExe) { return }
    $a = Invoke-OrcClaudeLogin -ClaudeExe $script:ClaudeExe
    Set-OrcSignInResult -Auth $a.Auth -TimedOut $a.TimedOut
})
$panelSteps.Controls.Add($btnLogin)

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
        $txtLog.Location = New-Object System.Drawing.Point(20, 660)
        $txtLog.Size = New-Object System.Drawing.Size(505, 120)
        $btnToggleLog.Text = "Hide log"
        $btnToggleLog.Location = New-Object System.Drawing.Point(20, 442)
        $form.Size = New-Object System.Drawing.Size(560, 840)
    }
})
$form.Controls.Add($btnToggleLog)

# ── Action Buttons ─────────────────────────────────────────────
$btnOpen = New-Object System.Windows.Forms.Button
$btnOpen.Text = "Open"
$btnOpen.Font = $FontBtn
$btnOpen.Size = New-Object System.Drawing.Size(119, 48)
$btnOpen.Location = New-Object System.Drawing.Point(20, 540)
$btnOpen.FlatStyle = "Flat"
$btnOpen.FlatAppearance.BorderColor = $Green
$btnOpen.FlatAppearance.BorderSize = 2
$btnOpen.BackColor = $BgPanel
$btnOpen.ForeColor = $Green
$btnOpen.Enabled = $false
$btnOpen.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnOpen.Add_Click({
    Start-Process "http://localhost:$($script:AppPort)"
})
$form.Controls.Add($btnOpen)

$btnShortcut = New-Object System.Windows.Forms.Button
$btnShortcut.Text = "Desktop Shortcut"
$btnShortcut.Font = $FontSub
$btnShortcut.Size = New-Object System.Drawing.Size(119, 48)
$btnShortcut.Location = New-Object System.Drawing.Point(148, 540)
$btnShortcut.FlatStyle = "Flat"
$btnShortcut.FlatAppearance.BorderColor = $Accent
$btnShortcut.FlatAppearance.BorderSize = 1
$btnShortcut.BackColor = $BgPanel
$btnShortcut.ForeColor = $Accent
$btnShortcut.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnShortcut.Add_Click({
    if (New-DesktopShortcut -Force) {
        [System.Windows.Forms.MessageBox]::Show(
            "Shortcuts created.`n`nDesktop: double-click 'OrcStrator' to launch.`n`nTo pin with the OrcStrator icon: open Start, type OrcStrator, right-click it, then 'Pin to taskbar'.",
            "Shortcuts Created",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
    } else {
        [System.Windows.Forms.MessageBox]::Show(
            "Could not create the desktop shortcut. See the log for details.",
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
$btnShutdown.Size = New-Object System.Drawing.Size(119, 48)
$btnShutdown.Location = New-Object System.Drawing.Point(404, 540)
$btnShutdown.FlatStyle = "Flat"
$btnShutdown.FlatAppearance.BorderColor = $Red
$btnShutdown.FlatAppearance.BorderSize = 1
$btnShutdown.BackColor = $BgPanel
$btnShutdown.ForeColor = $Red
$btnShutdown.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnShutdown.Add_Click({
    $confirm = [System.Windows.Forms.MessageBox]::Show(
        "This closes OrcStrator and stops every running chat.`n`nContinue?",
        "Shutdown OrcStrator",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($confirm -eq [System.Windows.Forms.DialogResult]::Yes) {
        $lblStatus.Text = "Shutting down..."
        $lblStatus.ForeColor = $script:Red
        $form.Refresh()
        Invoke-UiPump

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

# ── Restart Button ─────────────────────────────────────────────
$btnRestart = New-Object System.Windows.Forms.Button
$btnRestart.Text = "Restart"
$btnRestart.Font = $FontSub
$btnRestart.Size = New-Object System.Drawing.Size(119, 48)
$btnRestart.Location = New-Object System.Drawing.Point(276, 540)
$btnRestart.FlatStyle = "Flat"
$btnRestart.FlatAppearance.BorderColor = $Yellow
$btnRestart.FlatAppearance.BorderSize = 1
$btnRestart.BackColor = $BgPanel
$btnRestart.ForeColor = $Yellow
$btnRestart.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnRestart.Add_Click({
    $confirm = [System.Windows.Forms.MessageBox]::Show(
        "This will restart OrcStrator.`nRunning Claude instances will be stopped, then the app relaunches.`n`nContinue?",
        "Restart OrcStrator",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($confirm -eq [System.Windows.Forms.DialogResult]::Yes) {
        $lblStatus.Text = "Restarting..."
        $lblStatus.ForeColor = $script:Yellow
        $btnOpen.Enabled = $false
        $btnShutdown.Enabled = $false
        $btnRestart.Enabled = $false
        $form.Refresh()
        Invoke-UiPump

        # Full teardown (job object Layer 0 + fallback layers), then relaunch a
        # fresh launcher. -SkipUpdates: a restart just restarts (no git pull).
        Stop-OrcStrator
        $relaunchArgs = Get-OrcRelaunchArgs -SkipUpdates
        Start-Process -FilePath $script:PowerShellExe -ArgumentList $relaunchArgs
        $form.Close()
    }
})
$form.Controls.Add($btnRestart)

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
$script:UpdateAuthNeeded = $false
$script:CommitsBehind = 0
$script:ServerPid = $null
$script:ClientPid = $null
$script:ShutdownDone = $false

# Custom paint for two-line text (title + subtitle)
$script:UpdateTitle = "Checking for updates..."
$script:UpdateSub = ""
$script:UpdateColorKey = 'dim'

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
    $git = Find-Exe "git"

    # A source build never fetches or pulls (Test-OrcGitAutoUpdate). Its
    # banner is hidden, so this only guards against a stale click.
    if (-not $script:ArtifactMode -and -not (Test-OrcGitAutoUpdate)) { return }

    # Banner doubles as the sign-in button when the repository rejected us
    if ($script:UpdateAuthNeeded) {
        if (-not $git) { return }
        Set-UpdateBanner -Title "Waiting for GitHub sign-in..." `
                         -Sub "Finish signing in in the window that just opened." -ColorKey 'yellow'
        Invoke-UiPump
        Invoke-GitHubSignIn -Git $git -GitArgs "-C `"$RepoRoot`" fetch" | Out-Null
        Check-ForUpdates
        return
    }

    if (-not $script:UpdateAvailable) { return }

    # Artifact mode: download + verify + swap, then relaunch. Nothing is
    # destructive until current.txt flips, so a failure here leaves the running
    # version exactly as it was.
    if ($script:ArtifactMode) {
        Set-UpdateBanner -Title "Updating..." -Sub "Downloading and verifying the new version..." -ColorKey 'yellow'
        Invoke-UiPump
        $res = Invoke-OrcArtifactUpdate
        Invoke-UiPump
        if ($res.Updated) {
            Log "Artifact update applied: $($res.From) -> $($res.Version). Relaunching..."
            Set-UpdateBanner -Title "Updated successfully!" `
                             -Sub "Restarting OrcStrator on version $($res.Version)..." -ColorKey 'green'
            Invoke-UiPump
            Stop-OrcStrator
            # The relaunch runs the NEW version's verified launcher (the same
            # choice OrcStrator.exe makes), so a launcher fix applies at once.
            $relaunchArgs = Get-OrcRelaunchArgs -SkipUpdates
            # Hidden: an installed copy has no console, and a flashing one
            # looks like something went wrong.
            Start-Process -FilePath $script:PowerShellExe -ArgumentList $relaunchArgs -WindowStyle Hidden
            $form.Close()
        } elseif ($res.Reason -match 'SIGNATURE|HASH') {
            Log "Update refused: $($res.Reason)"
            Set-UpdateBanner -Title "Update not installed" `
                             -Sub "This update could not be verified and was not installed. We will try again later." `
                             -ColorKey 'red'
        } elseif ($res.Reason -eq "this release was withdrawn") {
            Log "Update withdrawn: $($res.Reason)"
            Set-UpdateBanner -Title "That update was withdrawn" -Sub "You stay on version $(Get-OrcActiveVersion). Nothing is wrong on this computer." -ColorKey 'green'
        } elseif ($res.Reason -eq "no update offered right now") {
            # Withdrawn or paused between the check and the click.
            Log "Update no longer offered: $($res.Reason)"
            Set-UpdateBanner -Title "No update right now" -Sub "Version $(Get-OrcActiveVersion)" -ColorKey 'green'
        } elseif ($res.Reason -match 'out of date|older than the minimum') {
            # The update server's answer could not be trusted as current.
            # Nothing failed on this computer, so no red alarm.
            Log "Update not installed: $($res.Reason)"
            Set-UpdateBanner -Title "Could not check for updates" -Sub "You are on version $(Get-OrcActiveVersion). We will check again the next time you open OrcStrator." -ColorKey 'dim'
        } else {
            Log "Update failed: $($res.Reason)"
            Set-UpdateBanner -Title "Update not installed" `
                             -Sub "The update could not be installed. You are still on version $(Get-OrcActiveVersion)." `
                             -ColorKey 'red'
        }
        return
    }

    Set-UpdateBanner -Title "Updating..." -Sub "Pulling latest changes from GitHub..." -ColorKey 'yellow'
    Invoke-UiPump

    $r = Invoke-GitRetry $git "pull --ff-only" -WorkDir $RepoRoot -TimeoutSec 60
    Invoke-UiPump

    if ($r.ExitCode -eq 0) {
        # IMPORTANT: the code of THIS running script is the pre-pull version.
        # Steps, ports, and boot logic in memory are stale until we relaunch
        # from disk. Re-exec a fresh setup.ps1 (which always rebuilds shared
        # in its Step 7) instead of rebuilding here with stale logic.
        $newSha = ""
        try { $newSha = ((& $git -C $RepoRoot rev-parse --short HEAD 2>&1) -join "").Trim() } catch { }
        Set-LauncherStateValue -Name "updatedToSha" -Value $newSha
        Log "Update pulled (now at $newSha). Re-launching fresh setup.ps1..."

        Set-UpdateBanner -Title "Updated successfully!" -Sub "Restarting OrcStrator with the new version..." -ColorKey 'green'
        Invoke-UiPump

        # Stop our server/client first so the fresh launcher gets clean ports,
        # then re-exec the (now updated) script and close this stale instance.
        Stop-OrcStrator
        $relaunchArgs = Get-OrcRelaunchArgs -SkipUpdates:([bool]$SkipUpdates)
        Start-Process -FilePath $script:PowerShellExe -ArgumentList $relaunchArgs
        $form.Close()
        return
    } elseif ($r.AuthFailed) {
        # Credentials went stale (token expired, access revoked) between the
        # check and the pull. Offer sign-in again rather than a dead end.
        $script:UpdateAvailable = $false
        $script:UpdateAuthNeeded = $true
        Set-UpdateBanner -Title "Sign in to GitHub" `
                         -Sub "GitHub rejected the update. Click to sign in again." `
                         -ColorKey 'yellow' -Clickable
    } else {
        Set-UpdateBanner -Title "Update failed" `
                         -Sub "Try running 'git pull' manually in the project folder. Log: $LogFile" `
                         -ColorKey 'red'
    }
})
$form.Controls.Add($btnUpdate)
}   # end of the GUI-only block (theme, fonts, shortcut helper, window)

# ── Stop-OrcStrator (3-layer bulletproof kill) ─────────────────
function Stop-OrcStrator {
    if ($script:ShutdownDone) { return }
    $script:ShutdownDone = $true

    # Layer 0: Job object - kills the ENTIRE server/client process tree
    # (npm -> node -> claude.exe -> MCP) in one syscall, including re-parented
    # children that `taskkill /T` misses. Most reliable layer; the rest are
    # fallback for the (degraded) case where the job couldn't be created.
    if ($script:JobOk) {
        try {
            [OrcJob]::Terminate($script:JobHandle) | Out-Null
            Log "Shutdown: job object terminated (whole process tree)"
        } catch { }
    }

    # Collect all PIDs to kill at once
    $pidsToKill = @()

    # Layer 1: Stored PIDs
    # NOTE: do not name this loop variable $pid - $PID is a read-only automatic
    # variable in PowerShell and assigning to it throws, silently skipping this layer.
    foreach ($procId in @($script:ServerPid, $script:ClientPid)) {
        if ($procId) { $pidsToKill += $procId }
    }

    if ($script:ArtifactMode) {
        # Installed app: never kill a process this launcher cannot prove it
        # started. Layers 2 and 3 below match by port and window title, which
        # would also hit whatever ELSE the user runs there. Only the server
        # recorded in our own state file, running an exe from our own app
        # folder, is ours.
        $own = Read-OrcServerProcess
        if ($own -and $own.pid -and (Test-OrcOwnedProcess -ProcessId ([int]$own.pid))) {
            $pidsToKill += [int]$own.pid
        }
    } else {
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
    }   # end developer-checkout layers

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

    $btnRestart.BackColor = $t.BtnBg
    $btnRestart.ForeColor = $t.Yellow
    $btnRestart.FlatAppearance.BorderColor = $t.Yellow

    $btnLogin.BackColor = $t.BtnBg
    $btnLogin.ForeColor = $t.Yellow
    $btnLogin.FlatAppearance.BorderColor = $t.Yellow

    $btnUpdate.BackColor = $t.BtnBg
    # Re-resolve the banner color for the new palette, preserving its state
    # (an "Update available" or "Sign in" banner must not gray out on toggle).
    $ubc = switch ($script:UpdateColorKey) {
        'green'  { $t.Green }
        'yellow' { $t.Yellow }
        'red'    { $t.Red }
        default  { $t.TextDim }
    }
    $btnUpdate.ForeColor = $ubc
    $btnUpdate.FlatAppearance.BorderColor = $ubc

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
    if ($script:Headless) { Write-Host $line; return }
    $txtLog.AppendText("$line`r`n")
    $txtLog.ScrollToCaret()
}

function Write-OrcHeadlessStep {
    param([int]$Index, [string]$State, [string]$Msg)
    $line = "[step $Index] $State $Msg"
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
    Write-Host $line
}

function Set-OrcStatus {
    # The one-line status under the steps. ColorKey as in Set-UpdateBanner.
    param([string]$Text, [ValidateSet('dim', 'green', 'yellow', 'red')][string]$ColorKey = 'dim')
    if ($script:Headless) { Log "status: $Text"; return }
    $lblStatus.Text = $Text
    $lblStatus.ForeColor = switch ($ColorKey) {
        'green'  { $script:Green }
        'yellow' { $script:Yellow }
        'red'    { $script:Red }
        default  { $script:TextDim }
    }
    $form.Refresh()
    Invoke-UiPump
}

function Set-StepActive {
    param([int]$Index, [string]$Msg)
    if ($script:Headless) { Write-OrcHeadlessStep $Index "..." $Msg; return }
    if ($Index -ge 0 -and $Index -lt $stepNames.Count) {
        $stepIcons[$Index].Text = [char]0x25B6  # right triangle
        $stepIcons[$Index].ForeColor = $script:Yellow
        $stepLabels[$Index].ForeColor = $script:TextPrimary
        if ($Msg) { $stepLabels[$Index].Text = $Msg }
    }
    $lblStatus.Text = $(if ($Msg) { $Msg } else { $stepNames[$Index] })
    $lblStatus.ForeColor = $script:Yellow
    $form.Refresh()
    Invoke-UiPump
}

function Set-StepOk {
    param([int]$Index, [string]$Detail)
    if ($script:Headless) { Write-OrcHeadlessStep $Index "OK" $Detail; return }
    if ($Index -ge 0 -and $Index -lt $stepNames.Count) {
        $stepIcons[$Index].Text = [char]0x2714  # checkmark
        $stepIcons[$Index].ForeColor = $script:Green
        $stepLabels[$Index].ForeColor = $script:Green
        if ($Detail) { $stepLabels[$Index].Text = $Detail }
    }
    Update-OrcStepProgress $Index
    $form.Refresh()
    Invoke-UiPump
}

# -- Installed-mode window --
# An installed copy runs 5 of the 10 steps; the rest exist for the developer
# path (git, winget, npm, build tools). Those rows are hidden rather than
# shown as "Not needed", and the rest get plain outcome names in the order
# they actually run. The developer window is untouched.
$script:InstalledUi = $false
$script:InstalledStepOrder = @(6, 4, 5, 8, 9)
$script:InstalledStepNames = @{ 6 = "Files"; 4 = "Claude"; 5 = "Sign-in"; 8 = "Starting"; 9 = "Ready" }
$script:InstalledSubtitle = "Run several Claude chats side by side"

function Update-OrcStepProgress {
    param([int]$Index)
    if ($script:InstalledUi) {
        $k = $script:InstalledStepOrder.IndexOf($Index)
        if ($k -ge 0) { $progress.Value = [Math]::Min($k + 1, $progress.Maximum) }
        return
    }
    $progress.Value = [Math]::Min($Index + 1, $progress.Maximum)
}

function Set-OrcInstalledLayout {
    if ($script:Headless) { return }
    $script:InstalledUi = $true
    $lblSub.Text = $script:InstalledSubtitle
    for ($i = 0; $i -lt $stepNames.Count; $i++) {
        $k = $script:InstalledStepOrder.IndexOf($i)
        if ($k -lt 0) {
            $stepIcons[$i].Visible = $false
            $stepLabels[$i].Visible = $false
            continue
        }
        $y = 12 + ($k * 34)
        $stepIcons[$i].Location = New-Object System.Drawing.Point(12, $y)
        $stepLabels[$i].Location = New-Object System.Drawing.Point(36, $y)
        $stepLabels[$i].Text = $script:InstalledStepNames[$i]
    }
    $progress.Maximum = $script:InstalledStepOrder.Count
    $progress.Value = 0
    $form.Refresh()
}

function Set-StepFail {
    param([int]$Index, [string]$Msg)
    if ($script:Headless) { Write-OrcHeadlessStep $Index "FAIL" $Msg; return }
    if ($Index -ge 0 -and $Index -lt $stepNames.Count) {
        $stepIcons[$Index].Text = [char]0x2718  # X mark
        $stepIcons[$Index].ForeColor = $script:Red
        $stepLabels[$Index].ForeColor = $script:Red
        if ($Msg) { $stepLabels[$Index].Text = $Msg }
    }
    $lblStatus.Text = $Msg
    $lblStatus.ForeColor = $script:Red
    $form.Refresh()
    Invoke-UiPump
}

function Set-StepSkip {
    param([int]$Index, [string]$Msg)
    if ($script:Headless) { Write-OrcHeadlessStep $Index "SKIP" $Msg; return }
    if ($Index -ge 0 -and $Index -lt $stepNames.Count) {
        $stepIcons[$Index].Text = "-"
        $stepIcons[$Index].ForeColor = $script:TextDim
        $stepLabels[$Index].ForeColor = $script:TextDim
        if ($Msg) { $stepLabels[$Index].Text = $Msg }
    }
    Update-OrcStepProgress $Index
    $form.Refresh()
    Invoke-UiPump
}

function Get-OrcErrorDetails {
    <# The technical text behind an installed-mode error: what "Copy details" puts on the clipboard. #>
    param([string]$Title, [string]$Msg, [string]$Details, [string]$DetailLog)
    $lines = @("OrcStrator error: $Title", $Msg)
    if ($Details) { $lines += $Details }
    try { $v = Get-OrcActiveVersion; if ($v) { $lines += "Version: $v" } } catch { }
    $lines += "Launcher log: $LogFile"
    if ($DetailLog) {
        $lines += "Log file: $DetailLog"
        $lines += "Last lines:"
        $lines += (Get-LogTail -Path $DetailLog -Lines 20)
    }
    return ($lines -join "`r`n")
}

function New-OrcErrorDialog {
    <#
      The installed-mode error box: what went wrong, then ONE thing to do,
      and a "Copy details" button for the technical part (log path, raw
      reason) instead of showing it to someone who cannot use it.
      Returned unshown so it can be rendered in tests.
    #>
    param([string]$Title, [string]$Msg, [string]$Action, [string]$Details)
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = $Title
    $dlg.FormBorderStyle = "FixedDialog"
    $dlg.MaximizeBox = $false
    $dlg.MinimizeBox = $false
    $dlg.ShowInTaskbar = $false
    $dlg.StartPosition = "CenterParent"
    $dlg.ClientSize = New-Object System.Drawing.Size(440, 200)
    $dlg.BackColor = [System.Drawing.SystemColors]::Window
    if ($form -and $form.Icon) { $dlg.Icon = $form.Icon }

    $lblMsg = New-Object System.Windows.Forms.Label
    $lblMsg.Font = New-Object System.Drawing.Font("Segoe UI", 10)
    $lblMsg.Location = New-Object System.Drawing.Point(20, 18)
    $lblMsg.MaximumSize = New-Object System.Drawing.Size(400, 0)
    $lblMsg.AutoSize = $true
    $lblMsg.Text = $Msg
    $dlg.Controls.Add($lblMsg)

    $lblAct = New-Object System.Windows.Forms.Label
    $lblAct.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
    $lblAct.MaximumSize = New-Object System.Drawing.Size(400, 0)
    $lblAct.AutoSize = $true
    $lblAct.Text = $Action
    $dlg.Controls.Add($lblAct)

    # Lay out after AutoSize has measured the message.
    $actY = $lblMsg.Location.Y + $lblMsg.PreferredHeight + 14
    $lblAct.Location = New-Object System.Drawing.Point(20, $actY)
    $btnY = $actY + $lblAct.PreferredHeight + 22

    $btnCopy = New-Object System.Windows.Forms.Button
    $btnCopy.Text = "Copy details"
    $btnCopy.Size = New-Object System.Drawing.Size(110, 30)
    $btnCopy.Location = New-Object System.Drawing.Point(20, $btnY)
    $btnCopy.Tag = $Details
    $btnCopy.Add_Click({
        param($s, $e)
        try {
            [System.Windows.Forms.Clipboard]::SetText([string]$s.Tag)
            $s.Text = "Copied"
        } catch {
            $s.Text = "Could not copy"
        }
    })
    $dlg.Controls.Add($btnCopy)

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = "OK"
    $btnOk.Size = New-Object System.Drawing.Size(90, 30)
    $btnOk.Location = New-Object System.Drawing.Point(330, $btnY)
    $btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $dlg.Controls.Add($btnOk)
    $dlg.AcceptButton = $btnOk

    $dlg.ClientSize = New-Object System.Drawing.Size(440, ($btnY + 48))
    return $dlg
}

function Show-Error {
    # -Action and -Details are for installed mode: the dialog shows the plain
    # message plus one action, and "Copy details" carries the technical part.
    # Without -Action (the developer path) the classic message box is used.
    param([string]$Title, [string]$Msg, [string]$DetailLog, [string]$Action, [string]$Details)
    if ($script:Headless) {
        $script:HeadlessError = "${Title}: $Msg"
        Log "ERROR: ${Title}: $Msg"
        if ($Details) { Log "  details: $Details" }
        if ($DetailLog) {
            Log "---- Last 20 lines of $DetailLog ----"
            foreach ($line in ((Get-LogTail -Path $DetailLog -Lines 20) -split "`n")) { Log "  $line" }
        }
        return
    }
    $lblStatus.Text = $Msg
    $lblStatus.ForeColor = $script:Red
    $form.Refresh()

    if ($Action) {
        Log "ERROR: ${Title}: $Msg"
        if ($Details) { Log "  details: $Details" }
        $all = Get-OrcErrorDetails -Title $Title -Msg $Msg -Details $Details -DetailLog $DetailLog
        $dlg = New-OrcErrorDialog -Title $Title -Msg $Msg -Action $Action -Details $all
        [void]$dlg.ShowDialog($form)
        $dlg.Dispose()
        return
    }

    $body = "$Msg`n`nCheck the log for details:`n$LogFile"
    if ($DetailLog) {
        $tail = Get-LogTail -Path $DetailLog -Lines 10
        $body = "$Msg`n`nLog file:`n$DetailLog`n`nLast lines:`n$tail"
        # Also surface the tail in the in-app log panel
        Log "---- Last 10 lines of $DetailLog ----"
        foreach ($line in ($tail -split "`n")) { Log "  $line" }
        Log "-------------------------------------"
    }
    [System.Windows.Forms.MessageBox]::Show(
        $body,
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
    param([string]$Cmd, [string]$CmdArgs, [string]$WorkDir, [int]$TimeoutSec = 300, [hashtable]$EnvVars)
    Log "Running: $Cmd $CmdArgs"

    # Use a temp .bat to reliably handle paths with spaces + capture output
    $uid = [guid]::NewGuid().ToString('N').Substring(0,8)
    $outFile = Join-Path $env:TEMP "orc_out_$uid.tmp"
    $errFile = Join-Path $env:TEMP "orc_err_$uid.tmp"
    $batFile = Join-Path $env:TEMP "orc_run_$uid.bat"

    # Write a bat that runs the command with proper quoting. EnvVars are set
    # inside the bat so they die with the child process (this window runs with
    # CreateNoWindow, so anything that tries to prompt would hang invisibly
    # until the timeout - see GitSilentEnv).
    $batLines = @("@echo off")
    if ($EnvVars) {
        foreach ($k in $EnvVars.Keys) { $batLines += "set `"$k=$($EnvVars[$k])`"" }
    }
    $batLines += "`"$Cmd`" $CmdArgs > `"$outFile`" 2> `"$errFile`""
    Set-Content -Path $batFile -Value $batLines -Encoding ASCII

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
        Invoke-UiPump
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

# Environment for every git call we make from the GUI. When the origin
# needs sign-in, an un-authenticated machine WILL hit a credential prompt.
# These two vars turn that prompt into a fast, readable failure instead of a
# hidden window that blocks until the timeout:
#   GIT_TERMINAL_PROMPT=0  - no console username/password prompt
#   GCM_INTERACTIVE=never  - no Git Credential Manager popup
# The interactive sign-in path (Invoke-GitHubSignIn) deliberately omits both.
$script:GitSilentEnv = @{
    GIT_TERMINAL_PROMPT = "0"
    GCM_INTERACTIVE     = "never"
}

function Test-GitAuthFailure {
    # True when git failed because we are not signed in / not allowed, as
    # opposed to a network blip. GitHub answers unauthorized reads of a private
    # repo with a 404, so "Repository not found" is an auth failure here.
    param($Result)
    if (-not $Result) { return $false }
    if ($Result.ExitCode -eq 0) { return $false }
    $text = "$($Result.Output) $($Result.Error)"
    if (-not $text.Trim()) { return $false }
    $patterns = @(
        'could not read Username',
        'could not read Password',
        'terminal prompts disabled',
        'Authentication failed',
        'Invalid username or (token|password)',
        'HTTP Basic: Access denied',
        'returned error: 40[13]',
        'Repository not found',
        'Permission denied \(publickey\)',
        'Host key verification failed',
        'interactivity (is|has been) disabled',
        'no credentials'
    )
    foreach ($p in $patterns) {
        if ($text -imatch $p) { return $true }
    }
    return $false
}

function Invoke-GitRetry {
    # Run a git (or any network-ish) command with up to 3 attempts, 5s apart.
    # Auth failures return immediately: retrying a sign-in problem just burns
    # 10 seconds and fails identically. Callers read .AuthFailed to tell the
    # two apart.
    param([string]$Cmd, [string]$CmdArgs, [string]$WorkDir, [int]$TimeoutSec = 60, [hashtable]$EnvVars)
    if (-not $EnvVars) { $EnvVars = $script:GitSilentEnv }
    $result = @{ ExitCode = -1; Output = ""; Error = "not run"; AuthFailed = $false }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $result = Run-Cmd $Cmd $CmdArgs -WorkDir $WorkDir -TimeoutSec $TimeoutSec -EnvVars $EnvVars
        $result.AuthFailed = (Test-GitAuthFailure $result)
        if ($result.ExitCode -eq 0) { return $result }
        if ($result.AuthFailed) {
            Log "Git auth failure (not retrying): $Cmd $CmdArgs"
            return $result
        }
        Log "Attempt $attempt failed for: $Cmd $CmdArgs (exit $($result.ExitCode))"
        if ($attempt -lt 3) {
            # Keep the UI alive during the 5s backoff
            $until = [DateTime]::Now.AddSeconds(5)
            while ([DateTime]::Now -lt $until) {
                Invoke-UiPump
                Start-Sleep -Milliseconds 200
            }
        }
    }
    return $result
}

function Get-UpstreamRef {
    # Which remote branch this install tracks. Never hardcode it: the default
    # branch is "main", and the old hardcoded "origin/master" made rev-list
    # throw, which the caller swallowed as "0 commits behind" - so the launcher
    # reported "Up to date" forever and updates silently never happened.
    param([string]$Git, [string]$WorkDir)
    $candidates = @()
    try {
        $u = ((& $Git -C $WorkDir rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>&1) -join "").Trim()
        if ($LASTEXITCODE -eq 0 -and $u -and $u -notmatch 'fatal') { $candidates += $u }
    } catch { }
    try {
        $h = ((& $Git -C $WorkDir symbolic-ref --short refs/remotes/origin/HEAD 2>&1) -join "").Trim()
        if ($LASTEXITCODE -eq 0 -and $h -and $h -notmatch 'fatal') { $candidates += $h }
    } catch { }
    $candidates += @('origin/main', 'origin/master')

    foreach ($ref in $candidates) {
        try {
            & $Git -C $WorkDir rev-parse --verify --quiet "$ref^{commit}" > $null 2>&1
            if ($LASTEXITCODE -eq 0) { return $ref }
        } catch { }
    }
    Log "Could not resolve an upstream ref (tried: $($candidates -join ', '))"
    return $null
}

function Invoke-GitHubSignIn {
    # Interactive one-time GitHub sign-in. Runs git in a VISIBLE console with
    # prompting re-enabled (no GitSilentEnv), so either Git Credential
    # Manager's browser flow or a plain terminal prompt can complete.
    # Credentials land in Windows Credential Manager, so every later silent
    # fetch/pull just works. Returns $true when git exited 0.
    param([string]$Git, [string]$GitArgs)

    # Make sure a credential helper is configured, or nothing gets saved and
    # the user is asked to sign in again on every launch. Git for Windows sets
    # credential.helper=manager in its system config, so this is normally a
    # no-op; it only matters on an unusual git install.
    # Never fall back to "store": that writes the token to ~/.git-credentials
    # in plaintext. Both options below use the Windows credential vault.
    try {
        $helper = ((& $Git config --get credential.helper 2>&1) -join "").Trim()
    } catch { $helper = "" }
    if (-not $helper -or $helper -match 'fatal') {
        # Probe through git's exec-path: the helper binaries live in
        # mingw64\bin, which is not usually on PATH.
        $hasGcm = $false
        try {
            & $Git credential-manager --version > $null 2>&1
            $hasGcm = ($LASTEXITCODE -eq 0)
        } catch { }
        $chosen = if ($hasGcm) { "manager" } else { "wincred" }
        Log "No credential helper configured; setting credential.helper=$chosen"
        try { & $Git config --global credential.helper $chosen 2>&1 | Out-Null } catch { }
    }

    # Any git command that touches the remote will trigger the credential
    # flow; the caller picks one that makes sense for its situation (fetch for
    # an existing clone, clone for a first install).
    $uid = [guid]::NewGuid().ToString('N').Substring(0,8)
    $batFile = Join-Path $env:TEMP "orc_signin_$uid.bat"
    $lines = @(
        "@echo off",
        "title OrcStrator - Sign in to GitHub",
        "echo OrcStrator could not reach the repository it was installed from.",
        "echo Sign in with a GitHub account that can access it.",
        "echo.",
        "`"$Git`" $GitArgs",
        "if errorlevel 1 (",
        "  echo.",
        "  echo Sign-in did not complete. You can close this window and try again.",
        "  pause",
        "  exit /b 1",
        ")",
        "exit /b 0"
    )
    Set-Content -Path $batFile -Value $lines -Encoding ASCII

    Log "Launching interactive GitHub sign-in: git $GitArgs"
    $ok = $false
    try {
        $proc = Start-Process cmd.exe -ArgumentList "/c", "`"$batFile`"" -Wait -WindowStyle Normal -PassThru
        $ok = ($proc.ExitCode -eq 0)
    } catch {
        Log "Sign-in window failed to start: $_"
    }
    Remove-Item $batFile -Force -ErrorAction SilentlyContinue
    Log "Interactive sign-in finished (success=$ok)"
    return $ok
}

function Test-ServerHealth {
    # Real health check: HTTP 200 + status "ok" from the API, not just an open TCP port.
    param([int]$Port)
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($resp.StatusCode -ne 200) { return $false }
        $body = $resp.Content | ConvertFrom-Json
        return ($body.status -eq "ok")
    } catch {
        return $false
    }
}

function Get-LogTail {
    param([string]$Path, [int]$Lines = 10)
    try {
        if (Test-Path $Path) {
            return ((Get-Content $Path -Tail $Lines -ErrorAction Stop) -join "`n")
        }
    } catch { }
    return "(log file not found: $Path)"
}

function Wait-FileWritable {
    # Poll until a file can be opened for write (no other process holding its
    # handle). Used before redirecting a fresh process into a log that a
    # just-killed process may still hold open. OpenOrCreate does NOT truncate,
    # so existing log content is preserved. Returns $true once writable.
    param([string]$Path, [int]$MaxTries = 12, [int]$DelayMs = 300)
    for ($i = 0; $i -lt $MaxTries; $i++) {
        try {
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $fs.Close()
            $fs.Dispose()
            return $true
        } catch {
            Invoke-UiPump
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    Log "Wait-FileWritable: '$Path' still locked after $MaxTries tries - proceeding anyway"
    return $false
}

function Get-LockfileHash {
    $lockPath = Join-Path $RepoRoot "package-lock.json"
    try {
        if (Test-Path $lockPath) {
            return (Get-FileHash -Path $lockPath -Algorithm SHA256).Hash
        }
    } catch { }
    return ""
}

# ══════════════════════════════════════════════════════════════
#  UPDATE CHECK
# ══════════════════════════════════════════════════════════════

function Set-UpdateBanner {
    # ColorKey (not a raw Color) so Apply-Theme can re-resolve the banner's
    # color against the new palette on a light/dark toggle without losing the
    # current state.
    param(
        [string]$Title,
        [string]$Sub,
        [ValidateSet('dim', 'green', 'yellow', 'red')]
        [string]$ColorKey = 'dim',
        [switch]$Clickable
    )
    $script:UpdateTitle = $Title
    $script:UpdateSub = $Sub
    $script:UpdateColorKey = $ColorKey
    if ($script:Headless) { Log "update: $Title $(if ($Sub) { "($Sub)" })"; return }
    $c = switch ($ColorKey) {
        'green'  { $script:Green }
        'yellow' { $script:Yellow }
        'red'    { $script:Red }
        default  { $script:TextDim }
    }
    $btnUpdate.Visible = $true   # undo Hide-OrcUpdateBanner if the repo root moved (fresh clone)
    $btnUpdate.ForeColor = $c
    $btnUpdate.FlatAppearance.BorderColor = $c
    $btnUpdate.FlatAppearance.BorderSize = if ($Clickable) { 2 } else { 1 }
    $btnUpdate.Enabled = [bool]$Clickable
    $btnUpdate.Cursor = if ($Clickable) { [System.Windows.Forms.Cursors]::Hand } else { [System.Windows.Forms.Cursors]::Default }
    $btnUpdate.Invalidate()
    $form.Refresh()
}

function Check-ForArtifactUpdates {
    # Artifact-mode counterpart of Check-ForUpdates. Same banner states, but
    # the source of truth is a signed manifest rather than git.
    Log "Checking for OrcStrator updates (artifact channel '$(Get-OrcUpdateChannel)')..."
    $script:UpdateAvailable = $false
    $script:UpdateAuthNeeded = $false
    $script:PendingManifest = $null
    Set-UpdateBanner -Title "Checking for updates..." -Sub "" -ColorKey 'dim'
    Invoke-UiPump

    $m = Get-OrcUpdateManifest -BaseUrl $script:UpdateBaseUrl -PublicKeyXml $script:ReleasePublicKeys
    $current = Get-OrcActiveVersion
    if (-not $m) {
        if ($script:UpdateRejectReason -match 'SIGNATURE|HASH') {
            # Never quietly downgrade this to "check failed". If a manifest is
            # failing verification the user needs to know something is wrong.
            Log "Update refused: $($script:UpdateRejectReason)"
            Set-UpdateBanner -Title "Update not installed" `
                             -Sub "This update could not be verified and was not installed. We will try again later." `
                             -ColorKey 'red'
        } elseif ($script:UpdateRejectReason -eq "this release was withdrawn") {
            $onText = if ($current) { "You stay on version $current. Nothing is wrong on this computer." } else { "" }
            Set-UpdateBanner -Title "That update was withdrawn" -Sub $onText -ColorKey 'green'
        } elseif ($script:UpdateRejectReason -eq "no update offered right now") {
            # A staged rollout or a withdrawn release: nothing is
            # wrong on this computer, so no alarm.
            $onText = if ($current) { "Version $current" } else { "" }
            Set-UpdateBanner -Title "No update right now" -Sub $onText -ColorKey 'green'
        } else {
            Log "Update check failed: $($script:UpdateRejectReason)"
            $onText = if ($current) { "You are on version $current." } else { "" }
            Set-UpdateBanner -Title "Could not check for updates" -Sub $onText -ColorKey 'dim'
        }
        return
    }

    $skip = Get-OrcUpdateSkipReason -Candidate $m.version -Current $current
    if ($skip -eq "already up to date") {
        Set-UpdateBanner -Title "Up to date" -Sub "Version $current" -ColorKey 'green'
        return
    }
    if ($skip) {
        # A release that already crashed here once is not offered again.
        Log "Update check: $skip"
        Set-UpdateBanner -Title "Up to date" `
                         -Sub "Version $current. Version $($m.version) did not start on this computer, waiting for a newer one." `
                         -ColorKey 'dim'
        return
    }
    $script:PendingManifest = $m
    $script:UpdateAvailable = $true
    $fromText = if ($current) { "You have $current." } else { "" }
    Set-UpdateBanner -Title "Update available" `
                     -Sub "Click to install version $($m.version). $fromText" `
                     -ColorKey 'yellow' -Clickable
}

function Hide-OrcUpdateBanner {
    # A source build has no update source, so it gets no banner at all rather
    # than a permanent "Updates unavailable" box.
    $script:UpdateTitle = ""
    $script:UpdateSub = ""
    if ($script:Headless -or -not $btnUpdate) { return }
    $btnUpdate.Enabled = $false
    $btnUpdate.Visible = $false
}

function Invoke-OrcBootPull {
    <#
      The launch-time `git pull --ff-only` of a developer checkout. Returns
      Attempted (a pull ran), Moved (HEAD changed, so the caller relaunches),
      ShaAfter and AuthFailed. No pull at all for a copy without .git or when
      Test-OrcGitAutoUpdate says this is a source build.
    #>
    param([string]$Git, [string]$Root = $RepoRoot)
    $res = [pscustomobject]@{ Attempted = $false; Moved = $false; ShaAfter = ""; AuthFailed = $false; Reason = "" }
    if (-not (Test-Path (Join-Path $Root ".git"))) { $res.Reason = "not a git checkout"; return $res }
    if (-not (Test-OrcGitAutoUpdate -Root $Root)) { $res.Reason = "git auto-update is off"; return $res }
    $res.Attempted = $true
    $shaBefore = ""
    try { $shaBefore = ((& $Git -C $Root rev-parse HEAD 2>&1) -join "").Trim() } catch { }
    $r = Invoke-GitRetry $Git "pull --ff-only" -WorkDir $Root -TimeoutSec 30
    Log "git pull: $($r.Output)"
    $res.AuthFailed = [bool]$r.AuthFailed
    $shaAfter = ""
    try { $shaAfter = ((& $Git -C $Root rev-parse HEAD 2>&1) -join "").Trim() } catch { }
    $res.ShaAfter = $shaAfter
    $res.Moved = [bool]($r.ExitCode -eq 0 -and $shaBefore -and $shaAfter -and ($shaBefore -ne $shaAfter))
    return $res
}

function Check-ForUpdates {
    if ($script:ArtifactMode) { Check-ForArtifactUpdates; return }

    # Source build: no fetch, no banner. See Test-OrcGitAutoUpdate.
    if (-not (Test-OrcGitAutoUpdate)) {
        Log "Update check skipped: git auto-update is off for this checkout (source build)"
        $script:UpdateAvailable = $false
        $script:UpdateAuthNeeded = $false
        $script:CommitsBehind = 0
        Hide-OrcUpdateBanner
        return
    }

    Log "Checking for OrcStrator updates..."
    $script:UpdateAvailable = $false
    $script:UpdateAuthNeeded = $false
    $script:CommitsBehind = 0
    Set-UpdateBanner -Title "Checking for updates..." -Sub "" -ColorKey 'dim'
    Invoke-UiPump

    $git = Find-Exe "git"
    if (-not $git) {
        Set-UpdateBanner -Title "Updates unavailable" -Sub "Git not found." -ColorKey 'dim'
        return
    }

    # A copy extracted from a zip has no .git and can never self-update. Say
    # that plainly instead of falling through and blaming the network.
    $isRepo = $false
    try {
        & $git -C $RepoRoot rev-parse --git-dir > $null 2>&1
        $isRepo = ($LASTEXITCODE -eq 0)
    } catch { }
    if (-not $isRepo) {
        Log "Update check: $RepoRoot is not a git checkout"
        Set-UpdateBanner -Title "Updates unavailable" `
                         -Sub "This copy is not a git checkout, so it cannot update itself." `
                         -ColorKey 'dim'
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
    $daysText = if ($daysOld -lt 0) { "unknown" } elseif ($daysOld -eq 0) { "today" } elseif ($daysOld -eq 1) { "yesterday" } else { "$daysOld days ago" }

    # Fetch from remote (quick, just metadata), retried for flaky networks
    $fetchResult = Invoke-GitRetry $git "fetch --quiet" -WorkDir $RepoRoot -TimeoutSec 20
    Invoke-UiPump

    if ($fetchResult.AuthFailed) {
        # Repository wants sign-in + no stored credentials. This is fixable by the user, so
        # make the banner the button that fixes it.
        $script:UpdateAuthNeeded = $true
        Log "Update check: GitHub sign-in required"
        Set-UpdateBanner -Title "Sign in to GitHub" `
                         -Sub "OrcStrator could not reach its update source. Click to connect your GitHub account." `
                         -ColorKey 'yellow' -Clickable
        return
    }
    if ($fetchResult.ExitCode -ne 0) {
        Log "Update check: fetch failed (exit $($fetchResult.ExitCode))"
        Set-UpdateBanner -Title "Update check failed" `
                         -Sub "Could not reach GitHub. Last updated $daysText" `
                         -ColorKey 'dim'
        return
    }

    $upstream = Get-UpstreamRef -Git $git -WorkDir $RepoRoot
    if (-not $upstream) {
        Set-UpdateBanner -Title "Updates unavailable" `
                         -Sub "This copy does not track a GitHub branch. Log: $LogFile" `
                         -ColorKey 'dim'
        return
    }

    # Count commits behind. A parse failure here must NOT be reported as
    # "Up to date" - that is exactly how the old origin/master bug hid itself.
    $behindOk = $false
    try {
        $behindOutput = ((& $git -C $RepoRoot rev-list "HEAD..$upstream" --count 2>&1) -join "").Trim()
        if ($LASTEXITCODE -eq 0 -and $behindOutput -match '^\d+$') {
            $script:CommitsBehind = [int]$behindOutput
            $behindOk = $true
        } else {
            Log "rev-list HEAD..$upstream returned: $behindOutput"
        }
    } catch {
        Log "Could not check commits behind: $_"
    }

    if (-not $behindOk) {
        Set-UpdateBanner -Title "Update check failed" `
                         -Sub "Could not compare against $upstream. Log: $LogFile" `
                         -ColorKey 'dim'
        return
    }

    Log "Update check: $($script:CommitsBehind) commits behind $upstream, local is ${daysOld} days old"

    if ($script:CommitsBehind -gt 0) {
        $script:UpdateAvailable = $true
        $updatesWord = if ($script:CommitsBehind -eq 1) { "update" } else { "updates" }
        Set-UpdateBanner -Title "Update available" `
                         -Sub "Click to update. Last updated $daysText - $($script:CommitsBehind) new $updatesWord" `
                         -ColorKey 'yellow' -Clickable
    } else {
        Set-UpdateBanner -Title "Up to date" -Sub "Last updated $daysText" -ColorKey 'green'
    }
}

# ══════════════════════════════════════════════════════════════
#  ARTIFACT UPDATER (pipeline phase 2)
# ══════════════════════════════════════════════════════════════
# Downloads signed build artifacts instead of running `git pull`, so an
# install needs no GitHub access, no git, and eventually no Node.
#
# These functions are INLINE rather than dot-sourced from the payload on
# purpose: the verifier cannot live in the thing it is verifying. Everything
# below must stay .NET Framework 4.8 compatible (PowerShell 5.1).
#
# Layout, deliberately keeping the running launcher OUT of the swapped tree so
# a version swap never fights open file handles:
#
#   <root>\versions\<version>\  extracted payloads (each carries its own
#                               installer\setup.ps1, which OrcStrator.exe
#                               runs for the active version: launcher
#                               self-update, see Resolve-OrcLauncherScript)
#   <root>\current.txt          which version is active

# Public keys this install trusts. A LIST so a key rotation can accept the old
# and new key for one release cycle: add the new key to the release config
# (see below), ship one release
# signed with the OLD key, then start signing with the new one. Swapping both
# at once bricks self-update for every install that has not updated yet.
# The private half never ships anywhere. An empty list makes the artifact
# updater refuse everything (fail closed).
#
# SOURCE BUILDS: this list and the update URL below are EMPTY in source, so a
# copy built from source never checks for updates and trusts no releases.
# A release build writes its own values into the PACKAGED copies of this file
# from a release config (installer\release\release-lib.ps1,
# Set-OrcLauncherReleaseConfig). Keep both assignments in exactly this shape:
# the release build finds and replaces them by pattern.
$script:ReleasePublicKeys = @(
    # Empty in source builds: no release key is trusted.
)

# Update server (the Cloudflare Worker in worker/). ORC_UPDATE_BASE_URL
# overrides it, which is how the tests point the launcher at a local server.
# A checkout with .git never uses this: Test-OrcArtifactMode keeps it on git.
$script:DefaultUpdateBaseUrl = ''
$script:UpdateBaseUrl = if ($env:ORC_UPDATE_BASE_URL) { $env:ORC_UPDATE_BASE_URL } else { $script:DefaultUpdateBaseUrl }
# What error dialogs tell people to download when their copy is broken:
# always the public link, never a test override of the update URL.
$script:DownloadUrl = if ($script:DefaultUpdateBaseUrl) { "$($script:DefaultUpdateBaseUrl)/download/latest" } else { 'the place you downloaded OrcStrator from' }

function Test-OrcArtifactMode {
    <#
      Phase 3's switch. Artifact updates apply only to real installs:

      - A checkout WITH .git is a developer working copy. Replacing it with an
        extracted payload would blow away their branch, so git always wins
        there, no matter what else is configured.
      - No embedded public key or no channel URL means we cannot verify
        anything, so there is nothing safe to do but stay on git.

      Kept as a function so the decision is testable rather than a tangle of
      inline conditions.
    #>
    param([string]$RepoPath, [string]$BaseUrl, [AllowEmptyCollection()][string[]]$PublicKeyXml)
    if (Test-Path (Join-Path $RepoPath ".git")) { return $false }
    if (-not $BaseUrl) { return $false }
    if (-not $PublicKeyXml -or $PublicKeyXml.Count -eq 0) { return $false }
    return $true
}

$script:ArtifactMode = Test-OrcArtifactMode -RepoPath $RepoRoot -BaseUrl $script:UpdateBaseUrl -PublicKeyXml $script:ReleasePublicKeys

function Get-OrcUpdateChannel {
    <#
      ORC_UPDATE_CHANNEL (env) wins, then the launcher-state setting
      "updateChannel", then stable. A first install from a beta installer
      records "beta" there (see Invoke-OrcInstalledLaunch), so a machine set
      up from a beta build keeps following beta without anyone editing JSON.
    #>
    param([string]$EnvValue = $env:ORC_UPDATE_CHANNEL, $State = $null)
    $c = $EnvValue
    if (-not $c) {
        try {
            $st = if ($State) { $State } else { Get-LauncherState }
            if ($st.PSObject.Properties['updateChannel']) { $c = $st.updateChannel }
        } catch { }
    }
    $c = ("" + $c).Trim().ToLowerInvariant()
    # Only these two exist on the update Worker; anything else is stable.
    if (@('stable', 'beta') -contains $c) { return $c }
    return 'stable'
}

function Get-OrcInstallId {
    <#
      A random id for this install, kept in launcher-state "installId" and sent
      to the update server with every check. The server buckets it
      for staged rollouts; without one, any rollout below 100% withheld the
      update from everybody. It identifies the install, not the person.
    #>
    param($State = $null)
    $st = if ($State) { $State } else { Get-LauncherState }
    $id = ""
    if ($st.PSObject.Properties['installId']) { $id = ("" + $st.installId).Trim() }
    $g = [guid]::Empty
    if ($id -and [guid]::TryParse($id, [ref]$g)) { return $g.ToString('D') }
    $id = [guid]::NewGuid().ToString('D')
    try { Set-LauncherStateValue -Name 'installId' -Value $id } catch { }
    return $id
}

function Get-OrcUpdateHeaders {
    <#
      What every request to the update server carries, as HEADERS, never in
      the URL: the install id for staged rollouts, and the
      licence key when this install has one. Used for the manifest AND the
      payload download, so a licensed install can fetch what it was offered.
    #>
    $h = @{ 'X-Orc-Install-Id' = (Get-OrcInstallId) }
    try {
        $st = Get-LauncherState
        $lic = ''
        if ($st.PSObject.Properties['licenceKey']) { $lic = ([string]$st.licenceKey).Trim() }
        if ($lic) { $h['Authorization'] = 'Bearer ' + $lic }
    } catch { }
    return $h
}

function ConvertTo-OrcCanonicalJson {
    # Must match installer/release/release-lib.ps1 byte for byte, or nothing
    # CI signs will ever verify here.
    param($Object)
    return [System.Text.Encoding]::UTF8.GetBytes(($Object | ConvertTo-Json -Depth 12 -Compress))
}

function Test-OrcSignedManifest {
    # Fails CLOSED on every path. A signature failure is a security event, not
    # a network blip, so this returns $false rather than throwing into a caller
    # that might retry it as a transient error.
    param($Envelope, [AllowEmptyCollection()][string[]]$PublicKeyXml)
    try {
        if (-not $Envelope) { return $false }
        if (-not $Envelope.manifest) { return $false }
        if (-not $Envelope.signature) { return $false }
        if ($Envelope.alg -ne 'RS256') { return $false }
        $bytes = ConvertTo-OrcCanonicalJson $Envelope.manifest
        $sig = [Convert]::FromBase64String($Envelope.signature)
        foreach ($pub in $PublicKeyXml) {
            if (-not $pub) { continue }
            $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
            try {
                $rsa.FromXmlString($pub)
                if ($rsa.VerifyData($bytes, $sig,
                        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
                        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)) { return $true }
            } catch {
            } finally { $rsa.Dispose() }
        }
        return $false
    } catch { return $false }
}

function Test-OrcPayload {
    param([string]$ZipPath, $Manifest)
    try {
        if (-not (Test-Path $ZipPath)) { return $false }
        if ((Get-Item $ZipPath).Length -ne $Manifest.size) { return $false }
        $h = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        return ($h -eq ("" + $Manifest.sha256).ToLowerInvariant())
    } catch { return $false }
}

function Compare-OrcVersion {
    # -1 / 0 / 1, semver 2.0.0 precedence (section 11):
    #   - numeric dotted parts compare numerically (2.10.0 > 2.9.0)
    #   - a release beats any of its prereleases (2.1.0 > 2.1.0-beta.10)
    #   - prerelease identifiers compare dot by dot: numeric ones numerically
    #     (beta.10 > beta.9), alphanumeric ones in ASCII order, a numeric one
    #     sorts BELOW an alphanumeric one, and when every shared identifier is
    #     equal the longer list wins (beta.1.1 > beta.1)
    #   - build metadata (+...) is ignored
    param([string]$A, [string]$B)
    function Split-V([string]$v) {
        $v = ("" + $v).Trim()
        $plus = $v.IndexOf('+'); if ($plus -ge 0) { $v = $v.Substring(0, $plus) }
        $pre = [string[]]@()
        $dash = $v.IndexOf('-')
        if ($dash -ge 0) {
            $preText = $v.Substring($dash + 1); $v = $v.Substring(0, $dash)
            if ($preText) { $pre = [string[]]$preText.Split('.') }
        }
        $nums = @()
        foreach ($p in $v.Split('.')) { $n = 0; [void][int]::TryParse($p, [ref]$n); $nums += $n }
        while ($nums.Count -lt 3) { $nums += 0 }
        return @{ Nums = $nums; Pre = $pre }
    }
    function Compare-Ident([string]$p, [string]$q) {
        $pn = $p -match '^[0-9]+$'; $qn = $q -match '^[0-9]+$'
        if ($pn -and $qn) {
            # Compare digit strings without parsing, so no identifier is too
            # long for an int: strip leading zeros, then length, then ordinal.
            $p2 = $p.TrimStart('0'); $q2 = $q.TrimStart('0')
            if ($p2.Length -ne $q2.Length) { return [Math]::Sign($p2.Length - $q2.Length) }
            return [Math]::Sign([string]::CompareOrdinal($p2, $q2))
        }
        if ($pn) { return -1 }
        if ($qn) { return 1 }
        return [Math]::Sign([string]::CompareOrdinal($p, $q))
    }
    $x = Split-V $A; $y = Split-V $B
    $len = [Math]::Max($x.Nums.Count, $y.Nums.Count)
    for ($i = 0; $i -lt $len; $i++) {
        $xi = if ($i -lt $x.Nums.Count) { $x.Nums[$i] } else { 0 }
        $yi = if ($i -lt $y.Nums.Count) { $y.Nums[$i] } else { 0 }
        if ($xi -gt $yi) { return 1 }
        if ($xi -lt $yi) { return -1 }
    }
    $xp = @($x.Pre); $yp = @($y.Pre)
    if ($xp.Count -eq 0 -and $yp.Count -eq 0) { return 0 }
    if ($xp.Count -eq 0) { return 1 }
    if ($yp.Count -eq 0) { return -1 }
    $n = [Math]::Min($xp.Count, $yp.Count)
    for ($i = 0; $i -lt $n; $i++) {
        $c = Compare-Ident $xp[$i] $yp[$i]
        if ($c -ne 0) { return $c }
    }
    return [Math]::Sign($xp.Count - $yp.Count)
}

function Get-OrcUpdateSkipReason {
    <#
      Why a signed, verified release should NOT be installed, or "" when it
      should. One rule for every place that offers or applies an update (the
      banner, the headless check, the updater itself):

        - not newer than what is running: "already up to date"
        - not newer than a version that already failed to boot here and was
          rolled back (launcher state "failedVersion"): skipped, so a crashing
          release is not re-offered or re-applied on every launch. A strictly
          newer release is offered as normal.
    #>
    param([string]$Candidate, [string]$Current, $Failed = $null)
    if ($null -eq $Failed) {
        $Failed = ""
        try {
            $st = Get-LauncherState
            if ($st.PSObject.Properties['failedVersion']) { $Failed = "" + $st.failedVersion }
        } catch { }
    }
    $Failed = ("" + $Failed).Trim()
    if ($Current -and (Compare-OrcVersion $Candidate $Current) -le 0) { return "already up to date" }
    if ($Failed -and (Compare-OrcVersion $Candidate $Failed) -le 0) {
        return "version $Candidate is skipped: version $Failed failed to start on this computer and was rolled back"
    }
    return ""
}

function Get-OrcInstallRoot {
    param([string]$Root)
    if (-not $Root) { $Root = $script:ArtifactRoot }
    return $Root
}

function Get-OrcActiveVersion {
    param([string]$Root)
    $Root = Get-OrcInstallRoot $Root
    $f = Join-Path $Root "current.txt"
    if (-not (Test-Path $f)) { return $null }
    try {
        $v = ((Get-Content $f -Raw -ErrorAction Stop) -join "").Trim()
        if ($v) { return $v }
    } catch { }
    return $null
}

function Set-OrcActiveVersion {
    # Write-then-move so a crash mid-write cannot leave current.txt truncated,
    # which would make the launcher forget which version is installed.
    param([string]$Root, [Parameter(Mandatory)][string]$Version)
    $Root = Get-OrcInstallRoot $Root
    if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
    $f = Join-Path $Root "current.txt"
    $tmp = "$f.tmp"
    [System.IO.File]::WriteAllText($tmp, $Version, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::Copy($tmp, $f, $true)
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

function Get-OrcVersionPath {
    param([string]$Root, [Parameter(Mandatory)][string]$Version)
    return (Join-Path (Join-Path (Get-OrcInstallRoot $Root) "versions") $Version)
}

function Resolve-OrcLauncherScript {
    <#
      Which setup.ps1 OrcStrator.exe runs. MIRRORS installer/starter/OrcStrator.cs
      (test-launcher-self-update.ps1 checks the two agree on every case), and
      is what the launcher itself uses to relaunch after an update.

        1. {app} is a git checkout: {app}\installer\setup.ps1, always (the
           developer path never runs a payload's launcher).
        2. <data root>\app\current.txt names a version (strict version regex),
           <data root>\app\versions\<v>\installer\setup.ps1 exists, stays
           inside <data root>\app\versions, and carries the starter contract
           marker: run THAT copy with -LauncherRoot {app}. It was signature
           and hash verified when the payload was installed, so launcher
           fixes and key rotations reach installs through normal updates.
        3. Anything else: {app}\installer\setup.ps1, as before.

      Data root: ORCSTRATOR_DATA_DIR (trimmed) else %LOCALAPPDATA%\OrcStrator,
      the same answer Resolve-OrcDataRoot gives for a folder with no .git.
    #>
    param([Parameter(Mandatory)][string]$LauncherRoot,
          [string]$DataOverride = $env:ORCSTRATOR_DATA_DIR,
          [string]$LocalAppData = $env:LOCALAPPDATA)
    $app = [System.IO.Path]::GetFullPath($LauncherRoot).TrimEnd('\')
    $fallback = Join-Path (Join-Path $app "installer") "setup.ps1"
    $out = @{ Script = $fallback; LauncherRootArg = ""; Source = "app"; Reason = "" }
    if (Test-Path -LiteralPath (Join-Path $app ".git")) { $out.Source = "dev"; return $out }
    $dataRoot = ("" + $DataOverride).Trim()
    if (-not $dataRoot) {
        if (-not $LocalAppData) { $out.Reason = "no data root"; return $out }
        $dataRoot = Join-Path $LocalAppData "OrcStrator"
    }
    try {
        $appDir = Join-Path $dataRoot "app"
        $cur = Join-Path $appDir "current.txt"
        if (-not (Test-Path -LiteralPath $cur -PathType Leaf)) { $out.Reason = "no current.txt"; return $out }
        $v = ([System.IO.File]::ReadAllText($cur)).Trim()
        # A BOM is not whitespace to Trim(); drop it explicitly.
        $v = $v.TrimStart([char]0xFEFF).Trim()
        # The only shape current.txt may have for the starter to follow it.
        # Must match VersionPattern in installer/starter/OrcStrator.cs.
        $versionPattern = '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$'
        if ($v -cnotmatch $versionPattern) { $out.Reason = "current.txt is not a version"; return $out }
        $versions = [System.IO.Path]::GetFullPath((Join-Path $appDir "versions")).TrimEnd('\') + '\'
        $candidate = [System.IO.Path]::GetFullPath((Join-Path (Join-Path (Join-Path $versions $v) "installer") "setup.ps1"))
        if (-not $candidate.StartsWith($versions, [System.StringComparison]::OrdinalIgnoreCase)) { $out.Reason = "outside versions"; return $out }
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { $out.Reason = "version has no launcher"; return $out }
        if (-not ([System.IO.File]::ReadAllText($candidate)).Contains("orc-starter-contract: launcher-root-v1")) {
            $out.Reason = "version launcher predates -LauncherRoot"; return $out
        }
        $out.Script = $candidate
        $out.LauncherRootArg = $app
        $out.Source = "version"
        $out.Reason = $v
    } catch { $out.Reason = "error: $_" }
    return $out
}

function Get-OrcRelaunchArgs {
    <#
      powershell.exe arguments that restart the launcher. The developer path
      re-runs this very script. An installed copy re-resolves which launcher
      to run exactly as OrcStrator.exe does, so after an update the relaunch
      already runs the NEW version's launcher. Paths are quoted: Start-Process
      joins an argument array with plain spaces.
    #>
    param([switch]$SkipUpdates)
    $target = $script:LauncherScript
    $extra = @()
    if ($script:ArtifactMode) {
        $pick = Resolve-OrcLauncherScript -LauncherRoot $script:LauncherRoot
        $target = $pick.Script
        if ($pick.LauncherRootArg) { $extra = @('-LauncherRoot', "`"$($pick.LauncherRootArg)`"") }
    }
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$target`"") + $extra
    if ($SkipUpdates) { $a += '-SkipUpdates' }
    if ($script:ProductionMode) { $a += '-Production' }
    return ,$a
}

function Get-OrcUpdateManifest {
    <#
      Fetch and VERIFY the channel manifest. Returns the manifest object, or
      $null with $script:UpdateRejectReason set. Callers must treat $null as
      "do not update" without exception.
    #>
    param([string]$BaseUrl, [AllowEmptyCollection()][string[]]$PublicKeyXml, [int]$TimeoutSec = 20,
          [string]$Channel = "")
    $script:UpdateRejectReason = ""
    if (-not $BaseUrl) { $script:UpdateRejectReason = "no update URL configured"; return $null }
    if (-not $PublicKeyXml -or $PublicKeyXml.Count -eq 0) {
        # Refusing here is the whole point: with no trusted key, ANY manifest
        # would have to be taken on faith.
        $script:UpdateRejectReason = "no release public key embedded in this build"
        return $null
    }
    if (-not $Channel) { $Channel = Get-OrcUpdateChannel }
    if (@('stable', 'beta') -notcontains $Channel) {
        $script:UpdateRejectReason = "unknown update channel '$Channel'"
        return $null
    }
    $url = "$($BaseUrl.TrimEnd('/'))/$Channel.json"
    $raw = $null
    $headers = Get-OrcUpdateHeaders
    try {
        $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
        $resp = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        $ProgressPreference = $old
        if ([int]$resp.StatusCode -eq 204) {
            # The server is healthy and has nothing for this install right now
            # (a staged rollout that has not reached it, or a withdrawn
            # release). That is "no update", never a verification failure.
            $why = "" + $resp.Headers['x-orc-reason']
            $script:UpdateRejectReason = "no update offered right now"
            Log "Update server offers no update for this install$(if ($why) { " ($why)" })."
            return $null
        }
        $raw = $resp.Content
        # PowerShell 5.1 hands back a BYTE ARRAY, not a string, whenever the
        # response is not typed as text (an object/octet-stream Content-Type,
        # or none at all). Stringifying that yields "123 34 115..." and the
        # parse fails for reasons that look nothing like the actual cause.
        if ($raw -is [byte[]]) { $raw = [System.Text.Encoding]::UTF8.GetString($raw) }
    } catch {
        $script:UpdateRejectReason = "could not reach the update server"
        Log "Update manifest fetch failed: $_"
        return $null
    }
    $m = ConvertFrom-OrcSignedManifestText -Raw $raw -PublicKeyXml $PublicKeyXml -Source $url
    if (-not $m) { return $null }
    # The channel is inside the signed bytes, so a Worker (or anyone between
    # us and it) cannot serve a beta build to a stable install by replaying
    # the beta manifest at the stable URL.
    # Mandatory: a signed manifest that names no channel could be replayed at
    # any channel URL, so it is refused, never waved through.
    $mChannel = ""
    if ($m.PSObject.Properties['channel']) { $mChannel = ("" + $m.channel).Trim() }
    if (-not $mChannel) {
        $script:UpdateRejectReason = "manifest names no channel"
        Log "Update manifest at $url is signed without a channel. Refusing."
        return $null
    }
    if ($mChannel -cne $Channel) {
        $script:UpdateRejectReason = "manifest is for channel '$mChannel', not '$Channel'"
        Log "Update manifest at $url is signed for channel '$mChannel'. Refusing."
        return $null
    }
    # Freshness. A signed manifest past its expiresAt is an old
    # release list being replayed (or a release that is overdue); either way
    # it is not trusted as current. Manifests from before this carry no
    # expiresAt and are unaffected.
    if (-not (Test-OrcManifestFresh -Manifest $m)) {
        $script:UpdateRejectReason = "the update server's release list is out of date"
        Log "Update manifest at $url expired at $($m.expiresAt). Not trusting it as current."
        return $null
    }
    # The floor. A release can raise it (minVersion); from then on
    # no manifest for an older version is accepted here, so a replayed old
    # release list cannot hold this computer back below a security release.
    $floor = ""
    try { $st = Get-LauncherState; if ($st.PSObject.Properties['updateFloor']) { $floor = ("" + $st.updateFloor).Trim() } } catch { }
    if ($floor -and (Compare-OrcVersion $m.version $floor) -lt 0) {
        $script:UpdateRejectReason = "the update server offered version $($m.version), older than the minimum $floor"
        Log "Update manifest at $url is for $($m.version), below the recorded minimum $floor. Refusing."
        return $null
    }
    if ($m.PSObject.Properties['minVersion']) {
        $mv = ("" + $m.minVersion).Trim()
        if ($mv -and (Compare-OrcVersion $mv $m.version) -le 0 -and (-not $floor -or (Compare-OrcVersion $mv $floor) -gt 0)) {
            try { Set-LauncherStateValue -Name 'updateFloor' -Value $mv } catch { }
        }
    }
    return $m
}

function Test-OrcManifestFresh {
    <# False once a signed manifest's expiresAt has passed. #>
    param($Manifest, [datetime]$Now = [datetime]::UtcNow)
    if (-not $Manifest -or -not $Manifest.PSObject.Properties['expiresAt']) { return $true }
    $e = $Manifest.expiresAt
    if ($e -is [datetime]) { return ($Now.ToUniversalTime() -le $e.ToUniversalTime()) }
    $dt = [datetime]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [datetime]::TryParseExact(("" + $e), 'yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$dt)) {
        # Signed but unreadable: never trusted as current.
        return $false
    }
    return ($Now.ToUniversalTime() -le $dt)
}

function Get-OrcStagedManifest {
    <#
      The installer's staged release: <StagedDir>\manifest.json, the SIGNED
      payload manifest that CI wrote next to the zip. Verified by exactly the
      same code as a manifest fetched from the update server. Returns the
      manifest, or $null with $script:UpdateRejectReason set.
    #>
    param([Parameter(Mandatory)][string]$StagedDir, [AllowEmptyCollection()][string[]]$PublicKeyXml)
    $script:UpdateRejectReason = ""
    if (-not $PublicKeyXml -or $PublicKeyXml.Count -eq 0) {
        $script:UpdateRejectReason = "no release public key embedded in this build"
        return $null
    }
    $path = Join-Path $StagedDir "manifest.json"
    if (-not (Test-Path $path)) { $script:UpdateRejectReason = "no staged release"; return $null }
    $raw = $null
    try { $raw = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($path)) } catch {
        $script:UpdateRejectReason = "could not read the staged release"
        return $null
    }
    return (ConvertFrom-OrcSignedManifestText -Raw $raw -PublicKeyXml $PublicKeyXml -Source $path)
}

function ConvertFrom-OrcSignedManifestText {
    <#
      Parse and VERIFY a manifest envelope, from the network or from disk.
      One function for both, so the first install from the installer's staged
      zip cannot take a weaker path than an update. Returns the manifest or
      $null with $script:UpdateRejectReason set.
    #>
    param($Raw, [AllowEmptyCollection()][string[]]$PublicKeyXml, [string]$Source = "")
    $raw = $Raw
    $url = $Source
    # Skip anything before the opening brace. A UTF-8 BOM (which PowerShell's
    # `Set-Content -Encoding UTF8` prepends) makes ConvertFrom-Json fail with
    # "Invalid JSON primitive", and trimming U+FEFF is NOT enough: depending on
    # how the response body got decoded, those three bytes can arrive as the
    # mojibake "i>>?" instead of a single BOM character. Seeking to the first
    # '{' handles every variant, plus stray whitespace, in one line.
    $raw = "" + $raw
    $brace = $raw.IndexOf('{')
    if ($brace -gt 0) { $raw = $raw.Substring($brace) }
    $raw = $raw.Trim()
    $envelope = $null
    try { $envelope = $raw | ConvertFrom-Json } catch {
        $script:UpdateRejectReason = "update server returned malformed JSON"
        Log "Manifest parse failed: $_"
        return $null
    }
    if (-not (Test-OrcSignedManifest -Envelope $envelope -PublicKeyXml $PublicKeyXml)) {
        # Loud on purpose: this is either a broken release or an attack.
        $script:UpdateRejectReason = "SIGNATURE VERIFICATION FAILED"
        Log "SECURITY: update manifest at $url failed signature verification. Refusing."
        return $null
    }
    $m = $envelope.manifest
    if ($m.blocked) {
        $script:UpdateRejectReason = "this release was withdrawn"
        Log "Update manifest for $($m.version) is flagged blocked. Refusing."
        return $null
    }
    return $m
}

function Install-OrcRelease {
    <#
      Extract a VERIFIED payload into versions\<version>. Does not activate it.
      Extracts to a temp sibling and moves into place, so an interrupted
      extraction never leaves a half-populated version directory that a later
      run would mistake for a good install.
    #>
    param([string]$Root, [Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)][string]$ZipPath)
    $Root = Get-OrcInstallRoot $Root
    $target = Get-OrcVersionPath $Root $Manifest.version
    $staging = "$target.incoming"
    # ONE read-only handle for both the hash check and the extraction, opened
    # so nobody else can write the file while it is held. Checking
    # the file and then opening it again let it be swapped in between.
    $fs = $null
    try {
        $fs = [System.IO.File]::Open($ZipPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    } catch {
        Log "Refusing to install $($Manifest.version): cannot open the payload for exclusive reading: $_"
        return $false
    }
    try {
        $okSize = ($fs.Length -eq [long]$Manifest.size)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { $h = ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        if (-not $okSize -or $h -ne ("" + $Manifest.sha256).ToLowerInvariant()) {
            Log "Refusing to install $($Manifest.version): payload hash mismatch"
            return $false
        }
        [void]$fs.Seek(0, [System.IO.SeekOrigin]::Begin)
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Read, $true)
        try {
            # Same entry-path checks as ZipFile.ExtractToDirectory (it is the
            # same code): an entry that would land outside $staging throws.
            [System.IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $staging)
        } finally { $archive.Dispose() }
        if (-not (Test-Path (Join-Path $staging "server\dist\index.js"))) {
            Log "Refusing to install $($Manifest.version): payload has no server/dist/index.js"
            Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
            return $false
        }
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        $parent = Split-Path -Parent $target
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        [System.IO.Directory]::Move($staging, $target)
        Log "Installed version $($Manifest.version) to $target"
        return $true
    } catch {
        Log "Install of $($Manifest.version) failed: $_"
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
        return $false
    } finally {
        $fs.Dispose()
    }
}

function Remove-OrcOldVersions {
    # Keep the active version and the rollback target. Anything older is dead
    # weight (a payload with node_modules is ~100 MB).
    param([string]$Root, [string]$Keep1, [string]$Keep2)
    $Root = Get-OrcInstallRoot $Root
    $dir = Join-Path $Root "versions"
    if (-not (Test-Path $dir)) { return }
    foreach ($d in (Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue)) {
        if ($d.Name -eq $Keep1 -or $d.Name -eq $Keep2) { continue }
        try { Remove-Item $d.FullName -Recurse -Force; Log "Pruned old version $($d.Name)" } catch { }
    }
}

function Invoke-OrcRollback {
    <#
      Go back to the last version that booted healthy. Only ever ONE version
      back: migrations in db.ts run forward on boot, so older code runs against
      a newer schema. That is safe only because migrations are additive-only
      (new tables and columns, never a drop or a rename that old code still
      reads), and only for one hop.
    #>
    param([string]$Root)
    $Root = Get-OrcInstallRoot $Root
    $prev = $null
    try { $prev = (Get-LauncherState).previousVersion } catch { }
    if (-not $prev) { Log "Rollback requested but no previous healthy version is recorded"; return $null }
    if (-not (Test-Path (Get-OrcVersionPath $Root $prev))) {
        Log "Rollback target $prev is no longer on disk"
        return $null
    }
    Set-OrcActiveVersion -Root $Root -Version $prev
    Log "Rolled back to $prev"
    return $prev
}

function Get-OrcBundledNode {
    <#
      Phase 4. A payload may carry its own runtime\node.exe. When it does, that
      is the Node the app MUST run on: native modules (better-sqlite3, sharp)
      are compiled against one Node ABI, and the bundled runtime is the one
      they were built for. Falling back to whatever Node happens to be on PATH
      is exactly the ERR_DLOPEN_FAILED crash the ABI pin exists to prevent.
      Returns $null when the payload ships no runtime.
    #>
    param([string]$VersionPath)
    if (-not $VersionPath) { return $null }
    $exe = Join-Path $VersionPath "runtime\node.exe"
    if (Test-Path $exe) { return $exe }
    return $null
}

function Get-OrcNodePath {
    <# Bundled runtime first, PATH second. #>
    param([string]$VersionPath)
    $bundled = Get-OrcBundledNode -VersionPath $VersionPath
    if ($bundled) { return $bundled }
    return (Find-Exe "node")
}

function Get-OrcDownload {
    <# Download to a temp file. Returns the path, or $null. #>
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 600)
    $tmp = Join-Path $env:TEMP ("orc-payload-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".zip")
    try {
        $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
        $dlHeaders = @{}
        if (Get-Command Get-OrcUpdateHeaders -ErrorAction SilentlyContinue) { $dlHeaders = Get-OrcUpdateHeaders }
        Invoke-WebRequest -Uri $Url -Headers $dlHeaders -OutFile $tmp -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
        $ProgressPreference = $old
        return $tmp
    } catch {
        Log "Payload download failed: $_"
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        return $null
    }
}

function Invoke-OrcArtifactUpdate {
    <#
      The whole update, in the order that keeps a working install working:
      verify the manifest, THEN download, THEN verify the payload, THEN
      extract to a new directory, and only then flip current.txt. Every step
      before the flip is non-destructive, so a failure anywhere leaves the
      running version untouched.

      Returns a result object; the caller drives the UI and the restart.
    #>
    param(
        [string]$Root,
        [string]$BaseUrl = $script:UpdateBaseUrl,
        [AllowEmptyCollection()][string[]]$PublicKeyXml = $script:ReleasePublicKeys,
        [switch]$SkipDownload,     # tests: payload already staged by the caller
        [string]$Channel = "",
        # First install: the installer's staging folder (signed manifest.json
        # plus the zip it names) instead of the network. Everything after
        # "where do the manifest and the zip come from" is the same code.
        [string]$StagedDir = ""
    )
    $Root = Get-OrcInstallRoot $Root
    $result = @{ Updated = $false; Version = $null; Reason = ""; From = (Get-OrcActiveVersion $Root); Channel = $null }

    if ($StagedDir) {
        $manifest = Get-OrcStagedManifest -StagedDir $StagedDir -PublicKeyXml $PublicKeyXml
    } else {
        $manifest = Get-OrcUpdateManifest -BaseUrl $BaseUrl -PublicKeyXml $PublicKeyXml -Channel $Channel
    }
    if (-not $manifest) { $result.Reason = $script:UpdateRejectReason; return $result }
    $result.Channel = $manifest.channel

    $current = Get-OrcActiveVersion $Root
    $skip = Get-OrcUpdateSkipReason -Candidate $manifest.version -Current $current
    if ($skip) {
        $result.Reason = $skip
        if ($skip -ne "already up to date") { Log "Not installing: $skip" }
        return $result
    }

    # A payload built against a different Node ABI than the one that will run
    # it means native modules (better-sqlite3, sharp) fail to load at startup.
    # Catch it here rather than as ERR_DLOPEN_FAILED on the user's machine.
    # A payload that bundles its own runtime is exempt: it does not care what
    # Node this machine has, which is the entire point of bundling one.
    if ($manifest.nodeAbi -and -not $manifest.bundledRuntime) {
        $localAbi = 0
        try {
            $node = Find-Exe "node"
            if ($node) { $localAbi = [int](((& $node -p "process.versions.modules") -join "").Trim()) }
        } catch { }
        if ($localAbi -gt 0 -and [int]$manifest.nodeAbi -ne $localAbi) {
            $result.Reason = "release targets Node ABI $($manifest.nodeAbi), this machine runs $localAbi"
            Log "Refusing update: $($result.Reason)"
            return $result
        }
    }

    $zip = $null
    try {
        if ($StagedDir) {
            # The name comes from the signed manifest, but it must still be a
            # bare file name inside the staging folder, never a path.
            $name = "" + $manifest.file
            if (-not $name -or $name -ne [System.IO.Path]::GetFileName($name)) {
                $result.Reason = "staged manifest names an invalid file"
                return $result
            }
            $zip = Join-Path $StagedDir $name
        } elseif ($SkipDownload) {
            $zip = Join-Path $env:TEMP ([System.IO.Path]::GetFileName($manifest.file))
        } else {
            if (-not $manifest.url) { $result.Reason = "manifest has no download URL"; return $result }
            $zip = Get-OrcDownload -Url $manifest.url
            if (-not $zip) { $result.Reason = "download failed"; return $result }
        }

        if (-not (Test-OrcPayload -ZipPath $zip -Manifest $manifest)) {
            # The manifest is signed, so a hash mismatch means the bytes we got
            # are not the bytes that were signed.
            $result.Reason = "PAYLOAD HASH MISMATCH"
            Log "SECURITY: payload for $($manifest.version) does not match its signed hash. Discarding."
            return $result
        }

        if (-not (Install-OrcRelease -Root $Root -Manifest $manifest -ZipPath $zip)) {
            $result.Reason = "install failed"
            return $result
        }

        # Record the version we are leaving so a failed boot can roll back to
        # something known good, THEN activate.
        if ($current) { Set-LauncherStateValue -Name "previousVersion" -Value $current }
        Set-OrcActiveVersion -Root $Root -Version $manifest.version
        Remove-OrcOldVersions -Root $Root -Keep1 $manifest.version -Keep2 $current

        $result.Updated = $true
        $result.Version = $manifest.version
        $result.Reason = "updated to $($manifest.version)"
        return $result
    } finally {
        # Only a temp download is ours to delete. The staged zip belongs to the
        # installer (the uninstaller removes it).
        if ($zip -and -not $SkipDownload -and -not $StagedDir) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
    }
}

function Confirm-OrcHealthyBoot {
    <#
      Called after a version has booted. A version that never reports healthy
      is rolled back automatically; one that does becomes the next rollback
      target. Without this an update is a one-way door.
    #>
    param([string]$Root, [Parameter(Mandatory)][bool]$Healthy, [int]$Port = $ServerPort)
    $Root = Get-OrcInstallRoot $Root
    $active = Get-OrcActiveVersion $Root
    if (-not $active) { return $null }
    if ($Healthy) {
        Set-LauncherStateValue -Name "lastHealthyVersion" -Value $active
        # Clear the failure only when the version that booted is the failed
        # one or newer. The rollback target booting fine right after a failed
        # update proves nothing about the failed version, and clearing it
        # there would re-offer the crashing release on the very next check.
        $failed = ""
        try {
            $st = Get-LauncherState
            if ($st.PSObject.Properties['failedVersion']) { $failed = ("" + $st.failedVersion).Trim() }
        } catch { }
        if ($failed -and (Compare-OrcVersion $active $failed) -ge 0) {
            Set-LauncherStateValue -Name "failedVersion" -Value ""
        }
        return $active
    }
    Log "Version $active did not become healthy; attempting rollback"
    Set-LauncherStateValue -Name "failedVersion" -Value $active
    return (Invoke-OrcRollback -Root $Root)
}

# Point the launcher at the active version instead of the folder it was
# started from. Runs here, after the functions it calls are defined.
if ($script:ArtifactMode) {
    # An artifact payload contains only build output, so it is production mode
    # by definition: there is no src/ to run tsx or Vite against.
    $script:ProductionMode = $true
    $script:AppPort = $ServerPort
    $activeVersion = Get-OrcActiveVersion
    if ($activeVersion) {
        $activePath = Get-OrcVersionPath -Version $activeVersion
        if (Test-Path $activePath) {
            $RepoRoot  = $activePath
            $ServerDir = Join-Path $activePath "server"
            $ClientDir = Join-Path $activePath "client"
            Log "Artifact mode: running version $activeVersion from $activePath"
        } else {
            Log "Artifact mode: current.txt names $activeVersion but $activePath is missing"
        }
    } else {
        Log "Artifact mode: no version installed yet"
    }
}

# ══════════════════════════════════════════════════════════════
#  PROCESS OWNERSHIP (installed mode)
# ══════════════════════════════════════════════════════════════
# An installed copy must never kill a process it did not start. The only
# process it treats as its own is the one recorded in its own state file
# (<data root>\server-process.json) AND running an exe from inside its own app
# folder (<data root>\app, where the bundled node.exe lives). Both, or it is
# somebody else's.

function Get-OrcServerStateFile { return (Join-Path $StateDir "server-process.json") }

function Read-OrcServerProcess {
    param([string]$Path = (Get-OrcServerStateFile))
    try {
        if (Test-Path $Path) { return (Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
    } catch { }
    return $null
}

function Save-OrcServerProcess {
    param([int]$ProcessId, [string]$ExePath, [int]$Port, [string]$Version,
          [string]$Path = (Get-OrcServerStateFile), [string]$ClaudePin = "")
    $rec = [ordered]@{ pid = $ProcessId; exe = $ExePath; port = $Port; version = $Version;
                       startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    if ($ClaudePin) { $rec.claudePin = $ClaudePin }
    try {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($Path, ($rec | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    } catch { Log "Could not record the server process: $_" }
}

function Clear-OrcServerProcess {
    param([string]$Path = (Get-OrcServerStateFile))
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
}

function Test-OrcPathInside {
    param([string]$Path, [string]$Dir)
    if (-not $Path -or -not $Dir) { return $false }
    try {
        # Get-Item expands 8.3 short names (C:\Users\RUNNER~1) to the long
        # form that process paths use; GetFullPath alone would not.
        $p = if (Test-Path -LiteralPath $Path) { (Get-Item -LiteralPath $Path -Force).FullName } else { [System.IO.Path]::GetFullPath($Path) }
        $d = if (Test-Path -LiteralPath $Dir) { (Get-Item -LiteralPath $Dir -Force).FullName } else { [System.IO.Path]::GetFullPath($Dir) }
        $p = [System.IO.Path]::GetFullPath($p)
        $d = [System.IO.Path]::GetFullPath($d).TrimEnd('\') + '\'
        return $p.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Get-OrcProcessPath {
    param([int]$ProcessId)
    try {
        $p = Get-Process -Id $ProcessId -ErrorAction Stop
        if ($p.Path) { return $p.Path }
    } catch { return $null }
    try {
        $w = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if ($w.ExecutablePath) { return $w.ExecutablePath }
    } catch { }
    return $null
}

function Get-OrcProcessLabel {
    param([int]$ProcessId)
    $name = "unknown program"
    try { $name = (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName } catch { }
    return "$name (PID $ProcessId)"
}

function Test-OrcOwnedProcess {
    param([int]$ProcessId, [string]$AppDir = $script:ArtifactRoot, [string]$StatePath = (Get-OrcServerStateFile))
    if ($ProcessId -le 0) { return $false }
    $rec = Read-OrcServerProcess -Path $StatePath
    if (-not $rec -or -not $rec.pid) { return $false }
    if ([int]$rec.pid -ne $ProcessId) { return $false }
    $exe = Get-OrcProcessPath -ProcessId $ProcessId
    if (-not $exe) { return $false }
    return (Test-OrcPathInside -Path $exe -Dir $AppDir)
}

function Get-OrcPortListeners {
    param([int]$Port)
    $pids = @()
    try {
        $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                  ForEach-Object { [int]$_.OwningProcess } | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
    } catch { }
    return ,$pids
}

function Resolve-OrcServerPort {
    <#
      Pick the port for an installed copy. Returns @{ Port; Action; Message; OwnPids }:
        free      the preferred port is free
        own       our own server holds it (reuse it, or restart it)
        moved     a foreign program holds the preferred port, so a free port
                  nearby is used instead (default port only)
        conflict  a foreign program holds an explicitly requested port, or no
                  free port was found. Nothing was stopped.
      Never kills anything: that is the caller's decision, and only for "own".
    #>
    param([int]$Preferred, [bool]$Explicit, [string]$AppDir = $script:ArtifactRoot,
          [string]$StatePath = (Get-OrcServerStateFile), [int]$Span = 20)
    $last = if ($Explicit) { $Preferred } else { $Preferred + $Span - 1 }
    $firstForeign = $null
    for ($p = $Preferred; $p -le $last; $p++) {
        $holders = Get-OrcPortListeners -Port $p
        if ($holders.Count -eq 0) {
            if ($p -eq $Preferred) { return @{ Port = $p; Action = 'free'; Message = ""; OwnPids = @() } }
            $msg = "Port $Preferred is in use by $firstForeign, so OrcStrator is using port $p instead. Nothing was stopped."
            return @{ Port = $p; Action = 'moved'; Message = $msg; OwnPids = @() }
        }
        $foreign = @($holders | Where-Object { -not (Test-OrcOwnedProcess -ProcessId $_ -AppDir $AppDir -StatePath $StatePath) })
        if ($foreign.Count -eq 0) {
            return @{ Port = $p; Action = 'own'; Message = "OrcStrator is already running on port $p"; OwnPids = $holders }
        }
        $label = Get-OrcProcessLabel -ProcessId $foreign[0]
        if (-not $firstForeign) { $firstForeign = $label }
        Log "Port $p is held by $label, which OrcStrator did not start. Leaving it alone."
    }
    $how = if ($Explicit) { "Close that program, then start OrcStrator again." } else { "No free port was found between $Preferred and $last." }
    return @{ Port = $Preferred; Action = 'conflict'; OwnPids = @()
              Message = "Port $Preferred is in use by another program: $firstForeign. OrcStrator did not stop it. $how" }
}

function Stop-OrcOwnedServer {
    <# Stop ONLY processes that pass Test-OrcOwnedProcess, then wait for the port. #>
    param([int[]]$Pids, [int]$Port)
    foreach ($p in @($Pids)) {
        if (Test-OrcOwnedProcess -ProcessId $p) {
            Log "Stopping our own previous server (PID $p)"
            try { & taskkill /PID $p /T /F 2>$null | Out-Null } catch { }
        } else {
            Log "Not stopping PID ${p}: OrcStrator cannot prove it started it"
        }
    }
    for ($i = 0; $i -lt 20; $i++) {
        if ((Get-OrcPortListeners -Port $Port).Count -eq 0) { break }
        Invoke-UiPump
        Start-Sleep -Milliseconds 250
    }
}

# ══════════════════════════════════════════════════════════════
#  CLAUDE CLI
# ══════════════════════════════════════════════════════════════

# Anthropic's official native Windows installer (Claude Code setup docs).
# Installs claude.exe to %USERPROFILE%\.local\bin and needs no Node or npm.
$script:ClaudeNativeInstallCommand = 'irm https://claude.ai/install.ps1 | iex'

function Invoke-OrcHiddenProcess {
    <#
      Run a console program with no window, capture its output, give up after
      a timeout. Returns @{ ExitCode; Output }. ExitCode -1 = could not start
      or timed out (and was killed).
    #>
    param([Parameter(Mandatory)][string]$FilePath, [string]$Arguments = "", [int]$TimeoutSec = 30)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    try { $proc = [System.Diagnostics.Process]::Start($psi) } catch {
        Log "Could not start ${FilePath}: $_"
        return @{ ExitCode = -1; Output = "" }
    }
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    $deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
    while (-not $proc.HasExited) {
        if ([DateTime]::Now -gt $deadline) {
            try { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null } catch { }
            Log "Timed out after ${TimeoutSec}s: $FilePath $Arguments"
            return @{ ExitCode = -1; Output = "" }
        }
        Invoke-UiPump
        Start-Sleep -Milliseconds 150
    }
    $proc.WaitForExit()
    $text = ""
    try { $text = $outTask.Result + $errTask.Result } catch { }
    return @{ ExitCode = $proc.ExitCode; Output = $text }
}

function Find-OrcClaude {
    # The native installer's location. A claude.exe there is what OrcStrator
    # (or Anthropic's installer) put there, so it must carry Anthropic's
    # signature on EVERY launch, not only the one that installed it.
    # A claude the user installed some other way (npm) is theirs to trust.
    $native = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
    $c = Find-Exe "claude"
    # Judged by what the file IS, not where PATH says it is: any claude.exe or
    # claude.com (which Windows would run before a .exe) must carry
    # Anthropic's signature, whatever folder, junction, short name or \\?\
    # form it was found through. A script shim (claude.cmd / .ps1, what npm
    # installs) is the user's own install and is used as before.
    $refused = $null
    if ($c -and @('.exe', '.com') -contains [System.IO.Path]::GetExtension($c).ToLowerInvariant()) {
        $sigFound = Test-OrcClaudeSignature -Path $c
        if ($sigFound.Ok) { return $c }
        $script:ClaudeSignatureRefused = $sigFound.Why
        if (-not $script:ClaudeRefusedPath) { $script:ClaudeRefusedPath = $c }
        Log "SECURITY: the Claude CLI at $c is not signed by Anthropic ($($sigFound.Why)). Not using it."
        $refused = $c
        $c = $null
    }
    if ($c) { return $c }
    # It may not be on PATH yet in this process right after the install ran.
    $sameAsRefused = $false
    if ($refused) { try { $sameAsRefused = ((Get-Item -LiteralPath $refused -Force).FullName -ieq (Get-Item -LiteralPath $native -Force -ErrorAction Stop).FullName) } catch { } }
    if ((Test-Path $native) -and -not $sameAsRefused) {
        $sig = Test-OrcClaudeSignature -Path $native
        if ($sig.Ok) { return $native }
        $script:ClaudeSignatureRefused = $sig.Why
        if (-not $script:ClaudeRefusedPath) { $script:ClaudeRefusedPath = $native }
        Log "SECURITY: the Claude CLI at $native is not signed by Anthropic ($($sig.Why)). Not using it."
    }
    if ($script:ClaudeSignatureRefused) {
        # A claude the user installed another way (npm's script shims) is still usable.
        foreach ($shim in 'claude.cmd', 'claude.ps1') {
            $s = Find-Exe $shim
            if ($s) { return $s }
        }
    }
    return $null
}

function Get-OrcServerClaudePath {
    <#
      The app server spawns a claude.exe on its own (the first one on
      PATH, else %USERPROFILE%\.local\bin\claude.exe; never a .cmd shim). Work
      out that same file here and verify it, so the server can be pinned to it:
      its path when Anthropic signed it, else the marker (never a file), so
      the server never goes looking on its own: any PATH form this scan
      could miss (\\?\, \\.\) is then out of the server's reach too.
    #>
    $cands = @()
    # A claude.exe the user pointed OrcStrator at comes first, held to the
    # same rule. (A value that is not a file, like the marker this launcher
    # passed on before a Restart, is ignored.)
    # Absolute only: "C:\x", "\\server\x", "\\?\..." . Not "x", ".\x", "\x" or
    # "C:x", which depend on the current folder or drive, so they would name
    # a different file for the server, which starts in another folder.
    $absolute = '^([A-Za-z]:[\\/]|\\\\)'
    $override = "" + $env:ORCSTRATOR_CLAUDE_PATH
    if ($override -and ($override -ne $script:ClaudeRefusedMarker) -and $override -match $absolute) { $cands += $override }
    $firstRefusal = $true
    foreach ($d in (("" + $env:PATH) -split ';')) {
        $d = $d.Trim()
        if (-not $d) { continue }
        if ($d -notmatch $absolute) { continue }
        # Built as a string, the way the server builds it, so a \\?\ or \\.\
        # folder is checked instead of silently skipped.
        $cands += ($d.TrimEnd('\', '/') + '\claude.exe')
    }
    $cands += ($env:USERPROFILE + "\.local\bin\claude.exe")
    foreach ($cand in $cands) {
        if (-not (Test-Path -LiteralPath $cand -PathType Leaf)) { continue }
        # The file itself, through every junction and link, so a folder link
        # retargeted later cannot swap what the server runs. Only a plain
        # ".exe" path: without the extension Windows runs claude.com or
        # claude.exe beside it instead, and a ":" after the drive is a stream.
        $p = Get-OrcFinalPath -Path $cand
        if (-not $p -or -not (Test-OrcPinnablePath -Path $p)) { continue }
        $sig = Test-OrcClaudeSignature -Path $p
        if ($sig.Ok) { return $p }
        # Refused: keep looking, a signed copy further on is pinned instead.
        $script:ClaudeSignatureRefused = $sig.Why
        # The copy the server would have run is the one to name to the person.
        if ($firstRefusal) { $script:ClaudeRefusedPath = $p; $firstRefusal = $false }
        Log "SECURITY: the app would run $p, which is not signed by Anthropic ($($sig.Why)). Not letting it."
    }
    return $script:ClaudeRefusedMarker
}

function Get-OrcFinalPath {
    # The final path of a file (every junction, link and short name resolved),
    # or $null when it cannot be opened.
    param([string]$Path)
    try {
        if (-not ('OrcFinalPath' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class OrcFinalPath {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buf, uint len, uint flags);
    public static string Get(string path) {
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            var sb = new StringBuilder(2048);
            uint n = GetFinalPathNameByHandleW(fs.SafeFileHandle, sb, (uint)sb.Capacity, 0);
            if (n == 0 || n >= sb.Capacity) return null;
            return sb.ToString();
        }
    }
}
'@
        }
        $f = [OrcFinalPath]::Get($Path)
        if (-not $f) { return $null }
        if ($f.StartsWith('\\?\UNC\')) { return '\\' + $f.Substring(8) }
        if ($f.StartsWith('\\?\')) { return $f.Substring(4) }
        return $f
    } catch {
        Log "Could not resolve the real path of ${Path}, so it is not used: $($_.Exception.Message)"
        return $null
    }
}

function Test-OrcPinnablePath {
    # "C:\...\x.exe" or "\\server\share\...\x.exe": no stream ":" and nothing
    # after ".exe" (a trailing dot or space is dropped by Windows, not Node).
    param([string]$Path)
    if ($Path -notmatch '^([A-Za-z]:\\|\\\\[^\\?.])') { return $false }
    if ($Path.IndexOf(':', 2) -ge 0) { return $false }
    return ($Path -match '\.exe$')
}

# Never a file: "<" and ">" cannot appear in a Windows file name, so the
# server's "is this a file?" check always says no, whatever is on disk.
$script:ClaudeRefusedMarker = '<claude-refused>'

function Install-OrcClaudeNative {
    <#
      Install the Claude CLI with Anthropic's NATIVE installer (never npm -g:
      an installed OrcStrator has no Node or npm). Returns the claude path, or
      $null. -Command exists for tests; production always uses the official
      command.
    #>
    param([string]$Command = $script:ClaudeNativeInstallCommand, [int]$TimeoutSec = 600)
    Log "Installing the Claude CLI with Anthropic's native installer: $Command"
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Command))
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path $ps)) { $ps = "powershell.exe" }
    $r = Invoke-OrcHiddenProcess -FilePath $ps -Arguments "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" -TimeoutSec $TimeoutSec
    Log "Claude native installer exited with $($r.ExitCode)"
    if ($r.Output) { Log ($r.Output.Substring(0, [Math]::Min($r.Output.Length, 800))) }
    # Make the fresh install visible to this process without re-reading the
    # machine PATH (that would re-add tools an installed copy must not use).
    $bin = Join-Path $env:USERPROFILE ".local\bin"
    if ((Test-Path $bin) -and ($env:Path -notlike "*$bin*")) { $env:Path = "$bin;$($env:Path)" }
    $found = Find-OrcClaude
    # What the official installer just put on this computer must be
    # Anthropic's own signed claude.exe before OrcStrator ever runs it. (A
    # test stand-in command is not the official installer and is not held to
    # this.)
    # (A script shim PATH still finds first is the user's own install, not
    # what this installer wrote: not judged here, and never run by the server.)
    if ($found -and $Command -eq $script:ClaudeNativeInstallCommand -and
        @('.exe', '.com') -contains [System.IO.Path]::GetExtension($found).ToLowerInvariant()) {
        $sig = Test-OrcClaudeSignature -Path $found
        if (-not $sig.Ok) {
            $script:ClaudeSignatureRefused = $sig.Why
            if (-not $script:ClaudeRefusedPath) { $script:ClaudeRefusedPath = $found }
            Log "SECURITY: the Claude CLI at $found is not signed by Anthropic ($($sig.Why)). Not using it."
            return $null
        }
        Log "Claude CLI signature verified: $($sig.Why)"
    }
    return $found
}

function Test-OrcClaudeSignature {
    <#
      True only for a file with a valid Authenticode signature whose
      signer is Anthropic, PBC (the publisher of the official claude.exe).
      Returns @{ Ok; Why }.
    #>
    param([Parameter(Mandatory)][string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @{ Ok = $false; Why = "no such file" } }
        $s = Get-AuthenticodeSignature -LiteralPath $Path
        if ($s.Status -ne 'Valid') { return @{ Ok = $false; Why = "signature status $($s.Status)" } }
        $subject = "" + $s.SignerCertificate.Subject
        if ($subject -notmatch '(^|,\s*)O="?Anthropic, PBC"?(\s*,|$)') { return @{ Ok = $false; Why = "signed by someone else: $subject" } }
        return @{ Ok = $true; Why = "signed by Anthropic, PBC" }
    } catch {
        return @{ Ok = $false; Why = "signature check failed: $_" }
    }
}

function Resolve-OrcClaude {
    <#
      The Claude CLI to use: the one already installed, else (when allowed)
      a fresh install from Anthropic's native installer. Returns
      @{ Path; InstalledNow }. Path is $null when there is none.
    #>
    param([switch]$AllowInstall)
    $c = Find-OrcClaude
    if ($c) { return @{ Path = $c; InstalledNow = $false } }
    if (-not $AllowInstall) { Log "Claude CLI not found (install not requested)"; return @{ Path = $null; InstalledNow = $false } }
    if (Get-Command Set-StepActive -ErrorAction SilentlyContinue) { Set-StepActive 4 $(if ($script:ClaudeSignatureRefused) { "Downloading Claude AI again..." } else { "Installing Claude AI..." }) }
    $c = Install-OrcClaudeNative
    return @{ Path = $c; InstalledNow = [bool]$c }
}

function Get-OrcClaudeCredPath {
    if ($env:CLAUDE_CONFIG_DIR) { return (Join-Path $env:CLAUDE_CONFIG_DIR ".credentials.json") }
    return (Join-Path $env:USERPROFILE ".claude\.credentials.json")
}

function Test-OrcClaudeLoggedIn {
    <#
      Logged in when ANY of these holds, cheapest first:
        1. the credentials file has claudeAiOauth (a claude.ai login)
        2. ANTHROPIC_API_KEY is set (API-key users have no credentials file)
        3. `claude auth status` exits 0 (covers every other auth method the
           CLI supports; it exits 1 when logged out)
      Returns @{ LoggedIn; Method }.
    #>
    param([string]$ClaudeExe, [string]$CredPath = (Get-OrcClaudeCredPath),
          [string]$ApiKey = $env:ANTHROPIC_API_KEY, [int]$TimeoutSec = 20)
    if ($CredPath -and (Test-Path $CredPath)) {
        try {
            $creds = Get-Content $CredPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $creds.claudeAiOauth) { return @{ LoggedIn = $true; Method = 'oauth' } }
        } catch { Log "Could not parse $CredPath : $_" }
    }
    if ($ApiKey -and $ApiKey.Trim()) { return @{ LoggedIn = $true; Method = 'api_key' } }
    if ($ClaudeExe) {
        $r = Invoke-OrcHiddenProcess -FilePath $ClaudeExe -Arguments "auth status" -TimeoutSec $TimeoutSec
        if ($r.ExitCode -eq 0) { return @{ LoggedIn = $true; Method = 'auth_status' } }
    }
    return @{ LoggedIn = $false; Method = 'none' }
}

$script:ClaudeExe = $null
$script:ClaudeLoginTimeoutSec = 180
$script:ClaudeLoginIntro = "Your browser will open. Sign in there, then come back here. You have 3 minutes."

function Invoke-OrcClaudeLogin {
    <#
      Window only. Runs `claude auth login` and waits for it, up to 3 minutes.
      The CLI opens the sign-in page in the default browser itself (a
      PowerShell Start of the URL, independent of its own console), then
      waits for the browser to hand the result back on localhost. Its console
      starts MINIMIZED rather than hidden: nothing to look at in the normal
      case, but still reachable if the CLI ever falls back to asking for a
      pasted code. Returns @{ Auth; TimedOut }.
    #>
    param([Parameter(Mandatory)][string]$ClaudeExe, [int]$TimeoutSec = $script:ClaudeLoginTimeoutSec)
    $btnLogin.Visible = $false
    Set-StepActive 5 "Signing in to Claude..."
    Set-OrcStatus $script:ClaudeLoginIntro 'yellow'
    # A moment to read the instruction before the browser takes focus.
    for ($w = 0; $w -lt 12; $w++) { Invoke-UiPump; Start-Sleep -Milliseconds 200 }
    $timedOut = $false
    try {
        $loginProc = Start-Process -FilePath $ClaudeExe -ArgumentList "auth", "login" -WindowStyle Minimized -PassThru
        Log "Started claude auth login (PID $($loginProc.Id), minimized)"
        $deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
        while (-not $loginProc.HasExited -and [DateTime]::Now -lt $deadline) { Invoke-UiPump; Start-Sleep -Milliseconds 200 }
        if (-not $loginProc.HasExited) {
            $timedOut = $true
            Log "claude auth login did not finish within ${TimeoutSec}s; stopping it"
            try { & taskkill /PID $loginProc.Id /T /F 2>$null | Out-Null } catch { }
        } else {
            Log "claude auth login exited with $($loginProc.ExitCode)"
        }
    } catch { Log "Could not start claude auth login: $_" }
    $auth = Test-OrcClaudeLoggedIn -ClaudeExe $ClaudeExe
    # A sign-in that completed just as the clock ran out is a success.
    if ($auth.LoggedIn) { $timedOut = $false }
    return @{ Auth = $auth; TimedOut = $timedOut }
}

function Set-OrcSignInResult {
    <# Update the Sign-in row, the status line and the Log in button in place. #>
    param($Auth, [bool]$TimedOut = $false)
    if ($script:Headless) { return }
    if ($Auth -and $Auth.LoggedIn) {
        $btnLogin.Visible = $false
        Set-StepOk 5 "Signed in to Claude"
        if ($script:AppPort -and $btnOpen.Enabled) { Set-OrcStatus "OrcStrator is running!" 'green' }
        else { Set-OrcStatus "Signed in to Claude" 'green' }
        return
    }
    Set-StepFail 5 "Not signed in to Claude. Click Log in."
    $btnLogin.Visible = [bool]($script:ArtifactMode -and $script:ClaudeExe)
    if ($TimedOut) { Set-OrcStatus "Sign-in timed out. Click Log in to try again." 'red' }
}

# ══════════════════════════════════════════════════════════════
#  INSTALLED MODE LAUNCH (artifact mode, GUI and -Headless)
# ══════════════════════════════════════════════════════════════
# An installed copy never touches winget, git, npm, a system Node or the VS
# Build Tools: the payload is prebuilt and carries its own runtime\node.exe.
# The developer path (Run-Setup below) is unchanged and never reaches here.

function Start-OrcInstalledServer {
    param([string]$VersionPath, [string]$NodeExe, [int]$Port, [string]$DataRoot, [string]$LogPath, [string]$ClaudePath = "")
    $serverDir = Join-Path $VersionPath "server"
    # The server runs exactly the claude.exe the launcher verified:
    # ORCSTRATOR_CLAUDE_PATH pins it, and a value that is not a file means
    # "none", so the server never falls back to an unverified copy.
    # Passed through the inherited environment, not a cmd "set", so a "%" in
    # the path is never expanded by cmd.exe.
    if ($ClaudePath) { $env:ORCSTRATOR_CLAUDE_PATH = $ClaudePath }
    else { Remove-Item Env:\ORCSTRATOR_CLAUDE_PATH -ErrorAction SilentlyContinue }
    $cmd = "cd /d `"$serverDir`" && set `"NODE_ENV=production`" && set `"PORT=$Port`" && set `"ORCSTRATOR_DATA_DIR=$DataRoot`" && `"$NodeExe`" dist/index.js > `"$LogPath`" 2>&1"
    Wait-FileWritable -Path $LogPath -MaxTries 12 -DelayMs 300 | Out-Null
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -WindowStyle Hidden -PassThru
    $script:ServerPid = $proc.Id
    Log "Server started (hidden), PID $($proc.Id), port $Port, log $LogPath"
    if ($script:JobOk) {
        try { [OrcJob]::Assign($script:JobHandle, $proc.Id) | Out-Null } catch { Log "Server job-bind error: $_" }
    }
    return $proc
}

function Wait-OrcServerHealthy {
    param($Process, [int]$Port, [int]$TimeoutSec = 90)
    $deadline = [DateTime]::Now.AddSeconds($TimeoutSec)
    $n = 0
    while ([DateTime]::Now -lt $deadline) {
        if ($Process -and $Process.HasExited) {
            Log "Server process exited with code $($Process.ExitCode) before it became healthy"
            return $false
        }
        if (Test-ServerHealth $Port) { return $true }
        $n++
        if (($n % 10) -eq 0) { Set-StepActive 8 "Starting OrcStrator... ($([int]($n / 2))s)" }
        for ($w = 0; $w -lt 2; $w++) { Invoke-UiPump; Start-Sleep -Milliseconds 250 }
    }
    return $false
}

function Complete-OrcInstalledLaunch {
    param($Result)
    if ($Result.ok) {
        Write-Host "ORC_URL=$($Result.url)"
        Write-Host "ORC_PORT=$($Result.port)"
        Write-Host "ORC_VERSION=$($Result.version)"
    } elseif (-not $Result.error -and $script:HeadlessError) {
        $Result.error = $script:HeadlessError
    }
    if ($ResultFile) {
        try {
            $dir = Split-Path -Parent $ResultFile
            if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [System.IO.File]::WriteAllText($ResultFile, ($Result | ConvertTo-Json -Depth 6),
                (New-Object System.Text.UTF8Encoding($false)))
        } catch { Log "Could not write result file ${ResultFile}: $_" }
    }
    return $Result
}

function Invoke-OrcInstalledLaunch {
    $out = [ordered]@{
        ok = $false; mode = 'installed'; launcherRoot = $script:LauncherRoot; dataRoot = $StateDir
        launcherScript = $script:LauncherScript
        channel = $null; version = $null; port = $null; url = $null; serverPid = $null
        portAction = $null; staged = $null; update = $null; claude = $null; error = $null
    }
    Log "OrcStrator (installed) starting - $(Get-Date)"
    Log "Launcher: $($script:LauncherRoot)  Data: $StateDir  Script: $($script:LauncherScript)"
    if ($script:LauncherRootArgIgnored) { Log "Ignored -LauncherRoot '$LauncherRoot': not an installed app folder" }

    # Steps 0, 1, 3 and 7 exist for the developer path only. The window hides
    # them (Set-OrcInstalledLayout); headless output still lists them.
    Set-StepSkip 0 "System ready"
    Set-StepSkip 1 "Not needed"
    Set-StepSkip 3 "Not needed"

    # ── Step 6: install the staged release (first run or a newer installer) ──
    Set-StepActive 6 "Installing OrcStrator..."
    $staged = Join-Path $script:LauncherRoot "staging"
    $stagedRefused = $false
    if (Test-Path (Join-Path $staged "manifest.json")) {
        $s = Invoke-OrcArtifactUpdate -StagedDir $staged
        $out.staged = [ordered]@{ updated = [bool]$s.Updated; version = $s.Version; reason = $s.Reason }
        if ($s.Updated) {
            Log "Installed the bundled release $($s.Version) (signature and sha256 verified)"
            $st = Get-LauncherState
            $hasChannel = $st.PSObject.Properties['updateChannel'] -and $st.updateChannel
            if (-not $hasChannel -and (@('stable', 'beta') -contains $s.Channel)) {
                Set-LauncherStateValue -Name "updateChannel" -Value $s.Channel
            }
        } elseif ($s.Reason -match 'SIGNATURE|HASH|invalid|public key') {
            $stagedRefused = $true
            Log "SECURITY: the bundled release was REFUSED ($($s.Reason)). Nothing from it was installed."
        } else {
            Log "Bundled release not installed: $($s.Reason)"
        }
    }
    $out.channel = Get-OrcUpdateChannel

    if (-not (Get-OrcActiveVersion)) {
        if ($stagedRefused) {
            Set-StepFail 6 "Security check failed"
            $out.error = "The OrcStrator files in this installer failed their security check ($($out.staged.reason)) and were not installed. Download the installer again from the official link."
            Show-Error "Security Check Failed" "The OrcStrator files in this installer did not pass their security check, so nothing was installed." `
                -Action "Download the installer again from $($script:DownloadUrl)" -Details $out.error
            return (Complete-OrcInstalledLaunch $out)
        }
        Set-StepActive 6 "Downloading OrcStrator..."
        $n = Invoke-OrcArtifactUpdate -Channel $out.channel
        if (-not $n.Updated) {
            Set-StepFail 6 "Download failed"
            $out.error = "Could not install OrcStrator: $($n.Reason)"
            Show-Error "Download Failed" "OrcStrator could not be downloaded." `
                -Action "Check the internet connection, then click Restart to try again." -Details $out.error
            return (Complete-OrcInstalledLaunch $out)
        }
    }

    # ── Update check (headless; the window uses the click-to-update banner) ──
    if ($script:Headless -and -not $SkipUpdates) {
        if ($AutoUpdate) {
            $u = Invoke-OrcArtifactUpdate -Channel $out.channel
            $out.update = [ordered]@{ applied = [bool]$u.Updated; from = $u.From; version = $u.Version; reason = $u.Reason }
            Log "Update check ($($out.channel)): $($u.Reason)"
        } else {
            $m = Get-OrcUpdateManifest -BaseUrl $script:UpdateBaseUrl -PublicKeyXml $script:ReleasePublicKeys -Channel $out.channel
            $cur = Get-OrcActiveVersion
            $skip = if ($m) { Get-OrcUpdateSkipReason -Candidate $m.version -Current $cur } else { "" }
            $avail = [bool]($m -and -not $skip)
            $reason = if ($m) { $skip } else { $script:UpdateRejectReason }
            $out.update = [ordered]@{ applied = $false; available = $avail; version = $(if ($m) { $m.version }); reason = $reason }
            Log "Update check ($($out.channel)): $(if ($avail) { "version $($m.version) available" } else { $reason })"
        }
    }
    Set-StepOk 6 "OrcStrator $(Get-OrcActiveVersion) installed"

    # ── Step 2: the bundled runtime ──
    $v = Get-OrcActiveVersion
    $vp = Get-OrcVersionPath -Version $v
    $node = Get-OrcBundledNode -VersionPath $vp
    if ($node) { Set-StepOk 2 "Ready" }
    else {
        $node = Find-Exe "node"
        if ($node) { Set-StepOk 2 "Ready" }
        else {
            Set-StepFail 2 "OrcStrator files are incomplete"
            Set-StepFail 6 "OrcStrator files are incomplete"
            $out.error = "This OrcStrator version ($v) has no bundled runtime and no Node.js was found."
            Show-Error "Start Failed" "This copy of OrcStrator is incomplete." `
                -Action "Download the installer again from $($script:DownloadUrl)" -Details $out.error
            return (Complete-OrcInstalledLaunch $out)
        }
    }

    # ── Steps 4 and 5: Claude CLI and login (never fatal) ──
    Set-StepActive 4 "Checking Claude AI..."
    $allowClaudeInstall = (-not $script:Headless -or $InstallClaude)
    $shimInstallFailed = $false
    $cr = Resolve-OrcClaude -AllowInstall:$allowClaudeInstall
    # Only npm's script shim (claude.cmd / .ps1): the app server can never run
    # that, so chats could not work however often Restart is clicked. Install
    # Anthropic's own Claude AI; the server-pin scan below verifies what landed.
    if ($cr.Path -and $allowClaudeInstall -and -not $script:ClaudeSignatureRefused -and
        @('.cmd', '.ps1') -contains [System.IO.Path]::GetExtension($cr.Path).ToLowerInvariant() -and
        ((Get-OrcServerClaudePath) -eq $script:ClaudeRefusedMarker) -and -not $script:ClaudeSignatureRefused) {
        Log "Only a script shim ($($cr.Path)) was found; the app needs claude.exe. Installing Claude AI."
        Set-StepActive 4 "Installing Claude AI..."
        # The same wait as a first install: the download is about 250 MB, and a
        # shorter limit would cut a slow line off every time, for ever.
        [void](Install-OrcClaudeNative)
        # Install-OrcClaudeNative judges whatever PATH finds first, which may be
        # the shim again; the server-pin scan decides about the real claude.exe.
        $script:ClaudeSignatureRefused = $null
        $script:ClaudeRefusedPath = $null
        $shimInstallOk = ((Get-OrcServerClaudePath) -ne $script:ClaudeRefusedMarker)
        $cr.InstalledNow = $shimInstallOk
        $shimInstallFailed = -not $shimInstallOk
    }
    $claude = if ($shimInstallFailed) { $null } else { $cr.Path }
    $script:ClaudeExe = $claude
    $installedNow = $cr.InstalledNow
    if ($shimInstallFailed) { Set-StepFail 4 $(if ($script:ClaudeSignatureRefused) { "Claude AI could not be verified as the genuine program, so it was not used" } else { "Claude AI could not be installed (needed to run chats)" }) }
    elseif ($claude) { Set-StepOk 4 $(if ($installedNow) { "Claude AI installed" } else { "Claude AI ready" }) }
    elseif ($script:ClaudeSignatureRefused) { Set-StepFail 4 "Claude AI could not be verified as the genuine program, so it was not used" }
    else { Set-StepFail 4 "Claude AI not installed (needed to run chats)" }

    Set-StepActive 5 "Checking sign-in..."
    $auth = Test-OrcClaudeLoggedIn -ClaudeExe $claude
    $loginTimedOut = $false
    if (-not $auth.LoggedIn -and $claude -and -not $script:Headless) {
        $lr = Invoke-OrcClaudeLogin -ClaudeExe $claude
        $auth = $lr.Auth
        $loginTimedOut = [bool]$lr.TimedOut
    }
    $out.claude = [ordered]@{ found = [bool]$claude; installedNow = $installedNow; loggedIn = [bool]$auth.LoggedIn; method = $auth.Method }
    if ($script:Headless) {
        if ($auth.LoggedIn) { Set-StepOk 5 "Signed in to Claude" } else { Set-StepFail 5 "Not signed in to Claude" }
    } elseif ($claude) {
        Set-OrcSignInResult -Auth $auth -TimedOut $loginTimedOut
    } else {
        Set-StepSkip 5 "Skipped: Claude AI not available"
    }

    Set-StepOk 7 "App prepared"

    # ── Step 8: port and server ──
    $explicit = ($Port -gt 0) -or ("$env:ORC_PORT" -match '^\d+$')
    $requested = if ($Port -gt 0) { $Port } elseif ("$env:ORC_PORT" -match '^\d+$') { [int]$env:ORC_PORT } else { $ServerPort }
    Set-StepActive 8 "Starting OrcStrator..."
    $pr = Resolve-OrcServerPort -Preferred $requested -Explicit $explicit
    $out.portAction = $pr.Action
    if ($pr.Action -eq 'conflict') {
        Set-StepFail 8 "Port $requested is in use by another program"
        $out.error = $pr.Message
        $act = if ($explicit) { "Close the other program using port $requested and click Restart." } else { "Restart the computer, then open OrcStrator again." }
        Show-Error "Port In Use" "Another program is using port $requested, which OrcStrator needs." -Action $act -Details $pr.Message
        return (Complete-OrcInstalledLaunch $out)
    }
    if ($pr.Action -eq 'moved') { Log $pr.Message; Set-OrcStatus $pr.Message 'yellow' }
    $p = $pr.Port

    # The claude.exe the server may run, worked out once. A server
    # we started earlier is reused only if it was pinned to the same file.
    $serverClaude = Get-OrcServerClaudePath
    $healthy = $false
    if ($pr.Action -eq 'own') {
        $rec = Read-OrcServerProcess
        if ((Test-ServerHealth $p) -and $rec -and $rec.version -eq $v -and ("$($rec.claudePin)" -eq $serverClaude)) {
            Log "Reusing our own healthy server on port $p (PID $($rec.pid), version $v)"
            $out.serverPid = [int]$rec.pid
            $healthy = $true
        } else {
            Stop-OrcOwnedServer -Pids $pr.OwnPids -Port $p
            Clear-OrcServerProcess
        }
    }

    for ($attempt = 1; (-not $healthy) -and $attempt -le 2; $attempt++) {
        $v = Get-OrcActiveVersion
        $vp = Get-OrcVersionPath -Version $v
        $node = Get-OrcNodePath -VersionPath $vp
        Log "Booting version $v on port $p with $node"
        $proc = Start-OrcInstalledServer -VersionPath $vp -NodeExe $node -Port $p -DataRoot $StateDir -LogPath $ServerLog -ClaudePath $serverClaude
        if (Wait-OrcServerHealthy -Process $proc -Port $p -TimeoutSec 90) {
            $healthy = $true
            $listener = $null
            $nodeLong = try { (Get-Item -LiteralPath $node -Force).FullName } catch { $node }
            foreach ($lp in (Get-OrcPortListeners -Port $p)) {
                $exe = Get-OrcProcessPath -ProcessId $lp
                if ($exe -and ([System.IO.Path]::GetFullPath($exe) -ieq [System.IO.Path]::GetFullPath($nodeLong))) { $listener = $lp; break }
            }
            if ($listener) {
                Save-OrcServerProcess -ProcessId $listener -ExePath $node -Port $p -Version $v -ClaudePin $serverClaude
                $out.serverPid = $listener
            } else {
                Log "Could not match the listener on port $p to $node; it will not be treated as ours later"
                $out.serverPid = $proc.Id
            }
            Confirm-OrcHealthyBoot -Healthy $true | Out-Null
            break
        }
        # This boot failed. The cmd.exe and its node child are ours: we just started them.
        try { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null } catch { }
        $back = Confirm-OrcHealthyBoot -Healthy $false
        if (-not $back) { break }
        Log "Version $v failed to boot; rolled back to $back and retrying"
    }

    if (-not $healthy) {
        Set-StepFail 8 "OrcStrator could not start"
        $out.error = "The OrcStrator server did not become healthy on port $p. Server log: $ServerLog"
        Show-Error "Start Failed" "OrcStrator could not start." -Action "Click Restart to try again." -Details $out.error -DetailLog $ServerLog
        return (Complete-OrcInstalledLaunch $out)
    }

    $script:AppPort = $p
    $out.ok = $true
    $out.version = Get-OrcActiveVersion
    $out.port = $p
    $out.url = "http://localhost:$p"
    Set-StepOk 8 "OrcStrator is running"
    Set-StepOk 9 $(if ($script:Headless) { "Ready" } else { "Ready. OrcStrator opened in your browser." })
    Log "OrcStrator $($out.version) is running at $($out.url)"

    if (-not $script:Headless) {
        if ((-not $claude) -or ($serverClaude -eq $script:ClaudeRefusedMarker)) {
            # Chats cannot run without Claude AI: never a green "running!" here.
            # One short line: the status label is a single fixed-width row.
            $why = if ($script:ClaudeSignatureRefused) { "Claude AI could not be verified. Click Restart." } else { "Chats need Claude AI. Click Restart to install it." }
            # Restart alone cannot fix a copy that is still there, so the
            # second time in a row the person is told which file to delete.
            # The dialog comes before the browser opens (else it hides behind
            # it) and before the status line (it writes that line too).
            $strike = Join-Path $StateDir "claude-refused.txt"
            if ($script:ClaudeSignatureRefused) {
                $bad = if ($script:ClaudeRefusedPath) { $script:ClaudeRefusedPath } else { Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
                if (Test-Path -LiteralPath $strike) {
                    Show-Error "Claude AI Could Not Be Verified" "OrcStrator could not confirm that Claude AI on this computer is the genuine program from Anthropic, so it will not use it and chats will not work." -Action "Delete this file, then click Restart:`r`n$bad" -Details "Refused: $bad ($($script:ClaudeSignatureRefused))"
                    $why = "Claude AI not verified. Delete the file shown, then Restart."
                }
                try { [System.IO.File]::WriteAllText($strike, $bad) } catch { }
            } else {
                Remove-Item -LiteralPath $strike -Force -ErrorAction SilentlyContinue
            }
            Set-OrcStatus "OrcStrator is running. $why" 'yellow'
            Start-Process $out.url
        } elseif ($claude -and -not $auth.LoggedIn) {
            Remove-Item -LiteralPath (Join-Path $StateDir "claude-refused.txt") -Force -ErrorAction SilentlyContinue
            Start-Process $out.url
            Set-OrcStatus "OrcStrator is running. Click Log in to sign in to Claude." 'yellow'
        } else {
            Remove-Item -LiteralPath (Join-Path $StateDir "claude-refused.txt") -Force -ErrorAction SilentlyContinue
            Start-Process $out.url
            Set-OrcStatus "OrcStrator is running!" 'green'
        }
        $btnOpen.Enabled = $true
        $btnOpen.FlatAppearance.BorderColor = $script:Green
        $btnOpen.ForeColor = $script:Green
        $form.Refresh()
        if (-not $SkipUpdates) { Check-ForUpdates }
    }
    return (Complete-OrcInstalledLaunch $out)
}


function Run-Setup {
    # An installed copy takes its own, much shorter path: no winget, git,
    # npm, system Node or build tools. Everything below is the developer path.
    if ($script:ArtifactMode) { Invoke-OrcInstalledLaunch | Out-Null; return }

    $needsRestart = $false
    Log "OrcStrator setup started - $(Get-Date)"
    Log "Repo root: $RepoRoot"
    # A source build shows no update banner at all, not even "Checking...".
    if (-not (Test-OrcGitAutoUpdate -Root $RepoRoot)) { Hide-OrcUpdateBanner }

    # ── Post-update banner ────────────────────────────────────
    # If the previous launcher instance pulled an update and re-exec'd us,
    # show the new version on first paint, then clear the marker.
    $state = Get-LauncherState
    if ($state.PSObject.Properties["updatedToSha"] -and $state.updatedToSha) {
        $script:UpdateTitle = "Updated to $($state.updatedToSha) " + [char]0x2713
        $script:UpdateSub = "Running the latest version."
        $btnUpdate.ForeColor = $script:Green
        $btnUpdate.FlatAppearance.BorderColor = $script:Green
        $btnUpdate.Invalidate()
        Log "Relaunched after update - now at $($state.updatedToSha)"
        Set-LauncherStateValue -Name "updatedToSha" -Value ""
    }

    # ── Step 0: System requirements ──────────────────────────────
    # NOTE: steps 0-4 only use Find-Exe (Get-Command) probes - instant. winget
    # itself is never invoked unless a tool is actually missing, so a healthy
    # machine reaches the launch phase in a few seconds with no slow re-probes.
    Set-StepActive 0 "Checking system requirements..."
    $winget = Find-Exe "winget"
    if ($winget) {
        Log "winget found: $winget"
        Set-StepOk 0 "System ready"
    } else {
        Set-StepFail 0 "Missing requirements"
        Show-Error "System Requirements" "Your system is missing a component called 'App Installer'.`n`nOpen the Microsoft Store, search for 'App Installer', and install it.`nThen run OrcStrator again."
        return
    }

    # ── Step 1: Version control (Git) ─────────────────────────
    Set-StepActive 1 "Checking version control..."
    $git = Find-Exe "git"
    if ($git) {
        try { $ver = (& $git --version 2>&1) -join " " } catch { $ver = "" }
        Log "Git: $ver"
        Set-StepOk 1 "Version control ready"
    } else {
        Set-StepActive 1 "Installing version control..."
        Log "Git not found, installing..."
        $r = Run-Cmd $winget "install Git.Git --accept-source-agreements --accept-package-agreements" -TimeoutSec 300
        Refresh-EnvPath
        $git = Find-Exe "git"
        if ($git) {
            Set-StepOk 1 "Version control installed"
            $needsRestart = $true
        } else {
            Set-StepFail 1 "Could not install"
            Show-Error "Installation Failed" "Could not install version control automatically.`nPlease visit https://git-scm.com to install it manually, then try again."
            return
        }
    }

    # ── Step 2: App engine (Node.js) ──────────────────────────
    Set-StepActive 2 "Checking app engine..."
    $node = Find-Exe "node"
    $npm  = Find-Exe "npm.cmd"
    if (-not $npm) { $npm = Find-Exe "npm" }
    if ($node -and $npm) {
        try { $nodeVer = (& $node -v 2>&1) -join " " } catch { $nodeVer = "" }
        Log "Node $nodeVer"
        Set-StepOk 2 "App engine ready"
    } else {
        # Phase 4: a payload that bundles its own runtime needs no system Node,
        # so do not drag the user through a winget install they will never use.
        if ($script:ArtifactMode -and (Get-OrcBundledNode -VersionPath $RepoRoot)) {
            Log "Artifact mode with a bundled runtime: skipping Node install"
            Set-StepOk 2 "App engine bundled"
        } else {
        Set-StepActive 2 "Installing app engine..."
        Log "Node/npm not found, installing..."
        $r = Run-Cmd $winget "install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements" -TimeoutSec 300
        if ($r.ExitCode -ne 0) {
            $r = Run-Cmd $winget "install OpenJS.NodeJS.22 --accept-source-agreements --accept-package-agreements" -TimeoutSec 300
        }
        Refresh-EnvPath
        $node = Find-Exe "node"
        $npm  = Find-Exe "npm"
        if ($node -and $npm) {
            Set-StepOk 2 "App engine installed"
            $needsRestart = $true
        } else {
            Set-StepFail 2 "Could not install"
            Show-Error "Installation Failed" "Could not install the app engine automatically.`nPlease visit https://nodejs.org to install it manually, then try again."
            return
        }
        }   # end system-Node install
    }

    # ── Step 3: C++ Build Tools ────────────────────────────────
    Set-StepActive 3 "Checking build tools..."
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
        Set-StepOk 3 "Build tools ready"
    } else {
        Set-StepActive 3 "Installing build tools... (this may take a few minutes)"
        Log "C++ Build Tools not found, installing..."
        $r = Run-Cmd $winget 'install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' -TimeoutSec 600
        if ($r.ExitCode -eq 0) {
            Set-StepOk 3 "Build tools installed (restart recommended)"
            Log "C++ Build Tools installed - restart may be needed"
            $needsRestart = $true
        } else {
            # Not fatal - try to continue, npm install will fail if truly needed
            Set-StepFail 3 "Could not install build tools"
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
            $lblStatus.Text = "New components were installed. Please close and re-open OrcStrator."
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
    Set-StepActive 4 "Checking Claude AI..."
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
        Set-StepOk 4 "Claude AI ready"
    } else {
        Set-StepActive 4 "Installing Claude AI..."
        Log "Claude CLI not found, installing with Anthropic's native installer..."
        $claude = Install-OrcClaudeNative
        Refresh-EnvPath
        # A refused (unsigned) claude.exe must not be picked up again by a
        # plain PATH lookup.
        if (-not $claude -and -not $script:ClaudeSignatureRefused) { $claude = Find-OrcClaude }
        if (-not $claude -and -not $script:ClaudeSignatureRefused) { $claude = Find-Exe "claude.cmd" }
        if ($claude) {
            Set-StepOk 4 "Claude AI installed"
        } elseif ($script:ClaudeSignatureRefused) {
            Set-StepFail 4 "Could not verify Claude AI"
            Show-Error "Claude AI Could Not Be Verified" "OrcStrator installed Claude AI but could not confirm it is the genuine program from Anthropic, so it will not use it.`nOpen OrcStrator again to download it fresh. If this happens twice, delete this file first: $(Join-Path $env:USERPROFILE '.local\bin\claude.exe')"
            return
        } else {
            Set-StepFail 4 "Could not install"
            Show-Error "Claude AI Installation Failed" "Could not install Claude AI automatically.`nPlease try again or ask for help."
            return
        }
    }

    # NOTE: OrcStrator v2 spawns the native claude binary directly (no .cmd shim needed).
    # We intentionally do NOT create a claude.cmd wrapper here - the native installer
    # provides its own shim and overwriting it can break future updates. If `claude`
    # resolves to an npm-global path, warn the user that they should switch to the
    # native installer (irm https://claude.ai/install.ps1 | iex), but don't block.
    $claudeResolved = (Get-Command claude -ErrorAction SilentlyContinue).Source
    if ($claudeResolved) {
        $isNpmGlobal = ($claudeResolved -like "*\npm\*") -or ($claudeResolved -like "*node_modules*")
        $isNative    = ($claudeResolved -like "*\.local\bin\*") -or ($claudeResolved -like "*Claude\bin*")
        if ($isNpmGlobal -and -not $isNative) {
            Log "WARNING: claude resolves to an npm-global install ($claudeResolved)."
            Log "WARNING: OrcStrator works best with the native installer."
            Log "WARNING: Run this in a new PowerShell window to switch:"
            Log "WARNING:   irm https://claude.ai/install.ps1 | iex"
        } else {
            Log "claude binary location: $claudeResolved"
        }
    }

    # ── Step 5: Claude Auth ────────────────────────────────────
    Set-StepActive 5 "Checking account..."
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
    if (-not $isAuthed) {
        # API-key users (and any other auth method the CLI supports) have no
        # claudeAiOauth entry, but they are logged in all the same.
        $alt = Test-OrcClaudeLoggedIn -ClaudeExe $claude
        if ($alt.LoggedIn) { $isAuthed = $true; Log "Claude is authenticated ($($alt.Method))" }
    }
    if ($isAuthed) {
        Log "Claude is authenticated (credentials found)"
        Set-StepOk 5 "Logged in"
    } else {
        Set-StepActive 5 "Please log in (browser will open)..."
        Log "Claude not authenticated, prompting login"
        $lblStatus.Text = "A browser window will open - please log in to your account"
        $lblStatus.ForeColor = $Yellow
        $form.Refresh()
        Invoke-UiPump

        # Launch login in a visible window so user can interact
        $loginProc = Start-Process -FilePath $claude -ArgumentList "login" -PassThru
        # Poll until login finishes, keeping UI alive
        $loginDeadline = [DateTime]::Now.AddSeconds(120)
        while (-not $loginProc.HasExited -and [DateTime]::Now -lt $loginDeadline) {
            Invoke-UiPump
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
            Set-StepOk 5 "Logged in"
        } else {
            Set-StepFail 5 "Not logged in (you can log in later)"
            Log "Auth failed - continuing anyway"
            # Don't block - user can login later
        }
    }

    # ── Step 6: Repository + npm install ───────────────────────
    Set-StepActive 6 "Downloading packages..."

    # Artifact mode replaces clone-and-pull entirely: the payload IS the app.
    # A first run with nothing installed bootstraps by fetching the channel.
    if ($script:ArtifactMode) {
        if (-not (Get-OrcActiveVersion)) {
            Set-StepActive 6 "Downloading OrcStrator..."
            $res = Invoke-OrcArtifactUpdate
            if (-not $res.Updated) {
                Set-StepFail 6 "Download failed"
                Show-Error "Download Failed" "Could not install OrcStrator.`n$($res.Reason)`n`nLog: $LogFile" -DetailLog $LogFile
                return
            }
            $v = $res.Version
            $RepoRoot  = Get-OrcVersionPath -Version $v
            $ServerDir = Join-Path $RepoRoot "server"
            $ClientDir = Join-Path $RepoRoot "client"
            Log "Bootstrapped artifact version $v at $RepoRoot"
        }
    }

    # Check if we're in a valid repo
    $hasRepo = (Test-Path (Join-Path $RepoRoot "package.json")) -and (Test-Path $ServerDir)
    if ((-not $hasRepo) -and (-not $script:ArtifactMode)) {
        Set-StepActive 6 "Downloading OrcStrator..."
        Log "Repository not found at $RepoRoot, cloning..."
        $cloneTarget = Join-Path (Split-Path $RepoRoot) "orcstrator-v2"
        $repoUrl = Resolve-OrcRepoUrl -Git $git -Root $RepoRoot
        if (-not $repoUrl) {
            Log "No repository URL: no .git origin at $RepoRoot and ORC_REPO_URL is unset"
            Set-StepFail 6 "No repository to download from"
            Show-Error "Repository Not Set" "OrcStrator could not find its source repository.`n`nDevelopers: set the ORC_REPO_URL environment variable to the repository URL, or run the launcher from inside a git checkout. See 'Build from source' in README.md.`n`nLog: $LogFile"
            return
        }
        $cloneArgs = "clone $repoUrl `"$cloneTarget`""
        $partialClone = $false
        $r = Invoke-GitRetry $git $cloneArgs -TimeoutSec 120

        if ($r.AuthFailed) {
            # Repository wants sign-in: a first install on a new machine has no stored
            # GitHub credentials yet. Do the sign-in in a visible window and
            # retry the clone once, rather than blaming the network.
            Set-StepActive 6 "Waiting for GitHub sign-in..."
            $lblStatus.Text = "Sign in to GitHub in the window that just opened"
            $lblStatus.ForeColor = $script:Yellow
            $form.Refresh()
            Invoke-UiPump
            Invoke-GitHubSignIn -Git $git -GitArgs $cloneArgs | Out-Null

            $partialClone = $false
            if (Test-Path (Join-Path $cloneTarget "package.json")) {
                # The interactive run completed the clone itself
                $r = @{ ExitCode = 0; Output = ""; Error = ""; AuthFailed = $false }
            } elseif (Test-Path $cloneTarget) {
                # A half-finished clone is sitting there. Never delete a user
                # directory automatically - name it and let them clear it.
                Log "Partial clone left at $cloneTarget; not retrying"
                $partialClone = $true
                $r = @{ ExitCode = 1; Output = ""; Error = "partial clone"; AuthFailed = $false }
            } else {
                $r = Invoke-GitRetry $git $cloneArgs -TimeoutSec 120
            }
        }

        if ($r.ExitCode -ne 0) {
            Set-StepFail 6 "Download failed"
            if ($partialClone) {
                Show-Error "Download Incomplete" "The download did not finish.`n`nDelete this folder and re-open OrcStrator:`n$cloneTarget`n`nLog: $LogFile"
            } elseif ($r.AuthFailed) {
                Show-Error "GitHub Access Required" "OrcStrator could not access its source repository.`n`nSign in with a GitHub account that has been granted access, then re-open OrcStrator.`n`nLog: $LogFile"
            } else {
                Show-Error "Download Failed" "Could not download OrcStrator.`nPlease check your internet connection and try again."
            }
            return
        }
        # Update paths
        $script:RepoRoot = $cloneTarget
        $script:ServerDir = Join-Path $cloneTarget "server"
        $script:ClientDir = Join-Path $cloneTarget "client"
    }

    # Git pull. Skipped in artifact mode (RepoRoot is an extracted payload) and
    # for any copy with no .git, e.g. a "Download ZIP" from GitHub. Without the
    # .git test, Invoke-GitRetry burns three attempts and two 5s backoffs on
    # "fatal: not a git repository" at every single launch.
    $isGitCheckout = Test-Path (Join-Path $RepoRoot ".git")
    if ((-not $SkipUpdates) -and (-not $script:ArtifactMode) -and (-not $isGitCheckout)) {
        Log "Not a git checkout: skipping the update pull (this copy cannot self-update)"
    }
    # A source build (no official-release config, ORC_GIT_AUTO_UPDATE unset)
    # runs the checkout as it is: no pull. See Test-OrcGitAutoUpdate.
    $gitAutoUpdate = Test-OrcGitAutoUpdate -Root $RepoRoot
    if ((-not $SkipUpdates) -and (-not $script:ArtifactMode) -and $isGitCheckout -and (-not $gitAutoUpdate)) {
        Log "Source build: git auto-update is off, running this checkout as it is"
    }
    if ((-not $SkipUpdates) -and (-not $script:ArtifactMode) -and $isGitCheckout -and $gitAutoUpdate) {
        Set-StepActive 6 "Checking for latest version..."
        $bootPull = Invoke-OrcBootPull -Git $git -Root $RepoRoot
        if ($bootPull.AuthFailed) {
            # Not fatal: boot the version already on disk. Check-ForUpdates at
            # the end of this run surfaces the "Sign in to GitHub" banner.
            Log "Boot pull skipped: GitHub sign-in required"
        }

        # If the pull moved HEAD, THIS running script may be stale (old steps,
        # old ports, old boot logic). Re-exec the fresh script from disk.
        # -SkipUpdates prevents a pull loop; the fresh code does the rest.
        if ($bootPull.Moved) {
            $shaAfter = $bootPull.ShaAfter
            $shortSha = $shaAfter.Substring(0, [Math]::Min(7, $shaAfter.Length))
            Set-LauncherStateValue -Name "updatedToSha" -Value $shortSha
            Log "Pulled new version ($shortSha). Re-launching fresh setup.ps1..."
            $lblStatus.Text = "Updated - restarting launcher..."
            $lblStatus.ForeColor = $script:Yellow
            $form.Refresh()
            Invoke-UiPump
            Stop-OrcStrator
            $relaunchArgs = Get-OrcRelaunchArgs -SkipUpdates
            Start-Process -FilePath $script:PowerShellExe -ArgumentList $relaunchArgs
            $form.Close()
            return
        }
    }

    # npm install - robust freshness check:
    #  1) key workspace packages must actually be present (a partial install
    #     can leave node_modules\.package-lock.json behind), and
    #  2) package-lock.json must not have changed since the last successful
    #     install (a git pull that bumps deps must trigger a re-install).
    $lockHash = Get-LockfileHash
    $state = Get-LauncherState
    $lastInstallHash = ""
    if ($state.PSObject.Properties["lockfileHash"]) { $lastInstallHash = $state.lockfileHash }
    $modulesPresent = (Test-Path (Join-Path $RepoRoot "node_modules\.bin")) -and
                      (Test-Path (Join-Path $RepoRoot "node_modules\fastify")) -and
                      (Test-Path (Join-Path $RepoRoot "node_modules\react"))
    $lockFresh = ($lockHash -ne "") -and ($lockHash -eq $lastInstallHash)

    if ($modulesPresent -and $lockFresh) {
        Log "node_modules present and lockfile unchanged - skipping npm install"
        Set-StepOk 6 "Packages ready"
    } else {
        if (-not $modulesPresent) { Log "node_modules missing or incomplete (fastify/react/.bin check failed)" }
        if (-not $lockFresh) { Log "package-lock.json changed since last install (or first run)" }
        Set-StepActive 6 "Installing packages... (this may take a few minutes)"
        Log "Running npm install..."
        $r = Run-Cmd $npm "install" -WorkDir $RepoRoot -TimeoutSec 600
        if ($r.ExitCode -ne 0) {
            Set-StepFail 6 "Package installation failed"
            Show-Error "Installation Failed" "Could not install required packages.`n`nThis sometimes happens on first install. Please close this window and try again.`nIf it keeps failing, ask for help." -DetailLog $LogFile
            return
        }
        Set-LauncherStateValue -Name "lockfileHash" -Value (Get-LockfileHash)
        Set-StepOk 6 "Packages ready"
    }

    # ── Step 7: Build ──────────────────────────────────────────
    # Dev mode: a shared-only rebuild is SUFFICIENT, because both apps compile
    # on the fly (server via tsx, client via Vite). Only shared/ ships prebuilt
    # output that the others import. Always rebuild it so a git pull touching
    # shared/src can't leave shared/dist stale.
    #
    # Production mode: nothing compiles at runtime, so everything must be built
    # up front (shared -> client -> server).
    Set-StepActive 7 "Building app..."
    if ($script:ArtifactMode) {
        # Nothing to build: the payload IS the build output. Rebuilding would
        # also fail, since no TypeScript source ships in a release.
        Log "Artifact mode: skipping build, payload is prebuilt"
        Set-StepOk 7 "App prepared"
    } elseif ($script:ProductionMode) {
        Log "Building all workspaces for production (shared -> client -> server)..."
        $r = Run-Cmd $npm "run build" -WorkDir $RepoRoot -TimeoutSec 600
    } else {
        Log "Building shared types..."
        $r = Run-Cmd $npm "run build -w shared" -WorkDir $RepoRoot -TimeoutSec 60
    }
    if ($r.ExitCode -ne 0) {
        Set-StepFail 7 "Build failed"
        Show-Error "Build Failed" "Could not prepare the app.`nPlease close and try again." -DetailLog $LogFile
        return
    }
    if ($script:ProductionMode) {
        # A missing dist here means the app would 404 its own UI at runtime.
        foreach ($d in @("$RepoRoot\shared\dist", "$RepoRoot\client\dist", "$RepoRoot\server\dist\index.js")) {
            if (-not (Test-Path $d)) {
                Set-StepFail 7 "Build incomplete"
                Log "Production build missing: $d"
                Show-Error "Build Failed" "The production build did not produce:`n$d" -DetailLog $LogFile
                return
            }
        }
    }
    Set-StepOk 7 "App prepared"

    # ══════════════════════════════════════════════════════════
    #  LAUNCH
    # ══════════════════════════════════════════════════════════

    # If OrcStrator is already running (a second launch, or Start while it is
    # already up), REUSE the live processes instead of killing and respawning.
    # The old unconditional kill raced itself: taskkill'ing a healthy server left
    # the previous cmd.exe still holding the > server.log handle for a moment, so
    # the new redirect could not create the file, the fresh cmd exited instantly,
    # and the launcher reported a false "backend crashed during startup". Reusing
    # a healthy backend sidesteps the race and never tears down a working server;
    # only genuinely dead/stale ports get killed below.
    $reuseServer = Test-ServerHealth $ServerPort
    $reuseClient = Test-TcpPort $ClientPort
    if ($reuseServer) { Log "Backend already healthy on port $ServerPort - will reuse, not restart" }
    if ($reuseClient) { Log "Client already listening on port $ClientPort - will reuse, not restart" }

    # Kill existing processes only on the ports we are NOT reusing (tree kill)
    $portsToKill = @()
    if (-not $reuseServer) { $portsToKill += $ServerPort }
    if (-not $reuseClient) { $portsToKill += $ClientPort }
    if ($portsToKill.Count -gt 0) {
        Log "Checking for existing processes on ports $($portsToKill -join ', ')..."
        foreach ($port in $portsToKill) {
            try {
                @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) | ForEach-Object {
                    if ($_.OwningProcess -gt 0) {
                        Log "Killing PID $($_.OwningProcess) on port $port (tree kill)"
                        & taskkill /PID $($_.OwningProcess) /T /F 2>$null
                    }
                }
            } catch { }
        }

        # Wait until the killed ports are actually free before spawning replacements
        $portWait = 0
        while ($portWait -lt 15) {
            Invoke-UiPump
            $stillUp = $false
            foreach ($port in $portsToKill) {
                if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { $stillUp = $true }
            }
            if (-not $stillUp) { break }
            $portWait++
            Log "Waiting for ports to free... ($portWait)"
            Start-Sleep -Milliseconds 500
        }
    }

    # ── Step 8: Start Server ───────────────────────────────────
    Set-StepActive 8 "Starting backend..."
    $serverLog = $ServerLog
    $found = $false
    $procDied = $false
    if ($reuseServer) {
        # A relaunch must never tear down a backend that is already
        # answering /api/health. Adopt its PID and skip the respawn.
        $existingPid = $null
        try { $existingPid = @(Get-NetTCPConnection -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue)[0].OwningProcess } catch { }
        if ($existingPid) { $script:ServerPid = $existingPid }
        Log "Reusing healthy backend already on port $ServerPort (PID $existingPid) - skipping restart"
        $found = $true
    } else {
        Log "Starting server from: $ServerDir (mode: $(if ($script:ProductionMode) { 'production' } else { 'dev' }))"
        if ($script:ProductionMode) {
            # One process serves API + WS + the built client on $ServerPort.
            # Prefer a bundled runtime: it is the Node the payload's native modules
            # were compiled against.
            $nodeExe = Get-OrcNodePath -VersionPath $RepoRoot
            if (-not $nodeExe) { $nodeExe = "node" }
            Log "Production node: $nodeExe"
            $serverCmd = "cd /d `"$ServerDir`" && set NODE_ENV=production&& `"$nodeExe`" dist/index.js > `"$serverLog`" 2>&1"
        } else {
            $serverCmd = "cd /d `"$ServerDir`" && npm run dev > `"$serverLog`" 2>&1"
        }
        # Wait for the server log handle to be released before redirecting into it.
        # A just-killed cmd.exe can briefly keep the > server.log handle open; if the
        # new redirect cannot create the file, the fresh cmd exits instantly and looks
        # exactly like a startup crash. Poll until the file opens for write.
        Wait-FileWritable -Path $serverLog -MaxTries 12 -DelayMs 300 | Out-Null
        $serverProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $serverCmd -WindowStyle Hidden -PassThru
        $script:ServerPid = $serverProc.Id
        Log "Server started (hidden), PID: $($script:ServerPid), log: $serverLog"
        if ($script:JobOk) {
            try {
                if ([OrcJob]::Assign($script:JobHandle, $serverProc.Id)) {
                    Log "Server bound to job object (PID $($serverProc.Id))"
                } else {
                    Log "Server job-bind returned false - relying on fallback kill layers"
                }
            } catch { Log "Server job-bind error: $_" }
        }

        # Give the process a few seconds to spawn before checking
        for ($w = 0; $w -lt 6; $w++) {
            Invoke-UiPump
            Start-Sleep -Milliseconds 500
        }

        # Poll the REAL health endpoint (HTTP 200 + status "ok"), not just the TCP
        # port - an open port does not mean Fastify finished booting. Also fail
        # fast if the spawned process died instead of waiting out the full timeout.
        $seconds = 3
        $maxSeconds = 60
        Log "Polling http://localhost:$ServerPort/api/health ..."
        while ($seconds -lt $maxSeconds) {
            if ($serverProc.HasExited) {
                $procDied = $true
                Log "Server process (PID $($script:ServerPid)) exited with code $($serverProc.ExitCode)"
                break
            }
            if (Test-ServerHealth $ServerPort) { $found = $true; break }
            # Verbose port diagnostics every 5 seconds for debugging
            if (($seconds % 5) -eq 0) { Test-TcpPort $ServerPort -Verbose | Out-Null }
            $seconds++
            Set-StepActive 8 "Starting backend... (${seconds}s)"
            # Sleep ~1s in small chunks to keep UI alive
            for ($w = 0; $w -lt 4; $w++) {
                Invoke-UiPump
                Start-Sleep -Milliseconds 250
            }
        }
    }
    if ($found) {
        Log "Server is healthy on port $ServerPort"
        Set-StepOk 8 "Backend running"
        # This boot proved the active version works, so it becomes the next
        # rollback target.
        if ($script:ArtifactMode) { Confirm-OrcHealthyBoot -Healthy $true | Out-Null }
    } else {
        Test-TcpPort $ServerPort -Verbose | Out-Null
        Set-StepFail 8 "Backend did not start"
        $reason = if ($procDied) { "The backend process crashed during startup." } else { "The backend did not become healthy in time." }

        # Auto-rollback: without this an update that boots into a crash loop is
        # a one-way door, and the user has no UI left to fix it from.
        if ($script:ArtifactMode) {
            $back = Confirm-OrcHealthyBoot -Healthy $false
            if ($back) {
                Log "Rolled back to $back after a failed boot. Relaunching..."
                $lblStatus.Text = "Update failed - rolling back to $back..."
                $lblStatus.ForeColor = $script:Yellow
                $form.Refresh()
                Invoke-UiPump
                Stop-OrcStrator
                $relaunchArgs = Get-OrcRelaunchArgs -SkipUpdates
                Start-Process -FilePath $script:PowerShellExe -ArgumentList $relaunchArgs
                $form.Close()
                return
            }
        }

        Show-Error "Start Failed" "$reason`nServer log:`n$serverLog" -DetailLog $serverLog
        return
    }

    # ── Step 9: Start Client ───────────────────────────────────
    # Production mode has no separate client process: the server already serves
    # the built UI on $ServerPort, so step 8 finishing IS the app being up.
    if ($script:ProductionMode) {
        Log "Production mode: client is served by the backend on port $ServerPort, no Vite process"
        Set-StepOk 9 "OrcStrator is running!"
    } else {

    Set-StepActive 9 "Starting OrcStrator..."
    $clientLog = $ClientLog
    if ($reuseClient) {
        $existingPid = $null
        try { $existingPid = @(Get-NetTCPConnection -LocalPort $ClientPort -State Listen -ErrorAction SilentlyContinue)[0].OwningProcess } catch { }
        if ($existingPid) { $script:ClientPid = $existingPid }
        Log "Reusing client already on port $ClientPort (PID $existingPid) - skipping restart"
        Set-StepOk 9 "OrcStrator is running!"
    } else {
        Log "Starting client from: $ClientDir"
        Wait-FileWritable -Path $clientLog -MaxTries 12 -DelayMs 300 | Out-Null
        $clientProc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "cd /d `"$ClientDir`" && npm run dev > `"$clientLog`" 2>&1" -WindowStyle Hidden -PassThru
        $script:ClientPid = $clientProc.Id
        Log "Client started (hidden), PID: $($script:ClientPid), log: $clientLog"
        if ($script:JobOk) {
            try {
                if ([OrcJob]::Assign($script:JobHandle, $clientProc.Id)) {
                    Log "Client bound to job object (PID $($clientProc.Id))"
                } else {
                    Log "Client job-bind returned false - relying on fallback kill layers"
                }
            } catch { Log "Client job-bind error: $_" }
        }

        # Give Vite a few seconds to start up
        for ($w = 0; $w -lt 8; $w++) {
            Invoke-UiPump
            Start-Sleep -Milliseconds 500
        }

        # Poll for the port (Vite has no health endpoint; TCP listen is the signal).
        # Fail fast if the spawned process died.
        $seconds = 4
        $maxSeconds = 45
        $found = $false
        $procDied = $false
        Log "Polling for client on port $ClientPort..."
        while ($seconds -lt $maxSeconds) {
            if ($clientProc.HasExited) {
                $procDied = $true
                Log "Client process (PID $($script:ClientPid)) exited with code $($clientProc.ExitCode)"
                break
            }
            $verbose = (($seconds % 5) -eq 0)
            if ($verbose) {
                if (Test-TcpPort $ClientPort -Verbose) { $found = $true; break }
            } else {
                if (Test-TcpPort $ClientPort) { $found = $true; break }
            }
            $seconds++
            Set-StepActive 9 "Starting OrcStrator... (${seconds}s)"
            for ($w = 0; $w -lt 4; $w++) {
                Invoke-UiPump
                Start-Sleep -Milliseconds 250
            }
        }
        if ($found) {
            Log "Client is running on port $ClientPort"
            Set-StepOk 9 "OrcStrator is running!"
        } else {
            Test-TcpPort $ClientPort -Verbose | Out-Null
            Set-StepFail 9 "OrcStrator did not start"
            if ($procDied) {
                Show-Error "Start Failed" "The OrcStrator UI process crashed during startup.`nClient log:`n$clientLog" -DetailLog $clientLog
            } else {
                Log "Client may still be starting... Log: $clientLog"
                Log "---- Last 10 lines of $clientLog ----"
                foreach ($line in ((Get-LogTail -Path $clientLog -Lines 10) -split "`n")) { Log "  $line" }
            }
        }
    }

    }   # end dev-mode client startup

    # ── Done! ──────────────────────────────────────────────────
    Start-Process "http://localhost:$($script:AppPort)"
    $lblStatus.Text = "OrcStrator is running!"
    $lblStatus.ForeColor = $script:Green
    $btnOpen.Enabled = $true
    $btnOpen.FlatAppearance.BorderColor = $script:Green
    $btnOpen.ForeColor = $script:Green
    $form.Refresh()

    Log "Setup complete!"

    # ── Desktop shortcut: ensure it exists (created once, no churn) ──
    # Idempotent - only writes if Desktop\OrcStrator.lnk is missing, so a
    # healthy machine re-launching skips it, but a fresh setup always gets one.
    if (New-DesktopShortcut) {
        Log "Desktop shortcut ensured (Desktop\OrcStrator.lnk -> orcstrator.bat)"
    } else {
        Log "Desktop shortcut could not be created (non-fatal)"
    }

    # ── Check for updates in background ───────────────────────
    Check-ForUpdates
}

# ══════════════════════════════════════════════════════════════
#  LAUNCH FORM + START SETUP IN BACKGROUND
# ══════════════════════════════════════════════════════════════

# ── Headless: the whole installed-app flow, no window ──────────
if ($script:Headless) {
    if (-not $script:ArtifactMode) {
        Write-Host "ERROR: -Headless runs an installed OrcStrator only. $($script:LauncherRoot) is a developer checkout (it has .git), so it keeps the git + dev path."
        exit 2
    }
    $r = Invoke-OrcInstalledLaunch
    if (-not $r.ok) {
        Write-Host "ORC_ERROR=$($r.error)"
        Stop-OrcStrator
        exit 1
    }
    if ($ExitAfterHealthCheck) {
        Log "Health check passed; stopping again (-ExitAfterHealthCheck)"
        Stop-OrcStrator
        Clear-OrcServerProcess
        exit 0
    }
    Log "Running headless. Stop this process to stop OrcStrator."
    try {
        while ($true) {
            if (-not (Get-Process -Id $r.serverPid -ErrorAction SilentlyContinue)) { Log "The server process exited"; break }
            Start-Sleep -Seconds 2
        }
    } finally {
        Stop-OrcStrator
    }
    exit 0
}

# ── Wire FormClosing to clean up processes on ANY close method ──
$form.Add_FormClosing({
    $lblStatus.Text = "Shutting down safely..."
    $lblStatus.ForeColor = $script:Yellow
    $btnOpen.Enabled = $false
    $btnShutdown.Enabled = $false
    $form.Refresh()
    Invoke-UiPump
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

# An installed copy shows its own shorter, plain-language step list from the
# first paint (Run-Setup starts 500 ms later).
if ($script:ArtifactMode) { Set-OrcInstalledLayout }

[void]$form.ShowDialog()
$form.Dispose()
