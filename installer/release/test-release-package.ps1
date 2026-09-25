# Runs the REAL Build-Release.ps1 against this checkout and inspects what it
# produced: payload contents, spec-compliant entry names, signed manifest,
# and that the launcher-side verifiers accept it.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\release\test-release-package.ps1
#
# Requires `npm run build` to have run. Skips (exit 0) if the dists are absent
# so this is safe to run on a fresh clone.

. (Join-Path $PSScriptRoot "release-lib.ps1")

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
foreach ($rel in @("shared\dist", "client\dist\index.html", "server\dist\index.js")) {
    if (-not (Test-Path (Join-Path $RepoRoot $rel))) {
        Write-Host "SKIP: $rel missing. Run 'npm run build' first." -ForegroundColor Yellow
        exit 0
    }
}

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$out = Join-Path $env:TEMP "orc-pkg-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$key = New-OrcSigningKey -Bits 2048
$BuildRelease = Join-Path $PSScriptRoot "Build-Release.ps1"

# Synthetic fixtures only: a throwaway denylist and a release config that
# trusts this run's throwaway key. The build never falls back to a default
# file because every call below names its inputs explicitly.
$fx = "$out-fixtures"
New-Item -ItemType Directory -Force $fx | Out-Null
$deny = Join-Path $fx "denylist.txt"
[System.IO.File]::WriteAllText($deny, "# synthetic test denylist`r`n`r`nallow-author: Jane Example (example.com)`r`njane[ _-]?example`r`nacmewidgets`r`n\bzorp\b`r`nc:(\\|/)+work`r`n")
$TestUpdateBaseUrl = 'https://updates.example.com'
function New-TestReleaseConfig([string]$Path, [string[]]$Keys) {
    Write-OrcJsonFile -Path $Path -Json ([ordered]@{ updateBaseUrl = $TestUpdateBaseUrl; releasePublicKeys = $Keys } | ConvertTo-Json -Depth 4)
}
$cfg = Join-Path $fx "release.config.json"
New-TestReleaseConfig $cfg @($key.PublicXml)
function Read-ZipText($ZipPath, [string]$Entry) {
    $zz = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $e = $zz.GetEntry($Entry); if (-not $e) { return $null }
        $r = New-Object System.IO.StreamReader($e.Open()); try { return $r.ReadToEnd() } finally { $r.Close() }
    } finally { $zz.Dispose() }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem

