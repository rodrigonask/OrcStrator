# Harness for the launcher's update/auth logic. Pulls the real functions out
# of setup.ps1 by AST (so the test cannot drift from the shipped code) and
# runs them against this machine's git.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-update-logic.ps1
Add-Type -AssemblyName System.Windows.Forms

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)

$want = @('Invoke-UiPump', 'Run-Cmd', 'Test-GitAuthFailure', 'Invoke-GitRetry', 'Get-UpstreamRef', 'Find-Exe')
foreach ($name in $want) {
    $fn = $ast.FindAll({ param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
    }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $name in setup.ps1" }
    Invoke-Expression $fn.Extent.Text
}

# Mirror setup.ps1's silent-git environment (same literal values)
$script:GitSilentEnv = @{
    GIT_TERMINAL_PROMPT = "0"
    GCM_INTERACTIVE     = "never"
}
function Log { param([string]$Msg) Write-Host "    [log] $Msg" -ForegroundColor DarkGray }

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$git = Find-Exe "git"
$MainRepo = ((& $git -C $PSScriptRoot rev-parse --show-toplevel) -join "").Trim()
if (-not $MainRepo) { throw "installer/ is not inside a git checkout" }
Write-Host "Repo under test: $MainRepo" -ForegroundColor DarkGray

Write-Host "`n== Test-GitAuthFailure ==" -ForegroundColor Cyan
$authCases = @(
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Repository not found.`nfatal: repository 'https://github.com/x/y.git/' not found",
    "fatal: Authentication failed for 'https://github.com/x/y.git/'",
    "fatal: unable to access '...': The requested URL returned error: 403",
    "git@github.com: Permission denied (publickey).",
    "fatal: Cannot prompt because user interactivity has been disabled."
)
foreach ($c in $authCases) {
    $r = @{ ExitCode = 128; Output = ""; Error = $c }
    Check "auth detected: $($c.Substring(0, [Math]::Min(46, $c.Length)))" (Test-GitAuthFailure $r)
}
$nonAuthCases = @(
    "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
    "fatal: unable to access '...': Operation timed out after 15000 milliseconds",
    "error: Your local changes to the following files would be overwritten by merge"
)
foreach ($c in $nonAuthCases) {
    $r = @{ ExitCode = 128; Output = ""; Error = $c }
    Check "NOT auth: $($c.Substring(0, [Math]::Min(46, $c.Length)))" (-not (Test-GitAuthFailure $r))
}
Check "exit 0 is never an auth failure" (-not (Test-GitAuthFailure @{ ExitCode = 0; Output = "ok"; Error = "" }))
Check "null result is not an auth failure" (-not (Test-GitAuthFailure $null))

Write-Host "`n== Get-UpstreamRef ==" -ForegroundColor Cyan
$up = Get-UpstreamRef -Git $git -WorkDir $MainRepo
Check "resolves a remote-tracking ref (got '$up')" ($up -and $up -match '^origin/') "expected something like origin/main"
& $git -C $MainRepo rev-parse --verify --quiet "$up^{commit}" > $null 2>&1
Check "the resolved ref actually exists" ($LASTEXITCODE -eq 0)
$upTmp = Get-UpstreamRef -Git $git -WorkDir $env:TEMP
Check "returns null outside a repo (got '$upTmp')" ($null -eq $upTmp)

Write-Host "`n== rev-list against the resolved ref ==" -ForegroundColor Cyan
$behind = ((& $git -C $MainRepo rev-list "HEAD..$up" --count 2>&1) -join "").Trim()
Check "rev-list HEAD..$up returns a number (got '$behind')" ($behind -match '^\d+$')
# The shipped bug: origin/master does not exist here, rev-list threw, and the
# old catch turned that into "0 commits behind" = a permanent "Up to date".
& $git -C $MainRepo rev-parse --verify --quiet "origin/master^{commit}" > $null 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "  SKIP  origin/master exists in this checkout, cannot demo the old bug" -ForegroundColor Yellow
} else {
    $old = ((& $git -C $MainRepo rev-list "HEAD..origin/master" --count 2>&1) -join "").Trim()
    Check "old hardcoded origin/master does NOT resolve (proves the bug was real)" ($old -notmatch '^\d+$') "got '$old'"
}

Write-Host "`n== Silent env: missing credentials fail fast, not hang ==" -ForegroundColor Cyan
# Clear the credential helper so git has no way to authenticate, then confirm
# GIT_TERMINAL_PROMPT=0 turns it into a fast, classifiable failure. GitHub
# answers an unknown repo like a private one: it asks for credentials.
$noCred = "-c credential.helper= -c credential.helper=`"`" ls-remote https://github.com/example-owner/example-private-repo.git"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$r = Invoke-GitRetry $git $noCred -WorkDir $MainRepo -TimeoutSec 20
$sw.Stop()
Write-Host "    exit=$($r.ExitCode) authFailed=$($r.AuthFailed) elapsed=$([Math]::Round($sw.Elapsed.TotalSeconds,1))s" -ForegroundColor DarkGray
Write-Host "    stderr: $($r.Error)" -ForegroundColor DarkGray
Check "unauthenticated private fetch is flagged AuthFailed" ([bool]$r.AuthFailed)
Check "returns in under 20s (no retry storm, no invisible prompt)" ($sw.Elapsed.TotalSeconds -lt 20)

Write-Host "`n== Normal authenticated fetch still works ==" -ForegroundColor Cyan
$r2 = Invoke-GitRetry $git "fetch --quiet" -WorkDir $MainRepo -TimeoutSec 30
Check "fetch succeeds with stored credentials" ($r2.ExitCode -eq 0) "exit=$($r2.ExitCode) err=$($r2.Error)"
Check "successful fetch is not flagged AuthFailed" (-not $r2.AuthFailed)

Write-Host "`n== Run-Cmd EnvVars ==" -ForegroundColor Cyan
$r3 = Run-Cmd "cmd.exe" "/c echo %ORC_TEST_VAR%" -TimeoutSec 10 -EnvVars @{ ORC_TEST_VAR = "hello-from-envvars" }
Check "EnvVars reach the child process" ($r3.Output -match 'hello-from-envvars') "got '$($r3.Output)'"
$r4 = Run-Cmd "cmd.exe" "/c echo plain" -TimeoutSec 10
Check "Run-Cmd still works with no EnvVars" ($r4.Output -match 'plain') "got '$($r4.Output)'"

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
