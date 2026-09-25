<#
.SYNOPSIS
    Stage, zip, hash and sign an OrcStrator release payload.
.DESCRIPTION
    Assumes `npm run build` has
    already run. Produces, in -OutDir:

        orcstrator-<version>.zip   the payload
        <channel>.json             signed manifest envelope the launcher fetches

    Signing is skipped (with a loud warning) when no private key is supplied,
    so the packaging half can be exercised locally without the CI secret.
.EXAMPLE
    powershell -File installer\release\Build-Release.ps1 -Version 2.1.0 -OutDir dist-release
#>
param(
    [Parameter(Mandatory)][string]$Version,
    [string]$OutDir = "dist-release",
    [string]$Channel = "stable",
    [string]$GitSha = "",
    [string]$BuiltAt = "",
    [string]$BaseUrl = "",
    [string]$PrivateKeyXml = $env:ORC_RELEASE_PRIVATE_KEY,
    [int]$MinDbSchema = 0,
    # Ship a production node_modules. Only safe when the payload also pins the
    # Node runtime (phase 4): native modules are bound to a Node ABI, and a
    # user's PATH Node can be any version. Without a bundled runtime, leave this off and let
    # the launcher run `npm ci --omit=dev` after extracting.
    [switch]$IncludeNodeModules,
    # Phase 4: ship a verified node.exe so the payload runs on a known ABI and
    # the installer no longer has to winget Node onto the user's machine.
    # Implies -IncludeNodeModules: bundling a runtime without the modules built
    # for it gains nothing.
    [string]$BundleNodeVersion = "",
    # Optional installer .exe built for this release. Recorded in the signed
    # manifest (installer = { file, size, sha256 }) so the Worker can serve it
    # at /download/latest. CI uploads it to R2 as <version>/<file>.
    [string]$InstallerPath = "",
    # Build OrcStrator-Setup-<version>.exe (installer/release/Build-Installer.ps1)
    # around the zip and its signed payload manifest, then record it in the
    # signed channel manifest. Needs Inno Setup (ISCC.exe).
    [switch]$BuildInstaller,
    [string]$IsccPath = "",
    # TEST BUILDS ONLY (see Build-Installer.ps1). Refused unless the version
    # is a throwaway one ending in -local or -test.
    [string]$TestOnlyLauncherPublicKeyXml = "",
    # Release config (update URL + trusted public keys) written into the
    # PACKAGED launcher copies; see the release-config notes in release-lib.ps1.
    # Default: installer\release\official-release.config.json when it exists.
    # Without one the packaged launcher has updates OFF. A signed, non-test
    # build refuses to run without one (its users could never update).
    [string]$ReleaseConfigPath = "",
    # Package with updates OFF even if the default release config exists.
    [switch]$NoReleaseConfig,
    # Personal-string gate term list (one regex per line). Default:
    # installer\release\personal-denylist.txt. Missing or empty = the build
    # fails (the gate is fail-closed).
    [string]$DenylistPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "release-lib.ps1")

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Write-Host "Repo:    $RepoRoot"
if ($TestOnlyLauncherPublicKeyXml -and $Version -notmatch '-(local|test)(\.\d+)?$') {
    throw "-TestOnlyLauncherPublicKeyXml is for throwaway builds only; the version must end in -local or -test (got $Version)."
}
if ($BuildInstaller -and $InstallerPath) { throw "Pass -BuildInstaller or -InstallerPath, not both." }
Write-Host "Version: $Version  Channel: $Channel"