try {
    Write-Host "`n== Build-Release.ps1 ==" -ForegroundColor Cyan
    $env:ORC_RELEASE_PRIVATE_KEY = $key.PrivateXml
    $log = & powershell -NoProfile -ExecutionPolicy Bypass -File $BuildRelease `
              -Version "9.9.9-test" -OutDir $out -BaseUrl "https://updates.example.com" -MinDbSchema 7 `
              -ReleaseConfigPath $cfg -DenylistPath $deny 2>&1
    $env:ORC_RELEASE_PRIVATE_KEY = $null
    $built = Test-Path (Join-Path $out "orcstrator-9.9.9-test.zip")
    $gateLines = @($log | ForEach-Object { "$_" } | Where-Object { $_ -match 'GATE HIT|Personal-string gate' })
    Check "personal-string gate passed" (@($log | Where-Object { "$_" -match 'PASS: 0 hits across' }).Count -eq 1) ($gateLines -join ' | ')
    Check "build produced a payload" $built (($log | Select-Object -Last 5) -join ' | ')
    if (-not $built) { throw "no payload" }

    $zip = Join-Path $out "orcstrator-9.9.9-test.zip"
    $envelope = Get-Content (Join-Path $out "stable.json") -Raw -Encoding UTF8 | ConvertFrom-Json

    Write-Host "`n== Signed manifest ==" -ForegroundColor Cyan
    Check "signature verifies with the build key" (Test-OrcSignedManifest -Envelope $envelope -PublicKeyXml @($key.PublicXml))
    Check "rejected by an unrelated key" (-not (Test-OrcSignedManifest -Envelope $envelope -PublicKeyXml @((New-OrcSigningKey -Bits 2048).PublicXml)))
    Check "payload matches the manifest hash" (Test-OrcPayload -ZipPath $zip -Manifest $envelope.manifest)
    Check "manifest carries the real Node ABI" ($envelope.manifest.nodeAbi -eq [int](& node -p "process.versions.modules")) "got $($envelope.manifest.nodeAbi)"
    Check "minDbSchema is passed through" ($envelope.manifest.minDbSchema -eq 7) "got $($envelope.manifest.minDbSchema)"
    Check "download url goes through the Worker /download/ route" ($envelope.manifest.url -eq "https://updates.example.com/download/9.9.9-test/orcstrator-9.9.9-test.zip") "got $($envelope.manifest.url)"
    Check "gitSha is recorded" ($envelope.manifest.gitSha -match '^[0-9a-f]{7,40}$') "got '$($envelope.manifest.gitSha)'"

    Write-Host "`n== Payload contents ==" -ForegroundColor Cyan
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $names = $z.Entries | ForEach-Object { $_.FullName }

        # ZIP spec 4.4.17.1: entry names use forward slashes. CreateFromDirectory
        # on .NET Framework writes backslashes, which some extractors turn into
        # files literally named "server\dist\index.js".
        $backslashed = @($names | Where-Object { $_ -like '*\*' })
        Check "no backslashes in entry names" ($backslashed.Count -eq 0) "$($backslashed.Count) bad, e.g. '$($backslashed | Select-Object -First 1)'"

        foreach ($needed in @('version.json','server/dist/index.js','client/dist/index.html','package.json','package-lock.json','installer/setup.ps1','server/package.json','shared/package.json','client/package.json')) {
            Check "contains $needed" ($names -contains $needed)
        }
        Check "contains the built shared output" (@($names | Where-Object { $_ -like 'shared/dist/*.js' }).Count -gt 0)
        Check "contains the client asset bundle" (@($names | Where-Object { $_ -like 'client/dist/assets/*.js' }).Count -gt 0)

        $maps = @($names | Where-Object { $_ -like '*.map' })
        Check "ships no source maps" ($maps.Count -eq 0) "$($maps.Count) found"
        $dts = @($names | Where-Object { $_ -like '*.d.ts' })
        Check "ships no .d.ts declarations" ($dts.Count -eq 0) "$($dts.Count) found"
        Check "ships no node_modules by default" (@($names | Where-Object { $_ -like 'node_modules/*' }).Count -eq 0)
        Check "ships no TypeScript source" (@($names | Where-Object { $_ -like '*/src/*' }).Count -eq 0)

        # Release compile strips comments: no server or shared JS line may START a
        # comment. (A "//" inside a string or URL does not start a line, so it is
        # not counted.)
        $commented = 0; $jsCount = 0
        foreach ($e in @($z.Entries | Where-Object { $_.FullName -match '^(server|shared)/dist/.*\.js$' })) {
            $jsCount++
            $r = New-Object System.IO.StreamReader($e.Open())
            $src = $r.ReadToEnd(); $r.Close()
            $commented += @($src -split "`n" | Where-Object { $_ -match '^\s*(//|/\*)' }).Count
        }
        Check "server/shared JS is present" ($jsCount -gt 10) "$jsCount files"
        Check "server/shared JS ships with comments stripped" ($commented -eq 0) "$commented comment line(s)"

        $vj = $z.GetEntry('version.json')
        $sr = New-Object System.IO.StreamReader($vj.Open())
        $version = $sr.ReadToEnd() | ConvertFrom-Json
        $sr.Close()
        Check "version.json states the version" ($version.version -eq '9.9.9-test') "got '$($version.version)'"
        Check "version.json states the Node ABI" ($version.nodeAbi -eq $envelope.manifest.nodeAbi)
        Check "version.json flags no bundled node_modules" ($version.bundledNodeModules -eq $false)
    } finally { $z.Dispose() }

    Write-Host "`n== The packaged launcher carries the release config ==" -ForegroundColor Cyan
    $pkgSetup = Read-ZipText $zip 'installer/setup.ps1'
    $srcSetup = [System.IO.File]::ReadAllText((Join-Path $RepoRoot "installer\setup.ps1"))
    $pkgTrust = Get-OrcLauncherTrust -SetupText $pkgSetup
    $srcTrust = Get-OrcLauncherTrust -SetupText $srcSetup
    Check "source launcher: no update URL, no trusted key" (($srcTrust.UpdateBaseUrl -eq '') -and (@($srcTrust.ReleasePublicKeys).Count -eq 0)) "url '$($srcTrust.UpdateBaseUrl)', $(@($srcTrust.ReleasePublicKeys).Count) key(s)"
    Check "packaged launcher has the configured update URL" ($pkgTrust.UpdateBaseUrl -eq $TestUpdateBaseUrl) "got '$($pkgTrust.UpdateBaseUrl)'"
    Check "packaged launcher trusts exactly the configured key" ((@($pkgTrust.ReleasePublicKeys).Count -eq 1) -and ($pkgTrust.ReleasePublicKeys[0] -eq $key.PublicXml)) "$(@($pkgTrust.ReleasePublicKeys).Count) key(s)"
    Check "the signed manifest verifies with the key the packaged launcher trusts" (Test-OrcSignedManifest -Envelope $envelope -PublicKeyXml $pkgTrust.ReleasePublicKeys)
    Write-Host "`n== Tampering the shipped payload is caught ==" -ForegroundColor Cyan
    $bytes = [System.IO.File]::ReadAllBytes($zip)
    $bytes[[int]($bytes.Length / 2)] = [byte](($bytes[[int]($bytes.Length / 2)] + 1) % 256)
    $tampered = Join-Path $out "tampered.zip"
    [System.IO.File]::WriteAllBytes($tampered, $bytes)
    Check "a single flipped byte fails the hash check" (-not (Test-OrcPayload -ZipPath $tampered -Manifest $envelope.manifest))

    Write-Host "`n== Unsigned build is marked unsigned ==" -ForegroundColor Cyan
    $out2 = "$out-unsigned"
    $env:ORC_RELEASE_PRIVATE_KEY = $null
    & powershell -NoProfile -ExecutionPolicy Bypass -File $BuildRelease `
        -Version "9.9.9-unsigned" -OutDir $out2 -NoReleaseConfig -DenylistPath $deny 2>&1 | Out-Null
    $u = Get-Content (Join-Path $out2 "stable.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    Check "unsigned manifest declares alg=unsigned" ($u.alg -eq 'unsigned') "got '$($u.alg)'"
    Check "the launcher would REJECT an unsigned manifest" (-not (Test-OrcSignedManifest -Envelope $u -PublicKeyXml @($key.PublicXml)))
    $uTrust = Get-OrcLauncherTrust -SetupText (Read-ZipText (Join-Path $out2 "orcstrator-9.9.9-unsigned.zip") 'installer/setup.ps1')
    Check "no release config: the packaged launcher has updates OFF" (($uTrust.UpdateBaseUrl -eq '') -and (@($uTrust.ReleasePublicKeys).Count -eq 0)) "url '$($uTrust.UpdateBaseUrl)', $(@($uTrust.ReleasePublicKeys).Count) key(s)"
    Remove-Item $out2 -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "`n== Fail closed before any work ==" -ForegroundColor Cyan
    function Invoke-BuildExpectingFailure([string]$Name, [string]$Pattern, [hashtable]$Extra, [string]$SigningKeyXml = "") {
        $o = "$out-fail-$([guid]::NewGuid().ToString('N').Substring(0,6))"
        $env:ORC_RELEASE_PRIVATE_KEY = $SigningKeyXml
        try {
            $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $BuildRelease, '-Version', '9.9.9-closed', '-OutDir', $o)
            foreach ($k in $Extra.Keys) { if ($Extra[$k] -is [bool]) { $argList += "-$k" } else { $argList += @("-$k", $Extra[$k]) } }
            $l = @(& powershell @argList 2>&1 | ForEach-Object { "$_" })
            $ex = $LASTEXITCODE
        } finally { $env:ORC_RELEASE_PRIVATE_KEY = $null }
        Check "$Name : exits non-zero" ($ex -ne 0) "exit $ex"
        Check "$Name : says why" (@($l | Where-Object { $_ -match $Pattern }).Count -ge 1) (($l | Select-Object -Last 3) -join ' | ')
        Check "$Name : wrote no payload" (-not (Test-Path (Join-Path $o "orcstrator-9.9.9-closed.zip")))
        Remove-Item $o -Recurse -Force -ErrorAction SilentlyContinue
    }
    Invoke-BuildExpectingFailure "missing denylist" 'denylist not found' @{ DenylistPath = (Join-Path $fx "no-such-denylist.txt"); NoReleaseConfig = $true }
    $emptyDeny = Join-Path $fx "empty-denylist.txt"
    [System.IO.File]::WriteAllText($emptyDeny, "# only a comment`r`n`r`n")
    Invoke-BuildExpectingFailure "empty denylist" 'has no patterns' @{ DenylistPath = $emptyDeny; NoReleaseConfig = $true }
    Invoke-BuildExpectingFailure "signed build without a release config" 'needs a release config' @{ DenylistPath = $deny; NoReleaseConfig = $true } $key.PrivateXml
    $otherCfg = Join-Path $fx "other.config.json"
    New-TestReleaseConfig $otherCfg @((New-OrcSigningKey -Bits 2048).PublicXml)
    Invoke-BuildExpectingFailure "signed build whose config does not trust the signing key" 'not in the release config' @{ DenylistPath = $deny; ReleaseConfigPath = $otherCfg } $key.PrivateXml
    $httpCfg = Join-Path $fx "http.config.json"
    Write-OrcJsonFile -Path $httpCfg -Json ([ordered]@{ updateBaseUrl = 'http://updates.example.com'; releasePublicKeys = @($key.PublicXml) } | ConvertTo-Json -Depth 4)
    Invoke-BuildExpectingFailure "release config with a non-https URL" 'must be an https URL' @{ DenylistPath = $deny; ReleaseConfigPath = $httpCfg }

    Write-Host "`n== Personal-string gate: matcher rules ==" -ForegroundColor Cyan
    $patterns = Get-OrcPersonalPatterns -Path $deny
    Check "denylist loader skips comments and blank lines" ($patterns.Count -eq 4) "got $($patterns.Count)"
    $g = Join-Path $out "gate-unit"
    New-Item -ItemType Directory -Force (Join-Path $g "server\dist"), (Join-Path $g "node_modules\x"), (Join-Path $g "runtime") | Out-Null
    Set-Content (Join-Path $g "server\dist\ok.js") 'const u = "https://updates.example.com"; const c = "zorpish unzorp";' -Encoding ASCII
    Set-Content (Join-Path $g "node_modules\x\third.js") 'jane example acmewidgets' -Encoding ASCII
    Set-Content (Join-Path $g "runtime\node.txt") 'zorp' -Encoding ASCII
    Check "clean file, words merely containing a \b-bounded term: 0 hits; node_modules and runtime skipped" `
        (@(Find-OrcPersonalStrings -Root $g -Patterns $patterns).Count -eq 0) ((Find-OrcPersonalStrings -Root $g -Patterns $patterns | ForEach-Object { "$($_.File):$($_.Pattern)" }) -join ', ')
    $planted = @('JANE EXAMPLE', 'jane_example', 'AcmeWidgets', 'the ZORP client', 'C:\Work\x', 'c:/work/y')
    $i = 0
    foreach ($p in $planted) { $i++; Set-Content (Join-Path $g "server\dist\p$i.js") "line one`nconst v = '$p';" -Encoding ASCII }
    $hits = @(Find-OrcPersonalStrings -Root $g -Patterns $patterns)
    $filesHit = @($hits | ForEach-Object { $_.File } | Select-Object -Unique).Count
    $patternsHit = @($hits | ForEach-Object { $_.Pattern } | Select-Object -Unique).Count
    Check "every planted file is caught, case-insensitively" ($filesHit -eq $planted.Count) "$filesHit of $($planted.Count)"
    Check "every listed pattern fires" ($patternsHit -eq $patterns.Count) "$patternsHit of $($patterns.Count)"
    Check "hits carry file and line, not text" (@($hits | Where-Object { $_.Lines -ne '2' -or -not $_.File }).Count -eq 0)
    $authors = Get-OrcPersonalAllowedAuthors -Path $deny
    Check "denylist loader reads the allow-author line (and it is not a pattern)" (($authors.Count -eq 1) -and ($authors[0] -ceq 'Jane Example (example.com)') -and (@($patterns | Where-Object { $_.Regex -match 'allow-author' }).Count -eq 0))
    $a = Join-Path $out "gate-author"
    New-Item -ItemType Directory -Force (Join-Path $a "ok\server"), (Join-Path $a "bad-desc"), (Join-Path $a "bad-near"), (Join-Path $a "bad-other") | Out-Null
    [IO.File]::WriteAllText((Join-Path $a "ok\package.json"), "{`n  ""name"": ""x"",`n  ""author"": ""Jane Example (example.com)"",`n  ""license"": ""MIT""`n}`n")
    [IO.File]::WriteAllText((Join-Path $a "ok\server\package.json"), "{`n  ""name"":  ""y"",`n  ""author"":  ""Jane Example (example.com)""`n}`n")
    Check "exact allowed author in package.json 'author' fields: 0 hits" (@(Find-OrcPersonalStrings -Root (Join-Path $a "ok") -Patterns $patterns -AllowedAuthors $authors).Count -eq 0) ((Find-OrcPersonalStrings -Root (Join-Path $a "ok") -Patterns $patterns -AllowedAuthors $authors | ForEach-Object { "$($_.File):$($_.Pattern)" }) -join ', ')
    Check "without the allow list the same files DO hit" (@(Find-OrcPersonalStrings -Root (Join-Path $a "ok") -Patterns $patterns).Count -eq 2)
    [IO.File]::WriteAllText((Join-Path $a "bad-desc\package.json"), "{`n  ""author"": ""Jane Example (example.com)"",`n  ""description"": ""by Jane Example (example.com)""`n}`n")
    $h = @(Find-OrcPersonalStrings -Root (Join-Path $a "bad-desc") -Patterns $patterns -AllowedAuthors $authors)
    Check "same string in another package.json field is still a hit (line 3 only)" (($h.Count -eq 1) -and ($h[0].Lines -eq '3')) (($h | ForEach-Object { "$($_.File):$($_.Pattern):$($_.Lines)" }) -join ', ')
    [IO.File]::WriteAllText((Join-Path $a "bad-near\package.json"), "{`n  ""author"": ""Jane Example (example.org)""`n}`n")
    Check "an author that differs from the allowed value is a hit" (@(Find-OrcPersonalStrings -Root (Join-Path $a "bad-near") -Patterns $patterns -AllowedAuthors $authors).Count -eq 1)
    [IO.File]::WriteAllText((Join-Path $a "bad-other\version.json"), "{`n  ""author"": ""Jane Example (example.com)""`n}`n")
    Check "the allowed author outside a package.json is a hit" (@(Find-OrcPersonalStrings -Root (Join-Path $a "bad-other") -Patterns $patterns -AllowedAuthors $authors).Count -eq 1)

    Write-Host "`n== Personal-string gate: a real build FAILS on a planted string ==" -ForegroundColor Cyan
    # Planted in client\dist, which is build output (gitignored) and is copied into
    # the stage as-is. The fake secret beside it must never reach the log.
    $plant = Join-Path $RepoRoot "client\dist\zz-gate-plant.txt"
    $fakeSecret = "FAKESECRET-" + [guid]::NewGuid().ToString('N')
    Set-Content $plant "token=$fakeSecret owner=Jane Example path=D:\acmewidgets\x" -Encoding ASCII
    try {
        $out3 = "$out-gatefail"
        $flog = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $BuildRelease `
                    -Version "9.9.9-gatefail" -OutDir $out3 -NoReleaseConfig -DenylistPath $deny 2>&1 | ForEach-Object { "$_" })
        $failExit = $LASTEXITCODE
        $flog | Where-Object { $_ -match 'GATE HIT|gate FAILED' } | ForEach-Object { Write-Host "    | $_" }
        Check "build exits non-zero" ($failExit -ne 0) "exit $failExit"
        Check "no payload was written" (-not (Test-Path (Join-Path $out3 "orcstrator-9.9.9-gatefail.zip")))
        Check "log names the file and the patterns" ((@($flog | Where-Object { $_ -match 'GATE HIT\s+client\\dist\\zz-gate-plant\.txt' }).Count) -eq 2)
        Check "log never prints the surrounding text" (@($flog | Where-Object { $_ -match [regex]::Escape($fakeSecret) }).Count -eq 0)
        Remove-Item $out3 -Recurse -Force -ErrorAction SilentlyContinue
    } finally { Remove-Item $plant -Force -ErrorAction SilentlyContinue }
}
catch {
    # An exception mid-run is a failure, never a silent early exit with a green total.
    Check "test run completed without an exception" $false "$($_.Exception.Message)"
}
finally {
    $env:ORC_RELEASE_PRIVATE_KEY = $null
    Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $fx -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
