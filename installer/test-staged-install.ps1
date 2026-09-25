# First install from the installer's STAGED release (installer plan s4.5).
# The installer ships the release zip plus its signed payload manifest in
# {app}\staging; the launcher installs it through Invoke-OrcArtifactUpdate
# -StagedDir, i.e. the SAME manifest verifier, sha256 check, extract and
# current.txt flip as a network update. Tampering must be refused.
#
# Real crypto (release-lib signs, the launcher's own copy verifies), real
# zips, the REAL functions from setup.ps1 (AST-extracted). No network.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-staged-install.ps1

. (Join-Path $PSScriptRoot "release\release-lib.ps1")
Set-StrictMode -Off

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
foreach ($name in @('Find-Exe', 'Get-LauncherState', 'Save-LauncherState', 'Set-LauncherStateValue',
                    'ConvertTo-OrcCanonicalJson', 'Test-OrcSignedManifest', 'Test-OrcPayload', 'Compare-OrcVersion',
                    'Get-OrcInstallRoot', 'Get-OrcActiveVersion', 'Set-OrcActiveVersion', 'Get-OrcVersionPath',
                    'Get-OrcUpdateChannel', 'Get-OrcUpdateManifest', 'Get-OrcStagedManifest', 'ConvertFrom-OrcSignedManifestText',
                    'Install-OrcRelease', 'Remove-OrcOldVersions', 'Get-OrcDownload', 'Invoke-OrcArtifactUpdate', 'Get-OrcUpdateSkipReason')) {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
    if (-not $fn) { throw "Could not find function $name in setup.ps1" }
    Invoke-Expression $fn.Extent.Text
}
function Log { param([string]$Msg) if ($env:ORC_TEST_VERBOSE) { Write-Host "    [log] $Msg" -ForegroundColor DarkGray } }

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$sandbox = Join-Path $env:TEMP "orc-staged-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$root = Join-Path $sandbox "data\app"
$StateFile = Join-Path $sandbox "data\launcher-state.json"
New-Item -ItemType Directory -Path $root -Force | Out-Null
$key = New-OrcSigningKey -Bits 2048
$wrongKey = New-OrcSigningKey -Bits 2048
$unreachable = "http://localhost:9"   # proves no network is involved

