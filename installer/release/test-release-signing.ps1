# Round-trip tests for the release signing chain. This is the part of the
# update pipeline where a mistake means shipping attacker-controlled code to
# every install, so it gets adversarial cases, not just a happy path.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\release\test-release-signing.ps1

. (Join-Path $PSScriptRoot "release-lib.ps1")

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$tmp = Join-Path $env:TEMP "orc-sign-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
    Write-Host "`n== Key generation ==" -ForegroundColor Cyan
    # 2048 here purely so the suite runs fast; production uses the 4096 default.
    $key = New-OrcSigningKey -Bits 2048
    $other = New-OrcSigningKey -Bits 2048
    Check "private key is XML" ($key.PrivateXml -match '<RSAKeyValue>' -and $key.PrivateXml -match '<D>')
    Check "public key is XML" ($key.PublicXml -match '<RSAKeyValue>')
    Check "public key does NOT contain the private exponent" ($key.PublicXml -notmatch '<D>') "public key leaked private material"

    Write-Host "`n== Manifest over a real payload ==" -ForegroundColor Cyan
    $zip = Join-Path $tmp "orcstrator-2.1.0.zip"
    [System.IO.File]::WriteAllBytes($zip, [byte[]](1..5000 | ForEach-Object { $_ % 256 }))
    $man = New-OrcManifest -Version "2.1.0" -ZipPath $zip -GitSha "abc1234" `
                           -BuiltAt "2026-07-25T12:00:00Z" -NodeAbi 127 -MinDbSchema 42
    Check "manifest records the version" ($man.version -eq '2.1.0')
    Check "manifest records a sha256" ($man.sha256 -match '^[0-9a-f]{64}$') "got '$($man.sha256)'"
    Check "manifest records the real size" ($man.size -eq (Get-Item $zip).Length)
    Check "manifest carries nodeAbi" ($man.nodeAbi -eq 127)
    Check "manifest carries minDbSchema" ($man.minDbSchema -eq 42)

    Write-Host "`n== Sign / verify round trip ==" -ForegroundColor Cyan
    $env1 = New-OrcSignedManifest -Manifest $man -PrivateKeyXml $key.PrivateXml
    Check "envelope has a base64 signature" ($env1.signature -match '^[A-Za-z0-9+/=]+$')
    Check "envelope declares RS256" ($env1.alg -eq 'RS256')
    Check "verifies with the matching public key" (Test-OrcSignedManifest -Envelope $env1 -PublicKeyXml @($key.PublicXml))

    Write-Host "`n== Manifest that also names an installer .exe ==" -ForegroundColor Cyan
    # The Worker's /download/latest serves whatever manifest.installer names,
    # so the field must survive the file round trip and sit under the signature.
    $exe = Join-Path $tmp "OrcStrator-Setup-2.1.0.exe"
    [System.IO.File]::WriteAllBytes($exe, [byte[]](1..3000 | ForEach-Object { ($_ * 7) % 256 }))
    $manI = New-OrcManifest -Version "2.1.0" -ZipPath $zip -GitSha "abc1234" `
                            -BuiltAt "2026-07-25T12:00:00Z" -NodeAbi 127 -InstallerPath $exe
    Check "manifest without -InstallerPath has no installer field" (-not $man.Contains('installer'))
    Check "installer file name recorded" ($manI.installer.file -eq 'OrcStrator-Setup-2.1.0.exe')
    Check "installer sha256 is the real hash" ($manI.installer.sha256 -eq (Get-OrcFileHash $exe))
    Check "installer size is the real size" ($manI.installer.size -eq (Get-Item $exe).Length)
    $envI = New-OrcSignedManifest -Manifest $manI -PrivateKeyXml $key.PrivateXml
    $fileI = Join-Path $tmp "stable-installer.json"
    Write-OrcJsonFile -Path $fileI -Json ($envI | ConvertTo-Json -Depth 12)
    $readI = Get-Content $fileI -Raw -Encoding UTF8 | ConvertFrom-Json
    Check "installer manifest verifies after a file round trip" (Test-OrcSignedManifest -Envelope $readI -PublicKeyXml @($key.PublicXml))
    $t = $envI | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.manifest.installer.sha256 = ("0" * 64)
    Check "a swapped installer hash is rejected" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))
    $t = $envI | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.manifest.installer.file = "evil.exe"
    Check "a renamed installer is rejected" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))

    Write-Host "`n== It must REJECT ==" -ForegroundColor Cyan
    Check "a different key" (-not (Test-OrcSignedManifest -Envelope $env1 -PublicKeyXml @($other.PublicXml)))

    $t = $env1 | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.manifest.version = "9.9.9"
    Check "a tampered version" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))

    $t = $env1 | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.manifest.sha256 = ("0" * 64)
    Check "a swapped payload hash" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))

    $t = $env1 | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.manifest.url = "https://evil.example/payload.zip"
    Check "a redirected download URL" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))

    $t = $env1 | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.manifest.blocked = $true
    Check "a flipped kill-switch flag" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))

    $t = $env1 | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.signature = [Convert]::ToBase64String((New-Object 'byte[]' 256))
    Check "a zeroed signature" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))

    $t = $env1 | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.signature = "!!!not base64!!!"
    Check "a non-base64 signature (no crash)" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))

    $t = $env1 | ConvertTo-Json -Depth 12 | ConvertFrom-Json
    $t.alg = "none"
    Check "alg=none downgrade" (-not (Test-OrcSignedManifest -Envelope $t -PublicKeyXml @($key.PublicXml)))

    Check "a null envelope (returns false, does not throw)" (-not (Test-OrcSignedManifest -Envelope $null -PublicKeyXml @($key.PublicXml)))
    Check "an empty-string body parsed to nothing" (-not (Test-OrcSignedManifest -Envelope "" -PublicKeyXml @($key.PublicXml)))
    Check "an unrelated JSON object" (-not (Test-OrcSignedManifest -Envelope ([pscustomobject]@{ hello = 'world' }) -PublicKeyXml @($key.PublicXml)))
    Check "an envelope with no alg field" (-not (Test-OrcSignedManifest -Envelope ([pscustomobject]@{ manifest = $man; signature = $env1.signature }) -PublicKeyXml @($key.PublicXml)))
    Check "an envelope with no signature" (-not (Test-OrcSignedManifest -Envelope ([pscustomobject]@{ manifest = $man; alg = 'RS256' }) -PublicKeyXml @($key.PublicXml)))
    Check "a garbage public key (no crash)" (-not (Test-OrcSignedManifest -Envelope $env1 -PublicKeyXml @("<not-a-key/>")))
    Check "an empty key list" (-not (Test-OrcSignedManifest -Envelope $env1 -PublicKeyXml @()))

    Write-Host "`n== Key rotation: accept old AND new ==" -ForegroundColor Cyan
    Check "verifies when listed second" (Test-OrcSignedManifest -Envelope $env1 -PublicKeyXml @($other.PublicXml, $key.PublicXml))
    Check "verifies when listed first" (Test-OrcSignedManifest -Envelope $env1 -PublicKeyXml @($key.PublicXml, $other.PublicXml))
    Check "a bad key in the list does not abort the scan" (Test-OrcSignedManifest -Envelope $env1 -PublicKeyXml @("<not-a-key/>", $key.PublicXml))

    Write-Host "`n== Payload hash check ==" -ForegroundColor Cyan
    Check "the real payload matches its manifest" (Test-OrcPayload -ZipPath $zip -Manifest $man)
    $bad = Join-Path $tmp "tampered.zip"
    $bytes = [System.IO.File]::ReadAllBytes($zip); $bytes[100] = [byte](($bytes[100] + 1) % 256)
    [System.IO.File]::WriteAllBytes($bad, $bytes)
    Check "one flipped byte is caught (same length)" (-not (Test-OrcPayload -ZipPath $bad -Manifest $man))
    $short = Join-Path $tmp "short.zip"
    [System.IO.File]::WriteAllBytes($short, $bytes[0..99])
    Check "a truncated payload is caught" (-not (Test-OrcPayload -ZipPath $short -Manifest $man))
    Check "a missing payload is caught" (-not (Test-OrcPayload -ZipPath (Join-Path $tmp "nope.zip") -Manifest $man))

    Write-Host "`n== Signing survives a JSON round trip (the CI -> HTTP path) ==" -ForegroundColor Cyan
    # CI writes the envelope to a file, the Worker serves it, the launcher
    # parses it back. Canonicalization has to survive that or every update
    # fails verification in the field but passes locally.
    $file = Join-Path $tmp "stable.json"
    ($env1 | ConvertTo-Json -Depth 12) | Set-Content -Path $file -Encoding UTF8
    $reloaded = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
    Check "verifies after write + read as UTF8 JSON" (Test-OrcSignedManifest -Envelope $reloaded -PublicKeyXml @($key.PublicXml))
    $crlf = (Get-Content $file -Raw -Encoding UTF8) -replace "`n", "`r`n"
    $reloaded2 = $crlf | ConvertFrom-Json
    Check "verifies after CRLF mangling of the file" (Test-OrcSignedManifest -Envelope $reloaded2 -PublicKeyXml @($key.PublicXml))

    Write-Host "`n== 4096-bit production key ==" -ForegroundColor Cyan
    $prod = New-OrcSigningKey
    Check "default key size is 4096" ($prod.Bits -eq 4096)
    $penv = New-OrcSignedManifest -Manifest $man -PrivateKeyXml $prod.PrivateXml
    Check "4096-bit sign/verify round trip" (Test-OrcSignedManifest -Envelope $penv -PublicKeyXml @($prod.PublicXml))
    Check "4096 signature is rejected by the 2048 key" (-not (Test-OrcSignedManifest -Envelope $penv -PublicKeyXml @($key.PublicXml)))
}
finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