# --- gate inputs, checked before any work ----------------------------------
if (-not $DenylistPath) { $DenylistPath = Join-Path $PSScriptRoot "personal-denylist.txt" }
$personalPatterns = Get-OrcPersonalPatterns -Path $DenylistPath
$allowedAuthors = Get-OrcPersonalAllowedAuthors -Path $DenylistPath
Write-Host "Personal-string denylist: $($personalPatterns.Count) pattern(s)"

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
    # A signed release is meant to be installed and to update itself. Its
    # launcher must trust the key it is signed with, or no installed copy
    # could ever verify it.
    if (-not $releaseConfig) {
        throw "A signed release needs a release config (update URL + public keys); none was found. Pass -ReleaseConfigPath, or build unsigned."
    }
    $norm = { param($x) $r = New-Object System.Security.Cryptography.RSACryptoServiceProvider; try { $r.FromXmlString($x); $r.ToXmlString($false) } finally { $r.Dispose() } }
    $signPub = & $norm (Get-OrcPublicKeyXml -PrivateKeyXml $PrivateKeyXml)
    $trusted = @($releaseConfig.ReleasePublicKeys | ForEach-Object { & $norm $_ })
    if ($trusted -notcontains $signPub) {
        throw "The signing key's public half is not in the release config's releasePublicKeys. Installed launchers would reject this release."
    }
}
if ($releaseConfig) {
    Write-Host "Release config: updates from $($releaseConfig.UpdateBaseUrl), $($releaseConfig.ReleasePublicKeys.Count) trusted key(s)"
} else {
    Write-Warning "No release config: the packaged launcher has updates OFF (no update URL, no trusted key)."
}

# --- required build output ------------------------------------------------
$required = @(
    "shared\dist",
    "client\dist\index.html",
    "server\dist\index.js"
)
foreach ($rel in $required) {
    if (-not (Test-Path (Join-Path $RepoRoot $rel))) {
        throw "Missing build output: $rel. Run 'npm run build' first."
    }
}

if (-not $GitSha) {
    try { $GitSha = ((& git -C $RepoRoot rev-parse --short HEAD) -join "").Trim() } catch { $GitSha = "unknown" }
}
if (-not $BuiltAt) { $BuiltAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

# The ABI of the Node that BUILT any native modules. The launcher refuses a
# payload whose ABI does not match the Node it is about to run it on.
$nodeAbi = 0
try { $nodeAbi = [int](((& node -p "process.versions.modules") -join "").Trim()) } catch { }
if ($nodeAbi -le 0) { throw "Could not determine the Node ABI (is node on PATH?)" }
Write-Host "Node ABI: $nodeAbi"

# --- stage ----------------------------------------------------------------
$OutDirFull = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $RepoRoot $OutDir }
$stage = Join-Path $OutDirFull "stage-$Version"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path $OutDirFull -Force | Out-Null

function Copy-Into {
    param([string]$Rel, [string]$DestRel = $null)
    $src = Join-Path $RepoRoot $Rel
    if (-not (Test-Path $src)) { throw "Cannot stage missing path: $Rel" }
    $dest = Join-Path $stage ($(if ($DestRel) { $DestRel } else { $Rel }))
    $destParent = Split-Path -Parent $dest
    if ($destParent -and -not (Test-Path $destParent)) { New-Item -ItemType Directory -Path $destParent -Force | Out-Null }
    Copy-Item $src $dest -Recurse -Force
    Write-Host "  staged $Rel"
}

