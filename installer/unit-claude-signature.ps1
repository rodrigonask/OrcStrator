# The Claude CLI that the launcher installs with Anthropic's official
# installer is used only when it is signed by Anthropic, and the EULA says the
# installer does this. The launcher's functions are pulled out of setup.ps1 by
# AST; the "install" is stubbed (nothing is downloaded or installed), and the
# claude.exe it finds is a file this test places in a sandbox profile.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\unit-claude-signature.ps1
param([string]$InstallerDir = "")

$ErrorActionPreference = 'Stop'
if (-not $InstallerDir) { $InstallerDir = $PSScriptRoot }
$SetupPath = Join-Path $InstallerDir "setup.ps1"

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
$found = @()
foreach ($name in @('Find-OrcClaude', 'Install-OrcClaudeNative', 'Test-OrcClaudeSignature', 'Get-OrcServerClaudePath', 'Save-OrcServerProcess', 'Read-OrcServerProcess', 'Get-OrcFinalPath', 'Test-OrcPinnablePath')) {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
    if ($fn) { Invoke-Expression $fn.Extent.Text; $found += $name }
}
$assign = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$script:ClaudeNativeInstallCommand' }, $true) | Select-Object -First 1
$script:ClaudeNativeInstallCommand = & ([scriptblock]::Create($assign.Right.Extent.Text))
$marker = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$script:ClaudeRefusedMarker' }, $true) | Select-Object -First 1
if ($marker) { $script:ClaudeRefusedMarker = & ([scriptblock]::Create($marker.Right.Extent.Text)) }
$script:Logged = New-Object System.Collections.ArrayList
function Log { param([string]$Msg) [void]$script:Logged.Add($Msg) }
# Stubs: nothing runs, nothing on PATH is consulted.
function Invoke-OrcHiddenProcess { param($FilePath, $Arguments, $TimeoutSec) $script:installerRuns++; return @{ ExitCode = 0; Output = '' } }
function Find-Exe { param($Name) return $null }

Write-Host "`n== EULA ==" -ForegroundColor Cyan
$eula = [System.IO.File]::ReadAllText((Join-Path $InstallerDir "EULA.txt"))
Check "the EULA says OrcStrator may install Claude Code, by Anthropic" ($eula -match 'Claude Code' -and $eula -match 'Anthropic')
Check "the EULA names the official installer it runs" ($eula -match [regex]::Escape('https://claude.ai/install.ps1'))
Check "the EULA says the installed program's signature is checked" ($eula -match '(?i)signed by Anthropic')
Check "the EULA is plain ASCII (the installer page shows it as-is)" (-not ($eula -match '[^\x00-\x7F]'))

