<#
.SYNOPSIS
    Build OrcStrator-Setup-<version>.exe (Inno Setup) around a release payload.
.DESCRIPTION
    Called by Build-Release.ps1 -BuildInstaller once the payload zip and its
    SIGNED payload manifest (manifest.json, no installer field) exist. The
    installer carries:

        {app}\OrcStrator.exe            no-console starter (compiled here)
        {app}\installer\setup.ps1       the launcher, with the embedded public key
        {app}\installer\icon.ico
        {app}\EULA.txt, {app}\LICENSE
        {app}\staging\manifest.json     signed payload manifest
        {app}\staging\orcstrator-<v>.zip

    It never extracts a runnable app: the launcher installs the staged zip on
    first run through the same verifier as a network update.

    Refuses to build an installer whose staged manifest does not verify
    against the key(s) embedded in the launcher it ships, or whose zip does
    not match that manifest. Such an installer could never install anything.
#>
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$ZipPath,
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][string]$OutDir,
    [string]$IsccPath = "",
    # TEST BUILDS ONLY. Replaces the public key embedded in the SHIPPED COPY of
    # setup.ps1 (never the repo file) so a locally signed throwaway release can
    # be installed end to end. Build-Release.ps1 only passes it for a version
    # tagged -local or -test, and refuses to sign a non-test build whose
    # release config does not trust its signing key, so it cannot reach a
    # published release.
    [string]$TestOnlyLauncherPublicKeyXml = "",
    # Release config (update URL + trusted keys) written into the SHIPPED
    # copy of setup.ps1. Build-Release.ps1 passes the one it used for the
    # payload, so both launcher copies trust the same things.
    [string]$ReleaseConfigPath = "",
    # Personal-string gate term list. Missing or empty = the build fails.
    [string]$DenylistPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release-lib.ps1")

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$InstallerDir = Join-Path $RepoRoot "installer"

function Find-Iscc {
    param([string]$Hint)
    if ($Hint) { if (Test-Path $Hint) { return $Hint } else { throw "ISCC not found at $Hint" } }
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @(
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"))) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    throw "Inno Setup (ISCC.exe) not found. Install it: winget install JRSoftware.InnoSetup"
}

if (-not $DenylistPath) { $DenylistPath = Join-Path $PSScriptRoot "personal-denylist.txt" }
$personalPatterns = Get-OrcPersonalPatterns -Path $DenylistPath
$allowedAuthors = Get-OrcPersonalAllowedAuthors -Path $DenylistPath
$releaseConfig = if ($ReleaseConfigPath) { Get-OrcReleaseConfig -Path $ReleaseConfigPath } else { $null }

$iscc = Find-Iscc $IsccPath
Write-Host "Installer: ISCC at $iscc"

# --- the staged release must be one the shipped launcher will accept ---------
$envelope = [System.IO.File]::ReadAllText($ManifestPath) | ConvertFrom-Json
if ($envelope.alg -ne 'RS256' -or -not $envelope.signature) {
    throw "Payload manifest $ManifestPath is not signed. An installer built around it could never install."
}
if ($envelope.manifest.PSObject.Properties['installer']) {
    throw "Payload manifest must not carry an installer field (that belongs to the channel manifest, signed after the exe exists)."
}
if ($envelope.manifest.version -ne $Version) { throw "Manifest is for $($envelope.manifest.version), not $Version" }
if ($envelope.manifest.file -ne [System.IO.Path]::GetFileName($ZipPath)) { throw "Manifest names $($envelope.manifest.file), not $([System.IO.Path]::GetFileName($ZipPath))" }
if (-not (Test-OrcPayload -ZipPath $ZipPath -Manifest $envelope.manifest)) { throw "Zip does not match the signed manifest's size/sha256" }

# --- stage ------------------------------------------------------------------
$OutDirFull = [System.IO.Path]::GetFullPath($OutDir)
$work = Join-Path $OutDirFull "installer-stage-$Version"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
$launcher = Join-Path $work "launcher"
$staging = Join-Path $work "staging"
New-Item -ItemType Directory -Path (Join-Path $launcher "installer") -Force | Out-Null
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$setupText = [System.IO.File]::ReadAllText((Join-Path $InstallerDir "setup.ps1"))
if ($releaseConfig) {
    $setupText = Set-OrcLauncherReleaseConfig -SetupText $setupText -PublicKeyXml $releaseConfig.ReleasePublicKeys -UpdateBaseUrl $releaseConfig.UpdateBaseUrl
}
if ($TestOnlyLauncherPublicKeyXml) {
    $setupText = Set-OrcLauncherTestKey -SetupText $setupText -PublicKeyXml $TestOnlyLauncherPublicKeyXml
    Write-Warning "TEST BUILD: the shipped launcher trusts a test key, not the release key."
}
[System.IO.File]::WriteAllText((Join-Path $launcher "installer\setup.ps1"), $setupText, (New-Object System.Text.UTF8Encoding($false)))
Copy-Item (Join-Path $InstallerDir "icon.ico") (Join-Path $launcher "installer\icon.ico")
Copy-Item (Join-Path $InstallerDir "EULA.txt") (Join-Path $launcher "EULA.txt")
if (Test-Path (Join-Path $RepoRoot "LICENSE")) { Copy-Item (Join-Path $RepoRoot "LICENSE") (Join-Path $launcher "LICENSE") }
Copy-Item $ManifestPath (Join-Path $staging "manifest.json")
Copy-Item $ZipPath (Join-Path $staging ([System.IO.Path]::GetFileName($ZipPath)))

# The keys the SHIPPED launcher trusts, read from the staged file itself, so
# the check below tests exactly what goes into the exe.
$ast = [System.Management.Automation.Language.Parser]::ParseInput($setupText, [ref]$null, [ref]$null)
$assign = $ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$script:ReleasePublicKeys'
}, $true) | Select-Object -First 1
if (-not $assign) { throw "Shipped setup.ps1 has no `$script:ReleasePublicKeys" }
$shippedKeys = @(& ([scriptblock]::Create("$($assign.Right.Extent.Text)")))
if ($shippedKeys.Count -eq 0) { throw "Shipped setup.ps1 embeds no public key" }
if (-not (Test-OrcSignedManifest -Envelope $envelope -PublicKeyXml $shippedKeys)) {
    throw "The staged manifest does NOT verify against the public key embedded in the shipped launcher. Refusing to build an installer that could never install."
}
Write-Host "  staged manifest verifies against the shipped launcher's key" -ForegroundColor Green