Write-Host "Staging payload..."
# shared and server are recompiled straight into the stage with their
# tsconfig.release.json (removeComments, no source or declaration maps), so no
# code comment ships. The dev build and `npm run dev` are untouched: they keep
# using tsconfig.json and write to their own dist folders as before.
$tscJs = Join-Path $RepoRoot "node_modules\typescript\bin\tsc"
if (-not (Test-Path $tscJs)) { throw "TypeScript compiler not found at $tscJs. Run 'npm install' first." }
foreach ($pkg in @("shared", "server")) {
    $cfg = Join-Path $RepoRoot "$pkg\tsconfig.release.json"
    & node $tscJs -p $cfg --outDir (Join-Path $stage "$pkg\dist")
    if ($LASTEXITCODE -ne 0) { throw "Release compile of $pkg failed (tsc exit $LASTEXITCODE)" }
    Write-Host "  compiled $pkg\dist (release: no comments, no maps)"
}
Copy-Into "client\dist"
Copy-Into "package.json"
Copy-Into "package-lock.json"
Copy-Into "shared\package.json"
Copy-Into "server\package.json"
Copy-Into "client\package.json"
Copy-Into "installer\setup.ps1"
# The source launcher carries no update URL and no trusted key. OrcStrator.exe
# runs the ACTIVE payload's launcher, so the payload copy must get the same
# release config as the installer's copy, or the app would stop updating the
# moment it takes over.
$stagedSetup = Join-Path $stage "installer\setup.ps1"
$t = [System.IO.File]::ReadAllText($stagedSetup)
if ($releaseConfig) {
    $t = Set-OrcLauncherReleaseConfig -SetupText $t -PublicKeyXml $releaseConfig.ReleasePublicKeys -UpdateBaseUrl $releaseConfig.UpdateBaseUrl
}
if ($TestOnlyLauncherPublicKeyXml) {
    # A throwaway build's payload copy must trust the same test key as the
    # installer's copy, or its own staged/update manifests would fail
    # verification once it takes over.
    $t = Set-OrcLauncherTestKey -SetupText $t -PublicKeyXml $TestOnlyLauncherPublicKeyXml
    Write-Warning "TEST BUILD: the payload's launcher trusts a test key, not the release key."
}
[System.IO.File]::WriteAllText($stagedSetup, $t, (New-Object System.Text.UTF8Encoding($false)))
$shippedTrust = Get-OrcLauncherTrust -SetupText $t
if ($releaseConfig -and ($shippedTrust.UpdateBaseUrl -ne $releaseConfig.UpdateBaseUrl)) { throw "The packaged launcher's update URL does not match the release config" }
Write-Host "  launcher: $($shippedTrust.ReleasePublicKeys.Count) trusted key(s), update URL '$($shippedTrust.UpdateBaseUrl)'"
if (Test-Path (Join-Path $RepoRoot "installer\icon.ico")) { Copy-Into "installer\icon.ico" }
# The shipped root package.json keeps its dependency lists (package-lock.json
# must stay in sync with them) but drops the developer scripts: nothing in a
# payload runs them, and "prepare" would fire during the stage's npm ci.
$stagedPkgPath = Join-Path $stage "package.json"
$stagedPkg = [System.IO.File]::ReadAllText($stagedPkgPath) | ConvertFrom-Json
if ($stagedPkg.PSObject.Properties['scripts']) { $stagedPkg.PSObject.Properties.Remove('scripts') }
Write-OrcJsonFile -Path $stagedPkgPath -Json ($stagedPkg | ConvertTo-Json -Depth 10)

$bundleRuntime = [bool]$BundleNodeVersion
if ($bundleRuntime) { $IncludeNodeModules = $true }

if ($IncludeNodeModules) {
    # A PRODUCTION install made inside the stage, never a copy of the repo's
    # node_modules: that one holds devDependencies and workspace junctions
    # that point back at the full source tree (TypeScript, docs and all).
    # Only the server's runtime dependencies are needed; the client and
    # shared ship prebuilt.
    Write-Host "  installing production node_modules in the stage (ABI $nodeAbi) ..."
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
    if (-not $npm) { throw "npm not found on PATH" }
    Push-Location $stage
    # npm writes warnings to stderr; under "Stop" PowerShell 5.1 would turn the
    # first one into a terminating error. The exit code is what counts.
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $npmOut = & $npm.Source ci --omit=dev --workspace=server --workspace=shared --no-audit --no-fund 2>&1
        $npmExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $eap; Pop-Location }
    if ($npmExit -ne 0) { throw "npm ci --omit=dev failed in the stage: $(($npmOut | Select-Object -Last 15) -join ' | ')" }
    # npm links workspaces as junctions into the stage. Replace them with real
    # copies of what the app resolves at runtime (@orcstrator/shared); a zip
    # cannot hold a junction, and an extracted payload must not depend on one.
    $scope = Join-Path $stage "node_modules\@orcstrator"
    if (Test-Path $scope) {
        foreach ($link in @(Get-ChildItem $scope -Force)) {
            # Directory.Delete on a junction removes the link, never the target.
            [System.IO.Directory]::Delete($link.FullName, $false)
        }
        $sharedDest = Join-Path $scope "shared"
        New-Item -ItemType Directory -Path $sharedDest -Force | Out-Null
        Copy-Item (Join-Path $stage "shared\package.json") $sharedDest
        Copy-Item (Join-Path $stage "shared\dist") (Join-Path $sharedDest "dist") -Recurse
    }
    $links = @(Get-ChildItem $stage -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)
    if ($links.Count -gt 0) { throw "Stage still contains $($links.Count) link(s), e.g. $($links[0].FullName)" }
    if (-not (Test-Path (Join-Path $stage "node_modules\better-sqlite3"))) { throw "Production install is missing better-sqlite3" }
}

