# The artifact updater (install, update, rollback). Drives the REAL artifact
# updater from setup.ps1 (AST-extracted) against a REAL local HTTP server
# serving a REAL signed payload. No mocks of the crypto or the transport.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-artifact-update.ps1
#
# Covers the attack paths as well as the happy path: unsigned manifest,
# manifest signed by the wrong key, tampered payload bytes, withdrawn release,
# ABI mismatch, and rollback after a version fails to boot.

param([int]$Port = 3411)

# Order matters. release-lib provides the CI-side signing helpers, but it also
# defines its own Test-OrcSignedManifest / Test-OrcPayload / canonical-JSON.
# Load it FIRST, keep a handle on its verifier for the drift cross-check, then
# AST-load setup.ps1 so the LAUNCHER'S copies are the ones under test.
. (Join-Path $PSScriptRoot "release\release-lib.ps1")
$LibVerify = ${function:Test-OrcSignedManifest}
# release-lib turns strict mode on; the launcher does not run under it, and the
# test should mirror the launcher.
Set-StrictMode -Off

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
$want = @(
    'Log','Find-Exe','Get-LauncherState','Save-LauncherState','Set-LauncherStateValue',
    'ConvertTo-OrcCanonicalJson','Test-OrcSignedManifest','Test-OrcPayload','Compare-OrcVersion',
    'Get-OrcInstallRoot','Get-OrcActiveVersion','Set-OrcActiveVersion','Get-OrcVersionPath',
    'Get-OrcUpdateChannel','Get-OrcUpdateManifest','Get-OrcStagedManifest','ConvertFrom-OrcSignedManifestText','Install-OrcRelease','Remove-OrcOldVersions','Invoke-OrcRollback',
    'Get-OrcDownload','Invoke-OrcArtifactUpdate','Confirm-OrcHealthyBoot','Test-OrcArtifactMode','Get-OrcUpdateSkipReason',
    'Get-OrcBundledNode','Get-OrcNodePath'
)
foreach ($name in $want) {
    $fn = $ast.FindAll({ param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name
    }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $name in setup.ps1" }
    Invoke-Expression $fn.Extent.Text
}
# Log writes to a file in the launcher; keep the test quiet.
function Log { param([string]$Msg) if ($env:ORC_TEST_VERBOSE) { Write-Host "    [log] $Msg" -ForegroundColor DarkGray } }

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$sandbox   = Join-Path $env:TEMP "orc-artifact-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$serveDir  = Join-Path $sandbox "serve"
$root      = Join-Path $sandbox "install"
$StateFile = Join-Path $sandbox "launcher-state.json"     # used by Get/Set-LauncherStateValue
$ServerPort = 3334
New-Item -ItemType Directory -Path $serveDir -Force | Out-Null
New-Item -ItemType Directory -Path $root -Force | Out-Null

$key      = New-OrcSigningKey -Bits 2048
$wrongKey = New-OrcSigningKey -Bits 2048
$localAbi = [int](& node -p "process.versions.modules")
$listener = $null

function New-TestPayload {
    # A minimal but structurally REAL payload: Install-OrcRelease insists on
    # server/dist/index.js existing, which is the check that catches a
    # truncated or wrong-shaped archive.
    param([string]$Version, [string]$Marker = "")
    $stage = Join-Path $sandbox "stage-$Version"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $stage "server\dist") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stage "client\dist") -Force | Out-Null
    Set-Content (Join-Path $stage "server\dist\index.js") "// orcstrator $Version $Marker" -Encoding UTF8
    Set-Content (Join-Path $stage "client\dist\index.html") "<html><body>$Version</body></html>" -Encoding UTF8
    Set-Content (Join-Path $stage "version.json") (@{ version = $Version } | ConvertTo-Json) -Encoding UTF8
    $zip = Join-Path $serveDir "orcstrator-$Version.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
    Remove-Item $stage -Recurse -Force
    return $zip
}