# --- no-console starter -----------------------------------------------------
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "csc.exe (.NET Framework 4) not found" }
$exeOut = Join-Path $launcher "OrcStrator.exe"
# Native tools may write to stderr; the exit code is what counts.
$ErrorActionPreference = 'Continue'
$cscOut = & $csc /nologo /target:winexe /optimize+ /debug- /platform:anycpu `
    "/win32icon:$(Join-Path $InstallerDir 'icon.ico')" "/out:$exeOut" (Join-Path $InstallerDir "starter\OrcStrator.cs") 2>&1
$cscExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($cscExit -ne 0 -or -not (Test-Path $exeOut)) { throw "Starter compile failed: $($cscOut -join ' ')" }
Write-Host "  compiled OrcStrator.exe starter"

# --- personal-string gate over everything the installer ships ----------------
# The zip was already gated by Build-Release; this covers the launcher files
# (setup.ps1, EULA, LICENSE, the starter) and the staged manifest.
Write-Host "Personal-string gate (launcher files)..."
$hits = @(Find-OrcPersonalStrings -Root $launcher -Patterns $personalPatterns -AllowedAuthors $allowedAuthors)
$manifestText = [System.IO.File]::ReadAllText((Join-Path $staging "manifest.json"))
foreach ($p in $personalPatterns) {
    if ([regex]::IsMatch($manifestText, $p.Regex, 'IgnoreCase')) {
        $hits += [pscustomobject]@{ File = 'staging\manifest.json'; Pattern = $p.Name; Lines = '?' }
    }
}
if ($hits.Count -gt 0) {
    foreach ($h in $hits) { Write-Host "  GATE HIT  $($h.File)  pattern '$($h.Pattern)'  line(s) $($h.Lines)" -ForegroundColor Red }
    throw "Personal-string gate FAILED on the installer's launcher files: $($hits.Count) hit(s)."
}
$scanned = @(Get-ChildItem $launcher -Recurse -File).Count + 1
Write-Host "  PASS: 0 hits across $scanned launcher file(s)" -ForegroundColor Green

# --- compile ------------------------------------------------------------------
$numeric = ($Version -replace '[-+].*$', '')
if ($numeric -notmatch '^\d+(\.\d+){0,3}$') { $numeric = "0.0.0" }
$issPath = Join-Path $InstallerDir "OrcStrator.iss"
$ErrorActionPreference = 'Continue'
$isccOut = & $iscc /Q "/DAppVersion=$Version" "/DNumericVersion=$numeric" "/DStageDir=$work" "/DOutputDir=$OutDirFull" $issPath 2>&1
$isccExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($isccExit -ne 0) { throw "ISCC failed (exit $isccExit): $($isccOut -join ' | ')" }
$exe = Join-Path $OutDirFull "OrcStrator-Setup-$Version.exe"
if (-not (Test-Path $exe)) { throw "ISCC reported success but $exe is missing" }
Remove-Item $work -Recurse -Force

$mb = [Math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "Installer: $exe ($mb MB)" -ForegroundColor Green
Write-Output $exe