if ($bundleRuntime) {
    Write-Host "Bundling Node $BundleNodeVersion runtime..."
    $rt = Join-Path $stage "runtime"
    $exe = Get-OrcNodeRuntime -NodeVersion $BundleNodeVersion -DestDir $rt
    # The bundled runtime's ABI is what the payload actually runs on, so it
    # must match the Node that compiled the native modules being shipped.
    $bundledAbi = [int](((& $exe -p "process.versions.modules") -join "").Trim())
    if ($bundledAbi -ne $nodeAbi) {
        throw "Bundled Node $BundleNodeVersion has ABI $bundledAbi but node_modules were built against ABI $nodeAbi. Build with that Node version instead."
    }
    Write-Host "  bundled runtime ABI $bundledAbi matches the build"
}

# version.json travels INSIDE the payload so an installed copy can always say
# what it is, even if the manifest that delivered it is long gone.
$versionJson = [ordered]@{
    version           = $Version
    channel           = $Channel
    gitSha            = $GitSha
    builtAt           = $BuiltAt
    nodeAbi           = $nodeAbi
    minDbSchema       = $MinDbSchema
    bundledNodeModules = [bool]$IncludeNodeModules
    bundledRuntime     = $bundleRuntime
}
Write-OrcJsonFile -Path (Join-Path $stage "version.json") -Json ($versionJson | ConvertTo-Json -Depth 6)