Write-Host "`n== Signature check ==" -ForegroundColor Cyan
Check "setup.ps1 has Test-OrcClaudeSignature" ($found -contains 'Test-OrcClaudeSignature')
$sandbox = Join-Path $env:TEMP "orc-unit-claudesig-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$bin = Join-Path $sandbox ".local\bin"
New-Item -ItemType Directory -Force $bin | Out-Null
$realProfile = $env:USERPROFILE
$realClaude = Join-Path $realProfile ".local\bin\claude.exe"
$target = Join-Path $bin "claude.exe"
$savedPath = $env:PATH
try {
    $env:USERPROFILE = $sandbox
    $cases = @(
        @{ Name = 'an unsigned claude.exe'; Make = { [System.IO.File]::WriteAllBytes($target, [byte[]](77, 90) + [byte[]](1..250)) } },
        @{ Name = 'a validly signed exe from another publisher (Microsoft notepad.exe)'; Make = { Copy-Item (Join-Path $env:WINDIR 'System32\notepad.exe') $target -Force } }
    )
    foreach ($c in $cases) {
        & $c.Make
        $script:installerRuns = 0
        $got = Install-OrcClaudeNative
        Check "after the official installer: $($c.Name) is NOT used" (($script:installerRuns -eq 1) -and ($null -eq $got)) "got '$got'"
        Check "  and the refusal is logged as a security event" (@($script:Logged | Where-Object { $_ -match 'SECURITY: the Claude CLI' }).Count -ge 1)
        $script:Logged.Clear()
    }
    if (Test-Path $realClaude) {
        Copy-Item $realClaude $target -Force
        $got = Install-OrcClaudeNative
        Check "after the official installer: Anthropic's signed claude.exe IS used" ($got -eq $target) "got '$got'"
    } else {
        Write-Host "  (no Anthropic-signed claude.exe on this machine: the accept case runs where one exists)" -ForegroundColor DarkGray
    }
    # The NEXT launch: the unsigned claude.exe is still in the native folder.
    # It must not be picked up just because it is already there.
    [System.IO.File]::WriteAllBytes($target, [byte[]](77, 90) + [byte[]](1..250))
    $script:ClaudeSignatureRefused = $null
    $again = Find-OrcClaude
    Check "on the next launch an unsigned claude.exe in the native folder is still not used" (($null -eq $again) -and [bool]$script:ClaudeSignatureRefused) "got '$again'"
    # Judged by what the file is, not where PATH found it. A
    # claude.com (run before .exe) or an unsigned claude.exe reached through
    # any other folder, junction or \\?\ form is refused the same way.
    $elsewhere = Join-Path $sandbox 'other-bin'
    New-Item -ItemType Directory -Force $elsewhere | Out-Null
    foreach ($c in @(
        @{ Name = 'a claude.com next to it'; Path = (Join-Path $bin 'claude.com') },
        @{ Name = 'an unsigned claude.exe in another PATH folder'; Path = (Join-Path $elsewhere 'claude.exe') },
        @{ Name = 'the native claude.exe through a \\?\ path'; Path = ('\\?\' + $target) }
    )) {
        $real = $c.Path -replace '^\\\\\?\\', ''
        [System.IO.File]::WriteAllBytes($real, [byte[]](77, 90) + [byte[]](1..250))
        $script:pathFound = $c.Path
        function Find-Exe { param($Name) if ($Name -eq 'claude') { return $script:pathFound } return $null }
        $script:ClaudeSignatureRefused = $null
        $r = Find-OrcClaude
        Check "$($c.Name) is not used" ($null -eq $r -or $r -like '*.cmd') "got '$r'"
    }
    function Find-Exe { param($Name) return $null }

    # The app server picks its own claude.exe (first
    # on PATH, else the native folder). The launcher resolves that same file,
    # verifies it and pins the server to it, or to "none".
    if ($found -contains 'Get-OrcServerClaudePath') {
        $dirA = Join-Path $sandbox 'pathA'; New-Item -ItemType Directory -Force $dirA | Out-Null
        Set-Content (Join-Path $dirA 'claude.cmd') '@exit /b 0' -Encoding ASCII
        [System.IO.File]::WriteAllBytes((Join-Path $elsewhere 'claude.exe'), [byte[]](77, 90) + [byte[]](1..250))
        $env:PATH = "$dirA;$elsewhere"
        $script:ClaudeSignatureRefused = $null
        $pin = Get-OrcServerClaudePath
        Check "a .cmd first on PATH and an unsigned claude.exe later: the server is pinned to 'none', not that exe" (($pin -ne '') -and ($pin -eq $script:ClaudeRefusedMarker) -and [bool]$script:ClaudeSignatureRefused) "got '$pin'"
        Check "  and 'none' can never be a file (it holds characters no Windows file name can have)" ([bool]$script:ClaudeRefusedMarker -and ($script:ClaudeRefusedMarker.IndexOfAny([System.IO.Path]::GetInvalidFileNameChars()) -ge 0))
        if (Test-Path $realClaude) {
            Copy-Item $realClaude (Join-Path $elsewhere 'claude.exe') -Force
            $pin = Get-OrcServerClaudePath
            Check "an Anthropic-signed claude.exe is what the server is pinned to" ($pin -ieq (Get-OrcFinalPath -Path (Join-Path $elsewhere 'claude.exe'))) "got '$pin'"
        }
        if (Test-Path $realClaude) {
            # An unsigned claude.exe earlier on PATH does not hide a signed one after it.
            $dirB = Join-Path $sandbox 'pathB'; New-Item -ItemType Directory -Force $dirB | Out-Null
            [System.IO.File]::WriteAllBytes((Join-Path $dirB 'claude.exe'), [byte[]](77, 90) + [byte[]](1..250))
            $env:PATH = "$dirB;$elsewhere"
            $pin = Get-OrcServerClaudePath
            Check "an unsigned claude.exe first on PATH is skipped and the signed one after it is pinned" ($pin -ieq (Get-OrcFinalPath -Path (Join-Path $elsewhere 'claude.exe'))) "got '$pin'"
        }
        # An unsigned claude.exe reached through a \\?\ or \\.\ PATH
        # entry, with nothing signed anywhere. The launcher must still pin "none": left unset,
        # the server searched PATH itself and ran that file.
        [System.IO.File]::Delete((Join-Path $elsewhere 'claude.exe'))
        $evil = Join-Path $sandbox 'evil dir'; New-Item -ItemType Directory -Force $evil | Out-Null
        [System.IO.File]::WriteAllBytes((Join-Path $evil 'claude.exe'), [byte[]](77, 90) + [byte[]](1..250))
        foreach ($form in @('\\?\', '\\.\')) {
            $env:PATH = "$form$evil"
            $script:ClaudeSignatureRefused = $null
            $pin = Get-OrcServerClaudePath
            Check "an unsigned claude.exe behind a $form PATH entry: the server is pinned to 'none'" (($pin -eq $script:ClaudeRefusedMarker) -and [bool]$script:ClaudeSignatureRefused) "got '$pin'"
        }
        [System.IO.File]::Delete($target)
        $env:PATH = Join-Path $sandbox 'empty-nothing-here'
        $pin = Get-OrcServerClaudePath
        Check "no claude.exe anywhere: the server is still pinned to 'none', never left to search" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
        # A relative PATH entry names a different file for the server (it starts elsewhere).
        Push-Location $sandbox
        $env:PATH = 'evil dir'
        $pin = Get-OrcServerClaudePath
        Pop-Location
        Check "a relative PATH entry is not pinned" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
        # "C:x" and "\x" pass IsPathRooted but depend on the current drive or folder.
        # A signed copy sits behind them, so only the "absolute folders only" rule refuses it.
        if (Test-Path $realClaude) {
            $signedDir = Join-Path $sandbox 'signed here'; New-Item -ItemType Directory -Force $signedDir | Out-Null
            Copy-Item $realClaude (Join-Path $signedDir 'claude.exe') -Force
            foreach ($rel in @(('\' + $signedDir.Substring(3)), ($signedDir.Substring(0, 2) + $signedDir.Substring(3)))) {
                Push-Location ($signedDir.Substring(0, 3))
                $env:PATH = $rel
                $pin = Get-OrcServerClaudePath
                Pop-Location
                Check "a drive- or folder-relative PATH entry ($($rel.Substring(0, [Math]::Min(12, $rel.Length)))...) is not pinned, even to a signed copy" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
            }
        }
        # A claude.exe the user pointed OrcStrator at is held to the same rule.
        $env:PATH = Join-Path $sandbox 'empty-nothing-here'
        $env:ORCSTRATOR_CLAUDE_PATH = Join-Path $evil 'claude.exe'
        $pin = Get-OrcServerClaudePath
        Check "an unsigned ORCSTRATOR_CLAUDE_PATH the user set is not pinned" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
        if (Test-Path $realClaude) {
            $custom = Join-Path $sandbox 'custom place'; New-Item -ItemType Directory -Force $custom | Out-Null
            Copy-Item $realClaude (Join-Path $custom 'claude.exe') -Force
            $env:ORCSTRATOR_CLAUDE_PATH = Join-Path $custom 'claude.exe'
            $pin = Get-OrcServerClaudePath
            Check "a signed claude.exe the user set in ORCSTRATOR_CLAUDE_PATH is kept" ($pin -ieq (Get-OrcFinalPath -Path (Join-Path $custom 'claude.exe'))) "got '$pin'"
        }
        if (Test-Path $realClaude) {
            # A signed copy named plain "claude" is checked as written,
            # but Windows runs the claude.com / claude.exe beside it. Only a ".exe" is pinned.
            $noExt = Join-Path $sandbox 'no ext'; New-Item -ItemType Directory -Force $noExt | Out-Null
            Copy-Item $realClaude (Join-Path $noExt 'claude') -Force
            [System.IO.File]::WriteAllBytes((Join-Path $noExt 'claude.com'), [byte[]](77, 90) + [byte[]](1..250))
            $env:ORCSTRATOR_CLAUDE_PATH = Join-Path $noExt 'claude'
            $pin = Get-OrcServerClaudePath
            Check "a signed override without '.exe' (a claude.com beside it) is not pinned" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
            # A PATH folder that is a junction: the pin is the real file, so retargeting the
            # junction later cannot change what the server runs.
            $real1 = Join-Path $sandbox 'real one'; New-Item -ItemType Directory -Force $real1 | Out-Null
            Copy-Item $realClaude (Join-Path $real1 'claude.exe') -Force
            $link = Join-Path $sandbox 'link dir'
            New-Item -ItemType Junction -Path $link -Target $real1 | Out-Null
            Remove-Item Env:\ORCSTRATOR_CLAUDE_PATH -ErrorAction SilentlyContinue
            $env:PATH = $link
            $pin = Get-OrcServerClaudePath
            Check "a PATH folder that is a junction pins the real file behind it, not the link" ($pin -ieq (Get-OrcFinalPath -Path (Join-Path $real1 'claude.exe'))) "got '$pin'"
            [System.IO.Directory]::Delete($link)
            $env:PATH = Join-Path $sandbox 'empty-nothing-here'
        }
        Check "a stream or a trailing dot is never a pinnable path" (-not (Test-OrcPinnablePath 'C:\x\host.txt:evil') -and -not (Test-OrcPinnablePath 'C:\x\claude.exe.') -and -not (Test-OrcPinnablePath 'C:\x\claude') -and (Test-OrcPinnablePath 'C:\x\claude.exe') -and (Test-OrcPinnablePath '\\srv\share\claude.exe'))
        $env:ORCSTRATOR_CLAUDE_PATH = $script:ClaudeRefusedMarker
        $pin = Get-OrcServerClaudePath
        Check "the marker passed on before a Restart is ignored, not treated as a file" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
        Remove-Item Env:\ORCSTRATOR_CLAUDE_PATH -ErrorAction SilentlyContinue
        $env:PATH = $savedPath
        [System.IO.File]::Delete((Join-Path $elsewhere 'claude.exe'))
        $setupNow = [System.IO.File]::ReadAllText($SetupPath)
        Check "the installed server is started with ORCSTRATOR_CLAUDE_PATH from it" ($setupNow -match '\$env:ORCSTRATOR_CLAUDE_PATH = \$ClaudePath' -and $setupNow -match '\$serverClaude = Get-OrcServerClaudePath' -and $setupNow -match '-ClaudePath \$serverClaude')
        Check "  through the environment, not a cmd 'set' that would expand a % in the path" (-not ($setupNow -match 'set .ORCSTRATOR_CLAUDE_PATH='))
        # The pin a server was started with survives server-process.json (the marker too).
        $spFile = Join-Path $sandbox 'server-process.json'
        foreach ($pinValue in @($script:ClaudeRefusedMarker, 'C:\Users\me\x y\.local\bin\claude.exe')) {
            Save-OrcServerProcess -ProcessId 4242 -ExePath 'C:\n\node.exe' -Port 3334 -Version '9.9.9' -Path $spFile -ClaudePin $pinValue
            $back = Read-OrcServerProcess -Path $spFile
            Check "server-process.json keeps the pin '$pinValue' exactly" ("$($back.claudePin)" -eq $pinValue) "got '$($back.claudePin)'"
        }
        Check "a server started earlier is reused only with the same pin" ($setupNow -match '\("\$\(\$rec\.claudePin\)" -eq \$serverClaude\)' -and $setupNow -match '-ClaudePin \$serverClaude')
        Check "only npm's script shim: Claude AI is installed, since the app server can never run a shim" ($setupNow -match "@\('\.cmd', '\.ps1'\) -contains" -and $setupNow -match 'Only a script shim')
        Check "the dialog opens before the browser, so it is not hidden behind it" ($setupNow.IndexOf('Show-Error "Claude AI Could Not Be Verified" "OrcStrator could not confirm') -lt $setupNow.IndexOf('Set-OrcStatus "OrcStrator is running. $why"') -and $setupNow.IndexOf('Set-OrcStatus "OrcStrator is running. $why"') -lt $setupNow.IndexOf('Start-Process $out.url'))
        Check "the second refusal in a row names the file to delete" ($setupNow -match 'claude-refused\.txt' -and $setupNow -match 'Delete this file, then click Restart:' + [regex]::Escape('`r`n$bad'))
        Check "a refused server copy is never shown as a green 'running!'" ($setupNow -match '\(\$serverClaude -eq \$script:ClaudeRefusedMarker\)')
    } else { Check "setup.ps1 has Get-OrcServerClaudePath" $false }
    $setupText = [System.IO.File]::ReadAllText($SetupPath)
    Check "the refused status fits the one-line status label (one short sentence)" ($setupText -match '"Claude AI could not be verified\. Click Restart\."')
    Check "the launch steps say it could not be verified, not that it is missing" ($setupText -match 'Claude AI could not be verified as the genuine program' -and $setupText -match 'Claude AI Could Not Be Verified')
    # What the existing launcher test (test-claude-cli.ps1) does: a stand-in
    # command drops claude.cmd, found on PATH. Not the native claude.exe, so
    # not held to the rule: that test keeps passing.
    [System.IO.File]::Delete($target)
    $cmd = Join-Path $bin 'claude.cmd'
    Set-Content $cmd '@exit /b 0' -Encoding ASCII
    function Find-Exe { param($Name) if ($Name -eq 'claude') { return $cmd } return $null }
    $got = Install-OrcClaudeNative -Command 'Write-Output stand-in'
    Check "a stand-in that installs claude.cmd elsewhere on PATH is not held to the rule (test-claude-cli.ps1 keeps working)" ($got -eq $cmd) "got '$got'"
    # The official installer ran but PATH still finds npm's shim first. The shim is
    # the user's own install: no false SECURITY alarm, no refusal (the server-pin scan decides).
    $script:Logged.Clear(); $script:ClaudeSignatureRefused = $null
    $got = Install-OrcClaudeNative
    Check "after the official installer, npm's claude.cmd found first raises no false security alarm" (($got -eq $cmd) -and -not $script:ClaudeSignatureRefused -and -not (@($script:Logged | Where-Object { $_ -match 'SECURITY' }).Count)) "got '$got'"
    $setupText2 = [System.IO.File]::ReadAllText($SetupPath)
    Check "a failed install for a shim-only machine shows step 4 as failed, not 'ready'" ($setupText2 -match 'if \(\$shimInstallFailed\) \{ Set-StepFail 4')
} finally {
    $env:USERPROFILE = $realProfile
    $env:PATH = $savedPath
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

# The pin cases above need a real Anthropic-signed claude.exe, which a CI runner does not have.
# The same cases again with a stand-in verifier (a file that starts with "SIGNED" counts as
# signed), so the rules themselves (junction, no ".exe", order on PATH, user override) run on CI.
Write-Host "`n== Pin rules with a stand-in verifier (run everywhere) ==" -ForegroundColor Cyan
function Test-OrcClaudeSignature {
    param([string]$Path)
    try { $b = [System.IO.File]::ReadAllBytes($Path) } catch { return @{ Ok = $false; Why = "unreadable" } }
    if ($b.Length -ge 6 -and [System.Text.Encoding]::ASCII.GetString($b, 0, 6) -eq 'SIGNED') { return @{ Ok = $true; Why = 'stand-in signed' } }
    return @{ Ok = $false; Why = 'stand-in unsigned' }
}
$sb2 = Join-Path $env:TEMP "orc-unit-pinrules-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$savedPath2 = $env:PATH; $savedProfile2 = $env:USERPROFILE; $savedOverride2 = $env:ORCSTRATOR_CLAUDE_PATH
try {
    $env:USERPROFILE = Join-Path $sb2 'home'
    Remove-Item Env:\ORCSTRATOR_CLAUDE_PATH -ErrorAction SilentlyContinue
    $good = Join-Path $sb2 'good'; $bad = Join-Path $sb2 'bad'; $noExt2 = Join-Path $sb2 'no ext'
    foreach ($d in $good, $bad, $noExt2) { New-Item -ItemType Directory -Force $d | Out-Null }
    [System.IO.File]::WriteAllText((Join-Path $good 'claude.exe'), 'SIGNED stand-in')
    # The pin is the file's real (long) path; on a runner TEMP itself is an 8.3 short path.
    $goodFinal = Get-OrcFinalPath -Path (Join-Path $good 'claude.exe')
    [System.IO.File]::WriteAllText((Join-Path $bad 'claude.exe'), 'MZ unsigned')
    $env:PATH = "$bad;$good"
    $pin = Get-OrcServerClaudePath
    Check "(stand-in) an unsigned claude.exe first on PATH is skipped, the signed one after it is pinned" (($goodFinal -like '*\good\claude.exe') -and ($pin -ieq $goodFinal)) "got '$pin'"
    [System.IO.File]::WriteAllText((Join-Path $noExt2 'claude'), 'SIGNED stand-in')
    [System.IO.File]::WriteAllText((Join-Path $noExt2 'claude.com'), 'MZ unsigned')
    $env:PATH = Join-Path $sb2 'nothing'
    $env:ORCSTRATOR_CLAUDE_PATH = Join-Path $noExt2 'claude'
    $pin = Get-OrcServerClaudePath
    Check "(stand-in) a signed override without '.exe' is not pinned" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
    $env:ORCSTRATOR_CLAUDE_PATH = Join-Path $good 'claude.exe'
    $pin = Get-OrcServerClaudePath
    Check "(stand-in) a signed claude.exe the user set in ORCSTRATOR_CLAUDE_PATH is kept" ($pin -ieq $goodFinal) "got '$pin'"
    $env:ORCSTRATOR_CLAUDE_PATH = Join-Path $bad 'claude.exe'
    $pin = Get-OrcServerClaudePath
    Check "(stand-in) an unsigned ORCSTRATOR_CLAUDE_PATH is not pinned" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
    Remove-Item Env:\ORCSTRATOR_CLAUDE_PATH -ErrorAction SilentlyContinue
    $link2 = Join-Path $sb2 'link dir'
    New-Item -ItemType Junction -Path $link2 -Target $good | Out-Null
    $env:PATH = $link2
    $pin = Get-OrcServerClaudePath
    Check "(stand-in) a PATH folder that is a junction pins the real file behind it" ($pin -ieq $goodFinal) "got '$pin'"
    [System.IO.Directory]::Delete($link2)
    $env:PATH = '\' + $good.Substring(3)
    Push-Location ($good.Substring(0, 3))
    $pin = Get-OrcServerClaudePath
    Pop-Location
    Check "(stand-in) a root-relative PATH entry is not pinned, even to a signed copy" ($pin -eq $script:ClaudeRefusedMarker) "got '$pin'"
} finally {
    $env:PATH = $savedPath2; $env:USERPROFILE = $savedProfile2
    if ($savedOverride2) { $env:ORCSTRATOR_CLAUDE_PATH = $savedOverride2 } else { Remove-Item Env:\ORCSTRATOR_CLAUDE_PATH -ErrorAction SilentlyContinue }
    Remove-Item $sb2 -Recurse -Force -ErrorAction SilentlyContinue
}
$setupText3 = [System.IO.File]::ReadAllText($SetupPath)
Check "a failed install on a shim-only machine skips sign-in (the shim is not Claude AI for the app)" ($setupText3 -match '\$claude = if \(\$shimInstallFailed\) \{ \$null \}')

Write-Host "`n$pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
exit 0
