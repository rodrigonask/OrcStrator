# Installed mode vs the developer checkout:
#   - data root: ORCSTRATOR_DATA_DIR wins; a .git checkout keeps
#     %USERPROFILE%\.orcstrator-v2; an installed copy uses %LOCALAPPDATA%\OrcStrator
#   - this repo checkout still takes the git + dev path
#   - the installed-mode launch path never calls winget, git, npm, a system
#     Node install or the VS Build Tools
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-installed-paths.ps1

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
function Get-Fn([string]$Name) {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $Name in setup.ps1" }
    return $fn
}
foreach ($name in @('Resolve-OrcDataRoot', 'Test-OrcArtifactMode')) { Invoke-Expression (Get-Fn $name).Extent.Text }

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$sandbox = Join-Path $env:TEMP "orc-paths-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$gitco = Join-Path $sandbox "checkout"; New-Item -ItemType Directory -Path (Join-Path $gitco ".git") -Force | Out-Null
$installed = Join-Path $sandbox "Programs\OrcStrator"; New-Item -ItemType Directory -Path $installed -Force | Out-Null
try {
    Write-Host "== Data root ==" -ForegroundColor Cyan
    $lad = Join-Path $sandbox "lad"; $me = Join-Path $sandbox "me"; $scr = Join-Path $sandbox "scratch"
    $d = Resolve-OrcDataRoot -Root $gitco -Override "" -LocalAppData $lad -UserProfile $me
    Check "git checkout -> %USERPROFILE%\.orcstrator-v2 (unchanged)" ($d -eq "$me\.orcstrator-v2") "got $d"
    $d = Resolve-OrcDataRoot -Root $installed -Override "" -LocalAppData $lad -UserProfile $me
    Check "installed copy -> %LOCALAPPDATA%\OrcStrator" ($d -eq "$lad\OrcStrator") "got $d"
    $d = Resolve-OrcDataRoot -Root $installed -Override $scr -LocalAppData $lad -UserProfile $me
    Check "ORCSTRATOR_DATA_DIR wins (installed)" ($d -eq $scr) "got $d"
    $d = Resolve-OrcDataRoot -Root $gitco -Override $scr -LocalAppData $lad -UserProfile $me
    Check "ORCSTRATOR_DATA_DIR wins (checkout)" ($d -eq $scr) "got $d"

    Write-Host "`n== This repo checkout keeps the developer path ==" -ForegroundColor Cyan
    $repo = Split-Path -Parent $PSScriptRoot
    Check "repo root has .git" (Test-Path (Join-Path $repo ".git"))
    Check "Test-OrcArtifactMode is false here, with a real key and URL" (-not (Test-OrcArtifactMode -RepoPath $repo -BaseUrl "https://x" -PublicKeyXml @('<RSAKeyValue/>')))
    $real = Resolve-OrcDataRoot -Root $repo -Override "" -LocalAppData $env:LOCALAPPDATA -UserProfile $env:USERPROFILE
    Check "and its data root is still %USERPROFILE%\.orcstrator-v2" ($real -eq (Join-Path $env:USERPROFILE ".orcstrator-v2")) "got $real"
    $runSetup = (Get-Fn 'Run-Setup').Extent.Text
    Check "Run-Setup sends ONLY artifact mode to the installed path" ($runSetup -match 'if \(\$script:ArtifactMode\) \{ Invoke-OrcInstalledLaunch')
    Check "developer path still runs git pull, npm install and the dev server" ($runSetup -match 'Invoke-OrcBootPull' -and (Get-Fn 'Invoke-OrcBootPull').Extent.Text -match 'pull --ff-only' -and $runSetup -match 'Run-Cmd \$npm "install"' -and $runSetup -match 'npm run dev')

    Write-Host "`n== Installed path never touches developer tooling ==" -ForegroundColor Cyan
    $installedFns = @('Invoke-OrcInstalledLaunch', 'Start-OrcInstalledServer', 'Resolve-OrcClaude', 'Install-OrcClaudeNative',
                      'Test-OrcClaudeLoggedIn', 'Resolve-OrcServerPort', 'Stop-OrcOwnedServer', 'Invoke-OrcArtifactUpdate',
                      'Get-OrcStagedManifest', 'Get-OrcUpdateManifest', 'Install-OrcRelease')
    $text = ($installedFns | ForEach-Object { (Get-Fn $_).Body.Extent.Text }) -join "`n"
    # Strip comments so a comment that EXPLAINS the rule does not trip it.
    $tokens = $null
    [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$null) | Out-Null
    $code = ($tokens | Where-Object { $_.Kind -ne 'Comment' } | ForEach-Object { $_.Text }) -join ' '
    foreach ($bad in @('winget', 'Find-Exe "git"', 'Find-Exe "npm', 'npm ', 'npm.cmd', 'BuildTools', 'VisualStudio', 'Run-Cmd', 'Refresh-EnvPath', 'Invoke-GitRetry', 'OpenJS.NodeJS')) {
        Check "installed path has no '$bad'" ($code.IndexOf($bad, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)
    }
}
finally {
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