# --- personal-string gate -------------------------------------------------
# Every app file in the stage (dist, package.json files, launcher, version.json)
# is scanned for personal strings that must never ship. Third-party
# node_modules and the bundled runtime are skipped. Hits are reported as file,
# pattern and line number only, never the surrounding text.
Write-Host "Personal-string gate..."
$gateHits = @(Find-OrcPersonalStrings -Root $stage -Patterns $personalPatterns -AllowedAuthors $allowedAuthors)
if ($gateHits.Count -gt 0) {
    foreach ($h in $gateHits) { Write-Host "  GATE HIT  $($h.File)  pattern '$($h.Pattern)'  line(s) $($h.Lines)" -ForegroundColor Red }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    throw "Personal-string gate FAILED: $($gateHits.Count) hit(s) in the payload. Fix the source, then rebuild."
}
$stageRoot = (Get-Item $stage).FullName.TrimEnd('\')
$gateScanned = @(Get-ChildItem $stageRoot -Recurse -File -Force | Where-Object {
    $r = $_.FullName.Substring($stageRoot.Length + 1); -not ($r -like 'node_modules\*' -or $r -like 'runtime\*')
}).Count
Write-Host "  PASS: 0 hits across $gateScanned app file(s)" -ForegroundColor Green

# --- zip ------------------------------------------------------------------
$zipName = "orcstrator-$Version.zip"
$zipPath = Join-Path $OutDirFull $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Write-Host "Compressing to $zipName ..."
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

# Entries are added by hand rather than via CreateFromDirectory because that
# API writes BACKSLASH separators on .NET Framework, which the ZIP spec
# forbids (4.4.17.1 requires forward slashes). Windows tolerates it; other
# extractors produce files literally named "server\dist\index.js".
#
# Dropped from the payload: *.d.ts and *.map. Nothing executes them, they are
# roughly half the entry count, and the maps embed original source paths.
$excluded = 0
$zipStream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $stageFull = (Get-Item $stage).FullName.TrimEnd('\')
        # %TEMP% can be an 8.3 short path (C:\Users\RUNNER~1\...). Resolve-Path
        # keeps the short spelling while Get-ChildItem returns long names, so
        # the prefix must come from Get-Item (long form) or every entry name
        # is garbled.
        foreach ($f in (Get-ChildItem $stageFull -Recurse -File -Force)) {
            $rel = $f.FullName.Substring($stageFull.Length + 1).Replace('\', '/')
            # No TypeScript (declarations or sources that some packages ship),
            # no source maps, and no docs/ or .git/ folders from third-party
            # packages. Nothing at runtime loads any of them.
            if ($f.Extension -in @('.map', '.ts', '.tsx', '.mts', '.cts')) { $excluded++; continue }
            if (('/' + $rel) -match '/(docs|\.git)/') { $excluded++; continue }
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose() }
} finally { $zipStream.Dispose() }
Write-Host "  excluded $excluded TypeScript/sourcemap/docs files"
Remove-Item $stage -Recurse -Force

$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "Payload: $zipPath ($sizeMb MB)"

# --- manifest + signature -------------------------------------------------
# The Worker serves payloads at /download/<version>/<file>.zip (R2 key
# <version>/<file>.zip). The bucket itself stays private, so the URL must go
# through the Worker's /download/ route, not the bare key.
$url = if ($BaseUrl) { "$($BaseUrl.TrimEnd('/'))/download/$Version/$zipName" } else { "" }

function Write-OrcManifestFile {
    param($Manifest, [string]$Path)
    if ($PrivateKeyXml) {
        $envelope = New-OrcSignedManifest -Manifest $Manifest -PrivateKeyXml $PrivateKeyXml
        Write-OrcJsonFile -Path $Path -Json ($envelope | ConvertTo-Json -Depth 12)
        Write-Host "Signed manifest: $Path" -ForegroundColor Green
    } else {
        Write-Warning "No private key (ORC_RELEASE_PRIVATE_KEY unset). Writing an UNSIGNED manifest: $Path"
        Write-Warning "The launcher will REJECT this. For local packaging checks only."
        Write-OrcJsonFile -Path $Path -Json (
            [ordered]@{ manifest = $Manifest; signature = ""; alg = "unsigned" } | ConvertTo-Json -Depth 12)
    }
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
$payloadManifest = New-OrcManifest -Version $Version -ZipPath $zipPath -GitSha $GitSha `
                            -BuiltAt $BuiltAt -NodeAbi $nodeAbi -MinDbSchema $MinDbSchema `
                            -Channel $Channel -Url $url -BundledRuntime $bundleRuntime
$payloadManifestPath = Join-Path $OutDirFull "manifest.json"
Write-OrcManifestFile -Manifest $payloadManifest -Path $payloadManifestPath

if ($BuildInstaller) {
    if (-not $PrivateKeyXml) { throw "-BuildInstaller needs a signing key: an installer around an unsigned manifest could never install." }
    $biArgs = @{ Version = $Version; ZipPath = $zipPath; ManifestPath = $payloadManifestPath; OutDir = $OutDirFull; DenylistPath = $DenylistPath }
    if ($releaseConfig) { $biArgs.ReleaseConfigPath = $ReleaseConfigPath }
    if ($IsccPath) { $biArgs.IsccPath = $IsccPath }
    if ($TestOnlyLauncherPublicKeyXml) { $biArgs.TestOnlyLauncherPublicKeyXml = $TestOnlyLauncherPublicKeyXml }
    $InstallerPath = @(& (Join-Path $PSScriptRoot "Build-Installer.ps1") @biArgs)[-1]
    if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) { throw "Build-Installer did not produce an installer" }
}

$manifest = New-OrcManifest -Version $Version -ZipPath $zipPath -GitSha $GitSha `
                            -BuiltAt $BuiltAt -NodeAbi $nodeAbi -MinDbSchema $MinDbSchema `
                            -Channel $Channel -Url $url -BundledRuntime $bundleRuntime `
                            -InstallerPath $InstallerPath
$manifestPath = Join-Path $OutDirFull "$Channel.json"
Write-OrcManifestFile -Manifest $manifest -Path $manifestPath

Write-Host ""
Write-Host "sha256: $($manifest.sha256)"
Write-Host "Done."
