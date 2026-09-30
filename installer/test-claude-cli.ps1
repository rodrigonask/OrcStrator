# Claude CLI handling in the launcher:
#   - missing CLI -> Anthropic's NATIVE installer runs (never npm -g)
#   - API-key-only user -> treated as logged in
# Drives the REAL functions from setup.ps1 (AST-extracted). The native
# installer itself is mocked: the test must not download anything, and it
# must never touch the real profile, so USERPROFILE points at a sandbox.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-claude-cli.ps1

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
foreach ($name in @('Find-Exe', 'Invoke-OrcHiddenProcess', 'Find-OrcClaude', 'Test-OrcClaudeSignature', 'Install-OrcClaudeNative',
                    'Resolve-OrcClaude', 'Get-OrcClaudeCredPath', 'Test-OrcClaudeLoggedIn', 'Invoke-UiPump')) {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $name in setup.ps1" }
    Invoke-Expression $fn.Extent.Text
}
$cmdAssign = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$script:ClaudeNativeInstallCommand' }, $true) | Select-Object -First 1
Invoke-Expression $cmdAssign.Extent.Text
function Log { param([string]$Msg) if ($env:ORC_TEST_VERBOSE) { Write-Host "    [log] $Msg" -ForegroundColor DarkGray } }
$script:Headless = $true

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$sandbox = Join-Path $env:TEMP "orc-claude-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null
$saved = @{}
foreach ($n in 'PATH', 'USERPROFILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR') { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }

try {
    # A machine with no claude anywhere: sandbox home, PATH without claude.
    $env:USERPROFILE = $sandbox
    $env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'claude.exe')) -and -not (Test-Path (Join-Path $_ 'claude.cmd')) }) -join ';'
    [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'Process')
    [Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', $null, 'Process')

    Write-Host "== The install command is Anthropic's native installer ==" -ForegroundColor Cyan
    Check "command is the official native installer" ($script:ClaudeNativeInstallCommand -eq 'irm https://claude.ai/install.ps1 | iex') "got '$script:ClaudeNativeInstallCommand'"
    $setupText = [System.IO.File]::ReadAllText($SetupPath)
    Check "setup.ps1 never installs claude with npm -g" ($setupText -notmatch 'install -g @anthropic-ai/claude-code')

    Write-Host "`n== Missing CLI -> the native installer is invoked ==" -ForegroundColor Cyan
    Check "no claude on this sandboxed machine" ($null -eq (Find-OrcClaude))
    # Mock the installer, keep the orchestration real.
    $script:nativeCalls = 0
    function Install-OrcClaudeNative { $script:nativeCalls++; return "C:\mock\claude.exe" }
    $r = Resolve-OrcClaude -AllowInstall
    Check "native installer called exactly once" ($script:nativeCalls -eq 1) "calls: $script:nativeCalls"
    Check "resolved to the freshly installed claude" ($r.Path -eq "C:\mock\claude.exe" -and $r.InstalledNow)
    $script:nativeCalls = 0
    $r = Resolve-OrcClaude
    Check "without -AllowInstall (headless default) nothing is installed" ($script:nativeCalls -eq 0 -and $null -eq $r.Path)

    # Now run the REAL Install-OrcClaudeNative with a stand-in command that does
    # what the native installer does (drop claude into ~\.local\bin), proving
    # the process plumbing and the post-install lookup.
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Install-OrcClaudeNative' }, $true) | Select-Object -First 1
    Invoke-Expression $fn.Extent.Text
    $fake = 'New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.local\bin" | Out-Null; Set-Content "$env:USERPROFILE\.local\bin\claude.cmd" "@exit /b 0" -Encoding ASCII'
    $got = Install-OrcClaudeNative -Command $fake -TimeoutSec 60
    Check "real installer plumbing ran the command and found claude" ($got -and $got -like "$sandbox*claude*") "got '$got'"
    Check "~\.local\bin is now on PATH for this process" ($env:PATH -like "*$sandbox\.local\bin*")
    Remove-Item (Join-Path $sandbox ".local") -Recurse -Force

    Write-Host "`n== Login detection ==" -ForegroundColor Cyan
    $noCreds = Join-Path $sandbox "no-such\.credentials.json"
    $a = Test-OrcClaudeLoggedIn -ClaudeExe $null -CredPath $noCreds -ApiKey ""
    Check "nothing -> not logged in" (-not $a.LoggedIn -and $a.Method -eq 'none')
    $a = Test-OrcClaudeLoggedIn -ClaudeExe $null -CredPath $noCreds -ApiKey "sk-ant-test-not-a-real-key"
    Check "API key only (no credentials file) -> logged in" ($a.LoggedIn -and $a.Method -eq 'api_key') "method $($a.Method)"
    $env:ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key"
    $a = Test-OrcClaudeLoggedIn -ClaudeExe $null -CredPath $noCreds
    Check "ANTHROPIC_API_KEY in the environment -> logged in" ($a.LoggedIn -and $a.Method -eq 'api_key')
    [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $null, 'Process')
    $cred = Join-Path $sandbox ".credentials.json"
    Set-Content $cred '{"claudeAiOauth":{"accessToken":"x"}}' -Encoding UTF8
    $a = Test-OrcClaudeLoggedIn -ClaudeExe $null -CredPath $cred -ApiKey ""
    Check "claudeAiOauth credentials -> logged in" ($a.LoggedIn -and $a.Method -eq 'oauth')
    Set-Content $cred '{"somethingElse":{}}' -Encoding UTF8
    $a = Test-OrcClaudeLoggedIn -ClaudeExe $null -CredPath $cred -ApiKey ""
    Check "credentials file without claudeAiOauth -> not logged in" (-not $a.LoggedIn)
    $okCli = Join-Path $sandbox "claude-ok.cmd";  Set-Content $okCli "@exit /b 0" -Encoding ASCII
    $badCli = Join-Path $sandbox "claude-no.cmd"; Set-Content $badCli "@exit /b 1" -Encoding ASCII
    $a = Test-OrcClaudeLoggedIn -ClaudeExe $okCli -CredPath $noCreds -ApiKey ""
    Check "'claude auth status' exit 0 -> logged in" ($a.LoggedIn -and $a.Method -eq 'auth_status')
    $a = Test-OrcClaudeLoggedIn -ClaudeExe $badCli -CredPath $noCreds -ApiKey ""
    Check "'claude auth status' exit 1 -> not logged in" (-not $a.LoggedIn)
    $env:CLAUDE_CONFIG_DIR = Join-Path $sandbox "cfg"
    Check "CLAUDE_CONFIG_DIR moves the credentials path" ((Get-OrcClaudeCredPath) -eq (Join-Path $sandbox "cfg\.credentials.json"))
}
finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