function Publish-Manifest {
    param([string]$Version, [string]$Zip, $SigningKey = $key, [int]$Abi = $localAbi,
          [bool]$Blocked = $false, [switch]$Unsigned)
    $m = New-OrcManifest -Version $Version -ZipPath $Zip -GitSha "deadbee" `
                         -BuiltAt "2026-07-25T00:00:00Z" -NodeAbi $Abi -Blocked $Blocked `
                         -Url "http://localhost:$Port/$([System.IO.Path]::GetFileName($Zip))"
    $envelope = if ($Unsigned) {
        [ordered]@{ manifest = $m; signature = ""; alg = "unsigned" }
    } else {
        New-OrcSignedManifest -Manifest $m -PrivateKeyXml $SigningKey.PrivateXml
    }
    # BOM-free, exactly like Build-Release.ps1 does it.
    Write-OrcJsonFile -Path (Join-Path $serveDir "stable.json") -Json ($envelope | ConvertTo-Json -Depth 12)
    return $envelope
}

try {
    # --- a real HTTP server, so Invoke-WebRequest is genuinely exercised ---
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$Port/")
    $listener.Start()
    $ctxTask = $null
    $pump = {
        while ($listener.IsListening) {
            try {
                $ctx = $listener.GetContext()
                $name = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
                $file = Join-Path $serveDir $name
                if ($name -and (Test-Path $file)) {
                    $bytes = [System.IO.File]::ReadAllBytes($file)
                    $ctx.Response.StatusCode = 200
                    # Match what R2 will serve (the release workflow sets these
                    # explicitly). Content-Type decides whether PowerShell hands
                    # the launcher a string or a byte array.
                    $ctx.Response.ContentType = if ($name -like '*.json') { 'application/json' } else { 'application/zip' }
                    $ctx.Response.ContentLength64 = $bytes.Length
                    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $ctx.Response.StatusCode = 404
                }
                $ctx.Response.Close()
            } catch { break }
        }
    }
    $ps = [powershell]::Create()
    $ps.Runspace = [runspacefactory]::CreateRunspace(); $ps.Runspace.Open()
    $ps.Runspace.SessionStateProxy.SetVariable('listener', $listener)
    $ps.Runspace.SessionStateProxy.SetVariable('serveDir', $serveDir)
    $ps.AddScript($pump.ToString()) | Out-Null
    $async = $ps.BeginInvoke()
    Start-Sleep -Milliseconds 300
    Write-Host "Test update server on http://localhost:$Port/  root=$root`n" -ForegroundColor DarkGray

    Write-Host "== Compare-OrcVersion ==" -ForegroundColor Cyan
    Check "2.1.0 > 2.0.9" ((Compare-OrcVersion "2.1.0" "2.0.9") -eq 1)
    Check "2.0.9 < 2.1.0" ((Compare-OrcVersion "2.0.9" "2.1.0") -eq -1)
    Check "equal versions" ((Compare-OrcVersion "2.1.0" "2.1.0") -eq 0)
    Check "2.10.0 > 2.9.0 (not string order)" ((Compare-OrcVersion "2.10.0" "2.9.0") -eq 1)
    Check "3.0.0 > 2.99.99" ((Compare-OrcVersion "3.0.0" "2.99.99") -eq 1)
    Check "prerelease sorts before its release" ((Compare-OrcVersion "2.1.0-beta.1" "2.1.0") -eq -1)
    Check "release beats its prerelease" ((Compare-OrcVersion "2.1.0" "2.1.0-beta.1") -eq 1)
    Check "2.1 == 2.1.0 (padded)" ((Compare-OrcVersion "2.1" "2.1.0") -eq 0)
    # Semver prerelease precedence, identifier by identifier. The old text
    # comparison had beta.9 > beta.10, which would refuse every beta after 9.
    Check "2.1.0-beta.10 > 2.1.0-beta.9 (numeric identifier)" ((Compare-OrcVersion "2.1.0-beta.10" "2.1.0-beta.9") -eq 1)
    Check "2.1.0-beta.9 < 2.1.0-beta.10" ((Compare-OrcVersion "2.1.0-beta.9" "2.1.0-beta.10") -eq -1)
    Check "2.1.0 > 2.1.0-beta.10 (release beats prerelease)" ((Compare-OrcVersion "2.1.0" "2.1.0-beta.10") -eq 1)
    Check "2.1.0-beta.10 < 2.1.0" ((Compare-OrcVersion "2.1.0-beta.10" "2.1.0") -eq -1)
    Check "2.1.1-beta.1 > 2.1.0 (core wins over prerelease)" ((Compare-OrcVersion "2.1.1-beta.1" "2.1.0") -eq 1)
    Check "2.1.0 < 2.1.1-beta.1" ((Compare-OrcVersion "2.1.0" "2.1.1-beta.1") -eq -1)
    Check "2.1.1-beta.2 > 2.1.1-beta.1" ((Compare-OrcVersion "2.1.1-beta.2" "2.1.1-beta.1") -eq 1)
    Check "equal prereleases: 2.1.0-beta.10 == 2.1.0-beta.10" ((Compare-OrcVersion "2.1.0-beta.10" "2.1.0-beta.10") -eq 0)
    Check "equal releases: 2.1.1 == 2.1.1" ((Compare-OrcVersion "2.1.1" "2.1.1") -eq 0)
    Check "build metadata ignored: 2.1.0+abc == 2.1.0+def" ((Compare-OrcVersion "2.1.0+abc" "2.1.0+def") -eq 0)
    Check "numeric identifier sorts below alphanumeric (1 < alpha)" ((Compare-OrcVersion "2.1.0-1" "2.1.0-alpha") -eq -1)
    Check "alpha < beta (ASCII order)" ((Compare-OrcVersion "2.1.0-alpha" "2.1.0-beta") -eq -1)
    Check "more identifiers wins when the shared ones tie (beta.1.1 > beta.1)" ((Compare-OrcVersion "2.1.0-beta.1.1" "2.1.0-beta.1") -eq 1)
    Check "beta.1 < beta.1.1" ((Compare-OrcVersion "2.1.0-beta.1" "2.1.0-beta.1.1") -eq -1)
    Check "leading zeros do not beat magnitude (beta.010 > beta.9)" ((Compare-OrcVersion "2.1.0-beta.010" "2.1.0-beta.9") -eq 1)
    Check "huge numeric identifier does not overflow" ((Compare-OrcVersion "2.1.0-beta.99999999999999999999" "2.1.0-beta.9") -eq 1)
    Check "semver 11.4 chain in order" ((@('1.0.0-alpha','1.0.0-alpha.1','1.0.0-alpha.beta','1.0.0-beta','1.0.0-beta.2','1.0.0-beta.11','1.0.0-rc.1','1.0.0') |
        ForEach-Object -Begin { $prev = $null; $okChain = $true } -Process { if ($prev -and (Compare-OrcVersion $_ $prev) -ne 1) { $okChain = $false }; $prev = $_ } -End { $okChain }))

    Write-Host "`n== Test-OrcArtifactMode (phase 3 switch) ==" -ForegroundColor Cyan
    $gitish = Join-Path $sandbox "gitco"; New-Item -ItemType Directory -Path (Join-Path $gitish ".git") -Force | Out-Null
    $plain  = Join-Path $sandbox "plain"; New-Item -ItemType Directory -Path $plain -Force | Out-Null
    Check "a git checkout never uses artifacts" (-not (Test-OrcArtifactMode -RepoPath $gitish -BaseUrl "http://x" -PublicKeyXml @($key.PublicXml)))
    Check "a plain install with url+key does" (Test-OrcArtifactMode -RepoPath $plain -BaseUrl "http://x" -PublicKeyXml @($key.PublicXml))
    Check "no url -> stays on git" (-not (Test-OrcArtifactMode -RepoPath $plain -BaseUrl "" -PublicKeyXml @($key.PublicXml)))
    Check "no public key -> stays on git" (-not (Test-OrcArtifactMode -RepoPath $plain -BaseUrl "http://x" -PublicKeyXml @()))

    Write-Host "`n== The trust anchor embedded in setup.ps1 ==" -ForegroundColor Cyan
    # Evaluate the launcher's own assignments rather than restating them here,
    # so this checks what actually ships.
    function Invoke-SetupAssignment([string]$Left) {
        $a = $ast.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq $Left
        }, $true) | Select-Object -First 1
        if (-not $a) { throw "Could not find assignment $Left in setup.ps1" }
        Invoke-Expression $a.Extent.Text
    }
    # SOURCE copy: no trusted key and no update URL, so a build from source
    # (even one without .git, like a ZIP download) never checks for updates.
    Invoke-SetupAssignment '$script:ReleasePublicKeys'
    $embedded = @($script:ReleasePublicKeys)
    Check "source setup.ps1 trusts no release key" ($embedded.Count -eq 0) "got $($embedded.Count)"
    Invoke-SetupAssignment '$script:DefaultUpdateBaseUrl'
    Check "source setup.ps1 has no update URL" ($script:DefaultUpdateBaseUrl -eq '') "got '$script:DefaultUpdateBaseUrl'"
    Check "a source copy without .git stays OFF the artifact updater" (-not (Test-OrcArtifactMode -RepoPath $plain -BaseUrl $script:DefaultUpdateBaseUrl -PublicKeyXml $embedded))
    $savedUrl = $env:ORC_UPDATE_BASE_URL
    try {
        $env:ORC_UPDATE_BASE_URL = ''
        Invoke-SetupAssignment '$script:UpdateBaseUrl'
        Check "no env var -> the default (empty) URL" ($script:UpdateBaseUrl -eq $script:DefaultUpdateBaseUrl) "got $script:UpdateBaseUrl"
        $env:ORC_UPDATE_BASE_URL = 'http://localhost:9'
        Invoke-SetupAssignment '$script:UpdateBaseUrl'
        Check "ORC_UPDATE_BASE_URL overrides it" ($script:UpdateBaseUrl -eq 'http://localhost:9') "got $script:UpdateBaseUrl"
        Check "a URL alone, with no trusted key, still stays OFF" (-not (Test-OrcArtifactMode -RepoPath $plain -BaseUrl $script:UpdateBaseUrl -PublicKeyXml $embedded))
    } finally { $env:ORC_UPDATE_BASE_URL = $savedUrl }

    # RELEASE copy: what a release build writes into its packaged launcher.
    $relText = Set-OrcLauncherReleaseConfig -SetupText ([System.IO.File]::ReadAllText($SetupPath)) `
                   -PublicKeyXml @($key.PublicXml) -UpdateBaseUrl 'https://updates.example.com'
    $rel = Get-OrcLauncherTrust -SetupText $relText
    Check "release copy trusts exactly the configured key" ((@($rel.ReleasePublicKeys).Count -eq 1) -and ($rel.ReleasePublicKeys[0] -eq $key.PublicXml))
    Check "release copy has the configured update URL" ($rel.UpdateBaseUrl -eq 'https://updates.example.com') "got '$($rel.UpdateBaseUrl)'"
    Check "release copy still parses cleanly" ($null -ne [System.Management.Automation.Language.Parser]::ParseInput($relText, [ref]$null, [ref]$null))
    $relAst = [System.Management.Automation.Language.Parser]::ParseInput($relText, [ref]$null, [ref]$null)
    Check "only the two assignments changed (every function is still there)" (
        @($relAst.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)).Count -eq
        @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)).Count)
    Check "release copy (no .git) uses the artifact updater" (Test-OrcArtifactMode -RepoPath $plain -BaseUrl $rel.UpdateBaseUrl -PublicKeyXml $rel.ReleasePublicKeys)
    # With a key AND a URL, .git is the only thing keeping a developer
    # checkout off the artifact path. Prove it still does.
    Check "release key + URL still leave a .git checkout on git" (-not (Test-OrcArtifactMode -RepoPath $gitish -BaseUrl $rel.UpdateBaseUrl -PublicKeyXml $rel.ReleasePublicKeys))
    Check "the real repo checkout stays on git" (-not (Test-OrcArtifactMode -RepoPath (Split-Path -Parent $PSScriptRoot) -BaseUrl $rel.UpdateBaseUrl -PublicKeyXml $rel.ReleasePublicKeys))
    $threw = $false
    try { Set-OrcLauncherReleaseConfig -SetupText "# no anchors here" -PublicKeyXml @($key.PublicXml) -UpdateBaseUrl 'https://updates.example.com' | Out-Null } catch { $threw = $true }
    Check "release config injection refuses a launcher without its anchors" $threw
    $threw = $false
    try { Set-OrcLauncherReleaseConfig -SetupText ([System.IO.File]::ReadAllText($SetupPath)) -PublicKeyXml @($key.PrivateXml) -UpdateBaseUrl 'https://updates.example.com' | Out-Null } catch { $threw = $true }
    Check "release config injection refuses a PRIVATE key" $threw

    Write-Host "`n== The launcher's verifier must not drift from release-lib's ==" -ForegroundColor Cyan
    # setup.ps1 carries its own copy of the crypto because a verifier cannot be
    # dot-sourced from the payload it verifies. Two copies means they can
    # diverge, and the failure mode is "nothing CI signs will ever install".
    $zipX = New-TestPayload -Version "1.0.0"
    $envX = Publish-Manifest -Version "1.0.0" -Zip $zipX
    $roundTripped = (Get-Content (Join-Path $serveDir "stable.json") -Raw -Encoding UTF8) | ConvertFrom-Json
    Check "launcher verifier accepts a release-lib signature" (Test-OrcSignedManifest -Envelope $roundTripped -PublicKeyXml @($key.PublicXml))
    Check "release-lib verifier agrees" (& $LibVerify -Envelope $roundTripped -PublicKeyXml @($key.PublicXml))
    Check "both reject the wrong key identically" (
        ((Test-OrcSignedManifest -Envelope $roundTripped -PublicKeyXml @($wrongKey.PublicXml)) -eq $false) -and
        ((& $LibVerify -Envelope $roundTripped -PublicKeyXml @($wrongKey.PublicXml)) -eq $false))

    Write-Host "`n== A BOM in the served manifest must not break parsing ==" -ForegroundColor Cyan
    # PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM. Over HTTP the
    # raw bytes reach ConvertFrom-Json and it dies with "Invalid JSON
    # primitive". Local tests hide this because Get-Content -Raw strips it.
    ($envX | ConvertTo-Json -Depth 12) | Set-Content (Join-Path $serveDir "stable.json") -Encoding UTF8
    $bomBytes = [System.IO.File]::ReadAllBytes((Join-Path $serveDir "stable.json"))
    Check "the fixture really has a BOM" ($bomBytes[0] -eq 239 -and $bomBytes[1] -eq 187 -and $bomBytes[2] -eq 191)
    $m = Get-OrcUpdateManifest -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "manifest still parses and verifies" ($null -ne $m -and $m.version -eq '1.0.0') "reject reason: $script:UpdateRejectReason"

    Write-Host "`n== Build-Release writes NO bom ==" -ForegroundColor Cyan
    Publish-Manifest -Version "1.0.0" -Zip $zipX | Out-Null
    $clean = [System.IO.File]::ReadAllBytes((Join-Path $serveDir "stable.json"))
    Check "Write-OrcJsonFile emits no BOM" (-not ($clean[0] -eq 239 -and $clean[1] -eq 187 -and $clean[2] -eq 191))
    $m = Get-OrcUpdateManifest -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "BOM-free manifest verifies" ($null -ne $m) "reject reason: $script:UpdateRejectReason"

    Write-Host "`n== Happy path: fresh install ==" -ForegroundColor Cyan
    $zip1 = New-TestPayload -Version "2.0.0"
    Publish-Manifest -Version "2.0.0" -Zip $zip1 | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "update applied" ($r.Updated) $r.Reason
    Check "active version is 2.0.0" ((Get-OrcActiveVersion $root) -eq '2.0.0') "got $(Get-OrcActiveVersion $root)"
    Check "payload extracted" (Test-Path (Join-Path (Get-OrcVersionPath $root '2.0.0') "server\dist\index.js"))

    Write-Host "`n== Upgrade 2.0.0 -> 2.1.0 ==" -ForegroundColor Cyan
    $zip2 = New-TestPayload -Version "2.1.0" -Marker "second"
    Publish-Manifest -Version "2.1.0" -Zip $zip2 | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "upgrade applied" ($r.Updated) $r.Reason
    Check "active version is 2.1.0" ((Get-OrcActiveVersion $root) -eq '2.1.0')
    Check "previousVersion recorded for rollback" ((Get-LauncherState).previousVersion -eq '2.0.0') "got $((Get-LauncherState).previousVersion)"
    Check "old version kept as rollback target" (Test-Path (Get-OrcVersionPath $root '2.0.0'))

    Write-Host "`n== Re-running when already current is a no-op ==" -ForegroundColor Cyan
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "no update applied" (-not $r.Updated)
    Check "reason says up to date" ($r.Reason -match 'up to date') "got '$($r.Reason)'"
    Check "still on 2.1.0" ((Get-OrcActiveVersion $root) -eq '2.1.0')

    Write-Host "`n== Downgrade is refused ==" -ForegroundColor Cyan
    Publish-Manifest -Version "2.0.0" -Zip $zip1 | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "older manifest does not downgrade us" (-not $r.Updated) $r.Reason
    Check "still on 2.1.0" ((Get-OrcActiveVersion $root) -eq '2.1.0')

    Write-Host "`n== SECURITY: manifest signed by the wrong key ==" -ForegroundColor Cyan
    $zip3 = New-TestPayload -Version "3.0.0" -Marker "evil"
    Publish-Manifest -Version "3.0.0" -Zip $zip3 -SigningKey $wrongKey | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "rejected" (-not $r.Updated)
    Check "reason names the signature" ($r.Reason -match 'SIGNATURE') "got '$($r.Reason)'"
    Check "did NOT install the attacker payload" (-not (Test-Path (Get-OrcVersionPath $root '3.0.0')))
    Check "still on 2.1.0" ((Get-OrcActiveVersion $root) -eq '2.1.0')

    Write-Host "`n== SECURITY: unsigned manifest ==" -ForegroundColor Cyan
    Publish-Manifest -Version "3.0.0" -Zip $zip3 -Unsigned | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "rejected" (-not $r.Updated) $r.Reason
    Check "still on 2.1.0" ((Get-OrcActiveVersion $root) -eq '2.1.0')

    Write-Host "`n== SECURITY: valid signature, tampered payload bytes ==" -ForegroundColor Cyan
    # The realistic CDN-compromise case: the manifest is authentic, but the
    # zip that gets served has been swapped.
    Publish-Manifest -Version "3.0.0" -Zip $zip3 | Out-Null
    $bytes = [System.IO.File]::ReadAllBytes($zip3)
    $bytes[[int]($bytes.Length / 2)] = [byte](($bytes[[int]($bytes.Length / 2)] + 7) % 256)
    [System.IO.File]::WriteAllBytes($zip3, $bytes)
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "rejected" (-not $r.Updated)
    Check "reason names the hash" ($r.Reason -match 'HASH MISMATCH') "got '$($r.Reason)'"
    Check "did NOT extract it" (-not (Test-Path (Get-OrcVersionPath $root '3.0.0')))
    Check "still on 2.1.0" ((Get-OrcActiveVersion $root) -eq '2.1.0')

    Write-Host "`n== Kill switch: blocked release ==" -ForegroundColor Cyan
    $zip4 = New-TestPayload -Version "3.1.0"
    Publish-Manifest -Version "3.1.0" -Zip $zip4 -Blocked $true | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "withdrawn release is refused" (-not $r.Updated)
    Check "reason says withdrawn" ($r.Reason -match 'withdrawn') "got '$($r.Reason)'"

    Write-Host "`n== Node ABI mismatch is caught before install ==" -ForegroundColor Cyan
    Publish-Manifest -Version "3.2.0" -Zip (New-TestPayload -Version "3.2.0") -Abi ($localAbi + 1) | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "ABI mismatch refused" (-not $r.Updated)
    Check "reason names the ABI" ($r.Reason -match 'ABI') "got '$($r.Reason)'"
    Check "did NOT install it" (-not (Test-Path (Get-OrcVersionPath $root '3.2.0')))

    Write-Host "`n== Misconfiguration fails closed ==" -ForegroundColor Cyan
    Publish-Manifest -Version "3.3.0" -Zip (New-TestPayload -Version "3.3.0") | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @()
    Check "no embedded public key -> refuse" (-not $r.Updated)
    Check "reason names the missing key" ($r.Reason -match 'public key') "got '$($r.Reason)'"
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "" -PublicKeyXml @($key.PublicXml)
    Check "no update URL -> refuse" (-not $r.Updated)
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$($Port+7)" -PublicKeyXml @($key.PublicXml)
    Check "unreachable server -> refuse, no crash" (-not $r.Updated) $r.Reason
    Check "still on 2.1.0 after every failure" ((Get-OrcActiveVersion $root) -eq '2.1.0')

    Write-Host "`n== Rollback after a version fails to boot ==" -ForegroundColor Cyan
    $back = Confirm-OrcHealthyBoot -Root $root -Healthy $false
    Check "rolled back to 2.0.0" ($back -eq '2.0.0') "got '$back'"
    Check "active version is now 2.0.0" ((Get-OrcActiveVersion $root) -eq '2.0.0')
    Check "the failed version is recorded" ((Get-LauncherState).failedVersion -eq '2.1.0') "got $((Get-LauncherState).failedVersion)"
    Check "the failed payload is still on disk for diagnosis" (Test-Path (Get-OrcVersionPath $root '2.1.0'))

    Write-Host "`n== Healthy boot arms the next rollback ==" -ForegroundColor Cyan
    $ok = Confirm-OrcHealthyBoot -Root $root -Healthy $true
    Check "healthy boot returns the active version" ($ok -eq '2.0.0')
    Check "lastHealthyVersion recorded" ((Get-LauncherState).lastHealthyVersion -eq '2.0.0')
    # The rollback target booting fine says nothing about 2.1.0.
    Check "failedVersion KEPT when the rollback target (older) boots" ((Get-LauncherState).failedVersion -eq '2.1.0') "got '$((Get-LauncherState).failedVersion)'"

    Write-Host "`n== A version that failed to boot is not re-offered ==" -ForegroundColor Cyan
    Check "skip reason: the failed version itself" ((Get-OrcUpdateSkipReason -Candidate '2.1.0' -Current '2.0.0' -Failed '2.1.0') -match 'failed to start')
    Check "skip reason: anything older than the failed version" ((Get-OrcUpdateSkipReason -Candidate '2.1.0-beta.3' -Current '2.0.0' -Failed '2.1.0') -match 'failed to start')
    Check "no skip: strictly newer than the failed version" ((Get-OrcUpdateSkipReason -Candidate '2.1.1' -Current '2.0.0' -Failed '2.1.0') -eq '')
    Check "no skip: nothing failed" ((Get-OrcUpdateSkipReason -Candidate '2.1.0' -Current '2.0.0' -Failed '') -eq '')
    Check "up to date still wins" ((Get-OrcUpdateSkipReason -Candidate '2.0.0' -Current '2.0.0' -Failed '2.1.0') -eq 'already up to date')
    Check "reads failedVersion from launcher state when not passed" ((Get-OrcUpdateSkipReason -Candidate '2.1.0' -Current '2.0.0') -match 'failed to start')
    Publish-Manifest -Version "2.1.0" -Zip $zip2 | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "the failed 2.1.0 is NOT auto-applied again" (-not $r.Updated) $r.Reason
    Check "reason names the failed boot" ($r.Reason -match 'failed to start') "got '$($r.Reason)'"
    Check "still on the rollback target 2.0.0" ((Get-OrcActiveVersion $root) -eq '2.0.0')
    $zip211 = New-TestPayload -Version "2.1.1" -Marker "fixed"
    Publish-Manifest -Version "2.1.1" -Zip $zip211 | Out-Null
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "a strictly newer 2.1.1 IS applied" ($r.Updated -and (Get-OrcActiveVersion $root) -eq '2.1.1') $r.Reason
    $ok = Confirm-OrcHealthyBoot -Root $root -Healthy $true
    Check "healthy boot of 2.1.1 clears failedVersion" ([string]((Get-LauncherState).failedVersion) -eq '') "got '$((Get-LauncherState).failedVersion)'"
    Set-OrcActiveVersion -Root $root -Version "2.0.0"

    Write-Host "`n== Phase 4: bundled Node runtime ==" -ForegroundColor Cyan
    $noRt = Get-OrcVersionPath $root '2.0.0'
    Check "no runtime in the payload -> null" ($null -eq (Get-OrcBundledNode -VersionPath $noRt))
    Check "Get-OrcNodePath falls back to PATH node" ((Get-OrcNodePath -VersionPath $noRt) -match 'node')
    New-Item -ItemType Directory -Path (Join-Path $noRt "runtime") -Force | Out-Null
    Copy-Item (Find-Exe "node") (Join-Path $noRt "runtime\node.exe") -Force
    $bundled = Get-OrcBundledNode -VersionPath $noRt
    Check "a bundled runtime is found" ($null -ne $bundled) "got '$bundled'"
    Check "Get-OrcNodePath PREFERS the bundled runtime" ((Get-OrcNodePath -VersionPath $noRt) -eq $bundled) "got $(Get-OrcNodePath -VersionPath $noRt)"
    Check "null version path is safe" ($null -eq (Get-OrcBundledNode -VersionPath $null))

    Write-Host "`n== A bundled-runtime payload skips the local ABI check ==" -ForegroundColor Cyan
    # The whole point of shipping a runtime is not caring what Node the user
    # has, so an ABI that differs from this machine's must NOT block it.
    Set-OrcActiveVersion -Root $root -Version "2.0.0"
    $zipRt = New-TestPayload -Version "4.0.0"
    $mRt = New-OrcManifest -Version "4.0.0" -ZipPath $zipRt -GitSha "deadbee" `
                           -BuiltAt "2026-07-25T00:00:00Z" -NodeAbi ($localAbi + 5) `
                           -BundledRuntime $true `
                           -Url "http://localhost:$Port/orcstrator-4.0.0.zip"
    Write-OrcJsonFile -Path (Join-Path $serveDir "stable.json") `
                      -Json ((New-OrcSignedManifest -Manifest $mRt -PrivateKeyXml $key.PrivateXml) | ConvertTo-Json -Depth 12)
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl "http://localhost:$Port" -PublicKeyXml @($key.PublicXml)
    Check "mismatched ABI is allowed when a runtime is bundled" ($r.Updated) $r.Reason
    Check "installed 4.0.0" ((Get-OrcActiveVersion $root) -eq '4.0.0')

    Write-Host "`n== current.txt survives a truncated write ==" -ForegroundColor Cyan
    Set-OrcActiveVersion -Root $root -Version "2.1.0"
    Check "round trips" ((Get-OrcActiveVersion $root) -eq '2.1.0')
    Set-Content (Join-Path $root "current.txt") "" -Encoding UTF8
    Check "an empty current.txt reads as no version" ($null -eq (Get-OrcActiveVersion $root))
    Remove-Item (Join-Path $root "current.txt") -Force
    Check "a missing current.txt reads as no version" ($null -eq (Get-OrcActiveVersion $root))
}
finally {
    if ($listener) { try { $listener.Stop(); $listener.Close() } catch { } }
    if ($ps) { try { $ps.Dispose() } catch { } }
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
