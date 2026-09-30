<#
.SYNOPSIS
    Sign an OrcStrator release payload that Build-Release.ps1 -PackageOnly made.
.DESCRIPTION
    The second half of a release. Build-Release.ps1 -PackageOnly
    runs in a job that ran `npm ci` and holds no secret; it leaves
    orcstrator-<version>.zip and release-inputs.json in -InputDir. This script
    runs in a DIFFERENT job, the only one that holds the signing key, and:

        1. checks release-inputs.json against the version and channel this
           run was started for (the file is unsigned, so it is not trusted)
        2. re-hashes the zip itself
        3. signs the PAYLOAD manifest (manifest.json, no installer field)
        4. optionally builds the installer around it (Inno Setup, csc; no
           package manager), and
        5. signs the CHANNEL manifest (<channel>.json) naming the installer.

    It never runs node, npm, npx or any package manager, and never executes
    anything from the zip. The private release workflow's own test enforces that.

    Build-Release.ps1 (without -PackageOnly) calls this script too, so a local
    full build and CI sign through the same code.
.EXAMPLE
    powershell -File installer\release\Sign-Release.ps1 -Version 2.2.0-beta.1 -Channel beta -InputDir unsigned -OutDir dist-release
#>
param(
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][string]$Channel,
    [Parameter(Mandatory)][string]$InputDir,
    [string]$OutDir = "",
    [string]$BaseUrl = "",
    # Overrides the commit recorded by the build job (CI passes github.sha).
    [string]$GitSha = "",
    [int]$ExpectNodeAbi = 0,
    # Handed over as a parameter, never read from the environment here.
    [string]$PrivateKeyXml = "",
    [switch]$BuildInstaller,
    [string]$IsccPath = "",
    [string]$InstallerPath = "",
    [string]$TestOnlyLauncherPublicKeyXml = "",
    [string]$ReleaseConfigPath = "",
    [switch]$NoReleaseConfig,
    [string]$DenylistPath = "",
    # Installed launchers treat a manifest as stale this many days
    # after it was built (0 = no expiry). Cut a release at least this often,
    # or launchers show "Could not check for updates" until the next one.
    [int]$ExpiresInDays = 180,
    # Set for a security release: from then on launchers refuse
    # any manifest for a version older than this (a replayed old release).
    [string]$MinVersion = "",
    # The build job's builtAt is signed and sets expiresAt, so it must be
    # recent and never in the future (a build job could otherwise push the
    # expiry out for decades).
    [int]$MaxBuildAgeHours = 72,
    # CI pins these from the workflow itself, never from release-inputs.json:
    # '' = not checked (local builds), 'true'/'false' = must match.
    [string]$ExpectBundledRuntime = "",
    [int]$ExpectMinDbSchema = -1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release-lib.ps1")

if ($BuildInstaller -and $InstallerPath) { throw "Pass -BuildInstaller or -InstallerPath, not both." }
if ($TestOnlyLauncherPublicKeyXml -and $Version -notmatch '-(local|test)(\.\d+)?$') {
    throw "-TestOnlyLauncherPublicKeyXml is for throwaway builds only; the version must end in -local or -test (got $Version)."
}
$InputDirFull = [System.IO.Path]::GetFullPath($InputDir)
$OutDirFull = if ($OutDir) { [System.IO.Path]::GetFullPath($OutDir) } else { $InputDirFull }
New-Item -ItemType Directory -Path $OutDirFull -Force | Out-Null

# --- release config and key, checked before any work -----------------------
$releaseConfig = $null
if ($NoReleaseConfig) {
    if ($ReleaseConfigPath) { throw "Pass -ReleaseConfigPath or -NoReleaseConfig, not both." }
} else {
    if (-not $ReleaseConfigPath) {
        $defaultCfg = Join-Path $PSScriptRoot "official-release.config.json"
        if (Test-Path -LiteralPath $defaultCfg) { $ReleaseConfigPath = $defaultCfg }
    }
    if ($ReleaseConfigPath) { $releaseConfig = Get-OrcReleaseConfig -Path $ReleaseConfigPath }
}
if ($PrivateKeyXml -and -not $TestOnlyLauncherPublicKeyXml) {
    Assert-OrcSigningKeyTrusted -PrivateKeyXml $PrivateKeyXml -ReleaseConfig $releaseConfig
}