function New-Staged {
    <# A staging folder exactly as the installer lays it out: zip + signed payload manifest. #>
    param([string]$Name, [string]$Version, [string]$Channel = 'beta', $SigningKey = $key, [string]$FileOverride = "")
    $dir = Join-Path $sandbox "staging-$Name"
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $stage = Join-Path $sandbox "build-$Name"
    New-Item -ItemType Directory -Path (Join-Path $stage "server\dist"), (Join-Path $stage "client\dist") -Force | Out-Null
    Set-Content (Join-Path $stage "server\dist\index.js") "// $Version" -Encoding UTF8
    Set-Content (Join-Path $stage "client\dist\index.html") "<html>$Version</html>" -Encoding UTF8
    $zip = Join-Path $dir "orcstrator-$Version.zip"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
    Remove-Item $stage -Recurse -Force
    $m = New-OrcManifest -Version $Version -ZipPath $zip -GitSha "deadbee" -BuiltAt "2026-09-24T00:00:00Z" `
                         -NodeAbi 127 -Channel $Channel -BundledRuntime $true
    if ($FileOverride) { $m.file = $FileOverride }
    $env = New-OrcSignedManifest -Manifest $m -PrivateKeyXml $SigningKey.PrivateXml
    Write-OrcJsonFile -Path (Join-Path $dir "manifest.json") -Json ($env | ConvertTo-Json -Depth 12)
    return $dir
}

try {
    Write-Host "== First install from the staged release ==" -ForegroundColor Cyan
    $s1 = New-Staged -Name "v1" -Version "2.1.0"
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s1
    Check "installed from staging with no network" ($r.Updated) $r.Reason
    Check "active version is 2.1.0" ((Get-OrcActiveVersion $root) -eq '2.1.0')
    Check "payload extracted to versions\2.1.0" (Test-Path (Join-Path (Get-OrcVersionPath $root '2.1.0') "server\dist\index.js"))
    Check "the staged zip is left for the installer to own" (Test-Path (Join-Path $s1 "orcstrator-2.1.0.zip"))
    Check "result carries the manifest's channel" ($r.Channel -eq 'beta') "got $($r.Channel)"

    Write-Host "`n== Relaunch with the same staged release is a no-op ==" -ForegroundColor Cyan
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s1
    Check "not reinstalled" (-not $r.Updated -and $r.Reason -match 'up to date') $r.Reason

    Write-Host "`n== A newer installer upgrades; an older one never downgrades ==" -ForegroundColor Cyan
    $s2 = New-Staged -Name "v2" -Version "2.2.0"
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s2
    Check "newer staged release installed" ($r.Updated -and (Get-OrcActiveVersion $root) -eq '2.2.0') $r.Reason
    Check "previousVersion recorded for rollback" ((Get-LauncherState).previousVersion -eq '2.1.0')
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s1
    Check "older staged release refused" (-not $r.Updated -and (Get-OrcActiveVersion $root) -eq '2.2.0') $r.Reason

    Write-Host "`n== SECURITY: tampered staged zip ==" -ForegroundColor Cyan
    $fresh = Join-Path $sandbox "fresh-zip\app"
    $s3 = New-Staged -Name "tz" -Version "3.0.0"
    $z = Join-Path $s3 "orcstrator-3.0.0.zip"
    $b = [System.IO.File]::ReadAllBytes($z); $i = [int]($b.Length / 2); $b[$i] = [byte](($b[$i] + 1) % 256)
    [System.IO.File]::WriteAllBytes($z, $b)
    $r = Invoke-OrcArtifactUpdate -Root $fresh -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s3
    Check "refused" (-not $r.Updated)
    Check "reason names the hash" ($r.Reason -match 'HASH MISMATCH') "got '$($r.Reason)'"
    Check "nothing installed, no active version" (-not (Test-Path (Get-OrcVersionPath $fresh '3.0.0')) -and -not (Get-OrcActiveVersion $fresh))

    Write-Host "`n== SECURITY: tampered staged manifest (one byte) ==" -ForegroundColor Cyan
    $s4 = New-Staged -Name "tm" -Version "3.0.0"
    $mp = Join-Path $s4 "manifest.json"
    $t = [System.IO.File]::ReadAllText($mp)
    $t2 = $t.Replace('"3.0.0"', '"3.0.1"')
    Check "fixture really changed" ($t2 -ne $t)
    [System.IO.File]::WriteAllText($mp, $t2, (New-Object System.Text.UTF8Encoding($false)))
    $r = Invoke-OrcArtifactUpdate -Root $fresh -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s4
    Check "refused" (-not $r.Updated)
    Check "reason names the signature" ($r.Reason -match 'SIGNATURE') "got '$($r.Reason)'"
    Check "nothing installed" (-not (Get-OrcActiveVersion $fresh))

    Write-Host "`n== SECURITY: staged manifest signed by another key ==" -ForegroundColor Cyan
    $s5 = New-Staged -Name "wk" -Version "3.0.0" -SigningKey $wrongKey
    $r = Invoke-OrcArtifactUpdate -Root $fresh -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s5
    Check "refused (signature)" (-not $r.Updated -and $r.Reason -match 'SIGNATURE') "got '$($r.Reason)'"

    Write-Host "`n== SECURITY: unsigned staged manifest ==" -ForegroundColor Cyan
    $s6 = New-Staged -Name "us" -Version "3.0.0"
    $u = Get-Content (Join-Path $s6 "manifest.json") -Raw | ConvertFrom-Json
    $u.signature = ""; $u.alg = "unsigned"
    Write-OrcJsonFile -Path (Join-Path $s6 "manifest.json") -Json ($u | ConvertTo-Json -Depth 12)
    $r = Invoke-OrcArtifactUpdate -Root $fresh -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s6
    Check "refused" (-not $r.Updated -and $r.Reason -match 'SIGNATURE') "got '$($r.Reason)'"

    Write-Host "`n== SECURITY: no embedded key means nothing installs ==" -ForegroundColor Cyan
    $r = Invoke-OrcArtifactUpdate -Root $fresh -BaseUrl $unreachable -PublicKeyXml @() -StagedDir $s1
    Check "refused with an empty key list" (-not $r.Updated -and $r.Reason -match 'public key') "got '$($r.Reason)'"

    Write-Host "`n== A signed manifest may only name a file INSIDE the staging folder ==" -ForegroundColor Cyan
    $s7 = New-Staged -Name "pt" -Version "3.0.0" -FileOverride "..\outside.zip"
    $r = Invoke-OrcArtifactUpdate -Root $fresh -BaseUrl $unreachable -PublicKeyXml @($key.PublicXml) -StagedDir $s7
    Check "path in the file name refused" (-not $r.Updated -and $r.Reason -match 'invalid file') "got '$($r.Reason)'"

    Write-Host "`n== The staged path uses the SAME verifier as a network update ==" -ForegroundColor Cyan
    $body = (Get-Command Invoke-OrcArtifactUpdate).Definition
    Check "Invoke-OrcArtifactUpdate reads staged manifests via Get-OrcStagedManifest" ($body -match 'Get-OrcStagedManifest')
    Check "staged and network manifests share ConvertFrom-OrcSignedManifestText" (
        ((Get-Command Get-OrcStagedManifest).Definition -match 'ConvertFrom-OrcSignedManifestText') -and
        ((Get-Command Get-OrcUpdateManifest).Definition -match 'ConvertFrom-OrcSignedManifestText'))
    Check "the zip goes through Test-OrcPayload and Install-OrcRelease on both paths" ($body -match 'Test-OrcPayload' -and $body -match 'Install-OrcRelease')
}
finally {
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