# --- the hand-over from the build job ---------------------------------------
$inputs = Read-OrcReleaseInputs -Path (Join-Path $InputDirFull "release-inputs.json") `
            -Version $Version -Channel $Channel -ExpectNodeAbi $ExpectNodeAbi
$srcZip = Join-Path $InputDirFull $inputs.File
if (-not (Test-Path -LiteralPath $srcZip -PathType Leaf)) { throw "Payload $($inputs.File) is not in $InputDirFull" }
$zipPath = Join-Path $OutDirFull $inputs.File
if ($zipPath -ne $srcZip) { Copy-Item -LiteralPath $srcZip -Destination $zipPath -Force }
$builtUtc = [datetime]::ParseExact($inputs.BuiltAt, 'yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
$nowUtc = [datetime]::UtcNow
if ($builtUtc -gt $nowUtc.AddMinutes(10)) { throw "release inputs: builtAt $($inputs.BuiltAt) is in the future. Refusing to sign." }
if ($MaxBuildAgeHours -gt 0 -and $builtUtc -lt $nowUtc.AddHours(-$MaxBuildAgeHours)) { throw "release inputs: builtAt $($inputs.BuiltAt) is older than $MaxBuildAgeHours hours. Rebuild before signing." }
if ($ExpectBundledRuntime -and ([string]$inputs.BundledRuntime).ToLowerInvariant() -ne $ExpectBundledRuntime.ToLowerInvariant()) {
    throw "release inputs say bundledRuntime=$($inputs.BundledRuntime), the workflow built with $ExpectBundledRuntime. Refusing to sign."
}
if ($ExpectMinDbSchema -ge 0 -and $inputs.MinDbSchema -ne $ExpectMinDbSchema) {
    throw "release inputs say minDbSchema=$($inputs.MinDbSchema), the workflow expects $ExpectMinDbSchema. Refusing to sign."
}
if (-not $GitSha) { $GitSha = $inputs.GitSha }
if ($GitSha -and $GitSha -notmatch '^[0-9a-f]{7,40}$') { throw "GitSha '$GitSha' is not a commit id" }
if (-not $GitSha) { $GitSha = "unknown" }
Write-Host "Signing $Version ($Channel), payload $($inputs.File), sha256 $(Get-OrcFileHash $zipPath)"

# The Worker serves payloads at /download/<version>/<file>.zip; the bucket
# itself stays private.
$url = if ($BaseUrl) { "$($BaseUrl.TrimEnd('/'))/download/$Version/$($inputs.File)" } else { "" }

function Write-OrcManifestFile {
    param($Manifest, [string]$Path)
    if ($PrivateKeyXml) {
        $envelope = New-OrcSignedManifest -Manifest $Manifest -PrivateKeyXml $PrivateKeyXml
        Write-OrcJsonFile -Path $Path -Json ($envelope | ConvertTo-Json -Depth 12)
        Write-Host "Signed manifest: $Path" -ForegroundColor Green
    } else {
        Write-Warning "No private key. Writing an UNSIGNED manifest: $Path"
        Write-Warning "The launcher will REJECT this. For local packaging checks only."
        Write-OrcJsonFile -Path $Path -Json (
            [ordered]@{ manifest = $Manifest; signature = ""; alg = "unsigned" } | ConvertTo-Json -Depth 12)
    }
}

$common = @{
    Version = $Version; ZipPath = $zipPath; GitSha = $GitSha; BuiltAt = $inputs.BuiltAt
    NodeAbi = $inputs.NodeAbi; MinDbSchema = $inputs.MinDbSchema; Channel = $Channel; Url = $url
    BundledRuntime = $inputs.BundledRuntime
}
if ($ExpiresInDays -gt 0) {
    $built = [datetime]::ParseExact($inputs.BuiltAt, 'yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    $common.ExpiresAt = $built.AddDays($ExpiresInDays).ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture)
}
if ($MinVersion) {
    if ((Compare-OrcReleaseVersion $MinVersion $Version) -gt 0) { throw "MinVersion $MinVersion is newer than the release itself ($Version)" }
    $common.MinVersion = $MinVersion
}

# The installer chicken-and-egg, solved with two manifests signed by the same
# key over the same payload:
#
#   1. manifest.json  PAYLOAD manifest: version, zip sha256, ... and NO
#                     installer field. Signed first, then embedded in the
#                     installer .exe next to the zip, where the launcher's
#                     first run verifies it exactly like a network update.
#   2. <channel>.json CHANNEL manifest: the same fields PLUS
#                     installer = { file, size, sha256 } of the .exe that now
#                     exists. Signed second. This is what the Worker serves,
#                     and what lets anyone check a downloaded installer.
#
# The exe cannot contain its own hash, so it carries (1), never (2).
$payloadManifest = New-OrcManifest @common
$payloadManifestPath = Join-Path $OutDirFull "manifest.json"
Write-OrcManifestFile -Manifest $payloadManifest -Path $payloadManifestPath

if ($BuildInstaller) {
    if (-not $PrivateKeyXml) { throw "-BuildInstaller needs a signing key: an installer around an unsigned manifest could never install." }
    $biArgs = @{ Version = $Version; ZipPath = $zipPath; ManifestPath = $payloadManifestPath; OutDir = $OutDirFull }
    if ($DenylistPath) { $biArgs.DenylistPath = $DenylistPath }
    if ($releaseConfig) { $biArgs.ReleaseConfigPath = $ReleaseConfigPath }
    if ($IsccPath) { $biArgs.IsccPath = $IsccPath }
    if ($TestOnlyLauncherPublicKeyXml) { $biArgs.TestOnlyLauncherPublicKeyXml = $TestOnlyLauncherPublicKeyXml }
    # Authenticode: on when its settings exist, skipped with a
    # visible notice while they do not.
    $cs = Get-OrcCodeSigningConfig
    $csDir = $null
    if ($cs.Enabled) {
        $csDir = Join-Path ([System.IO.Path]::GetTempPath()) "orc-codesign-$([guid]::NewGuid().ToString('N').Substring(0,8))"
        $biArgs.CodeSign = New-OrcCodeSigningSetup -Config $cs -Dir $csDir
        Write-Host "Code signing: ON (account $($cs.Account), profile $($cs.Profile))" -ForegroundColor Green
    } else {
        Write-Host "::notice title=Installer not code-signed::Windows will show the SmartScreen warning for this installer. Code signing is skipped until these are set: $($cs.Missing -join ', ')"
        Write-Warning "Installer NOT code-signed (missing: $($cs.Missing -join ', '))."
    }
    try {
        $InstallerPath = @(& (Join-Path $PSScriptRoot "Build-Installer.ps1") @biArgs)[-1]
    } finally {
        if ($csDir) { Remove-Item $csDir -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) { throw "Build-Installer did not produce an installer" }
}

$manifest = New-OrcManifest @common -InstallerPath $InstallerPath
$manifestPath = Join-Path $OutDirFull "$Channel.json"
Write-OrcManifestFile -Manifest $manifest -Path $manifestPath

Write-Host ""
Write-Host "sha256: $($manifest.sha256)"
Write-Host "Done."
