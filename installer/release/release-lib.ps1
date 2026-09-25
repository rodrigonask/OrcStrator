# Shared release plumbing: hashing, manifest, RSA signing and verification.
# Dot-sourced by Build-Release.ps1 (CI) and test-release-signing.ps1.
#
# Why RSA-4096 XML rather than Ed25519 or PEM:
#   setup.ps1 runs on Windows PowerShell 5.1 / .NET Framework 4.8, which has
#   no Ed25519 and no ImportSubjectPublicKeyInfo (that is .NET Core 3.0+).
#   RSACryptoServiceProvider.FromXmlString is the API that exists on both
#   sides, so keeping keys in XML end to end removes a PEM/XML conversion
#   step that is easy to get subtly wrong and hard to debug in CI.
#
# The signature covers the MANIFEST. The manifest carries the payload's
# sha256. One signature therefore protects the whole payload.

Set-StrictMode -Version Latest

function New-OrcSigningKey {
    <#
      One-time key generation. Returns the key pair as XML strings.
        PrivateXml -> GitHub Actions secret (ORC_RELEASE_PRIVATE_KEY)
        PublicXml  -> the release config's releasePublicKeys, which the
                      release build writes into the packaged setup.ps1
      The private key never leaves CI; the public key is not a secret.
    #>
    param([int]$Bits = 4096)
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider($Bits)
    try {
        return [pscustomobject]@{
            PrivateXml = $rsa.ToXmlString($true)
            PublicXml  = $rsa.ToXmlString($false)
            Bits       = $Bits
        }
    } finally { $rsa.Dispose() }
}

function Write-OrcJsonFile {
    <#
      Write JSON with NO byte order mark. PowerShell 5.1's
      `Set-Content -Encoding UTF8` emits a BOM, and RFC 8259 forbids one:
      served over HTTP the raw bytes reach ConvertFrom-Json with a leading
      U+FEFF and it dies with "Invalid JSON primitive". This passes locally
      because Get-Content -Raw -Encoding UTF8 silently strips the BOM, so the
      failure only shows up once a real client fetches the file.
    #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Json)
    [System.IO.File]::WriteAllText($Path, $Json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-OrcFileHash {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ConvertTo-OrcCanonicalJson {
    <#
      Deterministic bytes for signing. Both sides must agree EXACTLY on what
      was signed, so we fix the encoding (UTF-8, no BOM) and the line endings
      rather than trusting ConvertTo-Json defaults or how a file round-trips
      through git on Windows.
    #>
    param([Parameter(Mandatory)]$Object)
    $json = $Object | ConvertTo-Json -Depth 12 -Compress
    return [System.Text.Encoding]::UTF8.GetBytes($json)
}

function New-OrcManifest {
    param(
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$ZipPath,
        [Parameter(Mandatory)][string]$GitSha,
        [Parameter(Mandatory)][string]$BuiltAt,      # ISO-8601 UTC, passed in so CI controls it
        [Parameter(Mandatory)][int]$NodeAbi,
        [int]$MinDbSchema = 0,
        [string]$Channel = 'stable',
        [string]$Url = '',
        [bool]$Blocked = $false,
        [bool]$BundledRuntime = $false,
        # Optional installer .exe for this release. When given, the manifest
        # gains `installer = { file, size, sha256 }`, covered by the same
        # signature, and the Worker's /download/latest serves that file.
        [string]$InstallerPath = ''
    )
    if (-not (Test-Path $ZipPath)) { throw "Payload not found: $ZipPath" }
    $m = [ordered]@{
        schema      = 1
        version     = $Version
        channel     = $Channel
        gitSha      = $GitSha
        builtAt     = $BuiltAt
        nodeAbi     = $NodeAbi
        minDbSchema = $MinDbSchema
        blocked     = $Blocked
        # When true the payload carries its own node.exe, so the client skips
        # its local ABI check: the payload does not care what Node is installed.
        bundledRuntime = $BundledRuntime
        file        = [System.IO.Path]::GetFileName($ZipPath)
        size        = (Get-Item $ZipPath).Length
        sha256      = Get-OrcFileHash $ZipPath
        url         = $Url
    }
    if ($InstallerPath) {
        if (-not (Test-Path $InstallerPath)) { throw "Installer not found: $InstallerPath" }
        $m.installer = [ordered]@{
            file   = [System.IO.Path]::GetFileName($InstallerPath)
            size   = (Get-Item $InstallerPath).Length
            sha256 = Get-OrcFileHash $InstallerPath
        }
    }
    return $m
}

function ConvertTo-OrcKeyXml {
    <#
      Normalise a key XML string as it arrives from a secret store or a file:
      a UTF-8 BOM (U+FEFF, which .NET Core does NOT treat as whitespace),
      surrounding whitespace or line breaks, or wrapping quotes all make
      FromXmlString fail with "The provided XML could not be read".
    #>
    param([string]$Xml)
    $s = ("" + $Xml).Replace([string][char]0xFEFF, '').Trim()
    if ($s.Length -ge 2 -and (($s[0] -eq '"' -and $s[-1] -eq '"') -or ($s[0] -eq "'" -and $s[-1] -eq "'"))) { $s = $s.Substring(1, $s.Length - 2).Trim() }
    return $s
}

function Get-OrcKeyShape {
    <# Describe a key string WITHOUT revealing it: safe to print in CI logs. #>
    param([string]$Xml)
    $s = "" + $Xml
    $n = ConvertTo-OrcKeyXml $s
    return [ordered]@{
        length          = $s.Length
        hasBom          = $s.Contains([string][char]0xFEFF)
        hasLineBreaks   = ($s -match "[\r\n]")
        quoted          = ($s.Trim().StartsWith('"') -or $s.Trim().StartsWith("'"))
        startsRSAKeyValue = $n.StartsWith('<RSAKeyValue>')
        endsRSAKeyValue   = $n.EndsWith('</RSAKeyValue>')
        hasPrivateParts = ($n -match '<D>')
    }
}

function New-OrcSignedManifest {
    <#
      Wraps a manifest in an envelope: { manifest, signature }. The signature
      is over the canonical bytes of `manifest` alone, so the envelope can
      grow fields later without invalidating old signatures.
    #>
    param(
        [Parameter(Mandatory)]$Manifest,
        [Parameter(Mandatory)][string]$PrivateKeyXml
    )
    $bytes = ConvertTo-OrcCanonicalJson $Manifest
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.FromXmlString((ConvertTo-OrcKeyXml $PrivateKeyXml))
        $sig = $rsa.SignData($bytes,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        return [ordered]@{
            manifest  = $Manifest
            signature = [Convert]::ToBase64String($sig)
            alg       = 'RS256'
        }
    } finally { $rsa.Dispose() }
}

function Test-OrcSignedManifest {
    <#
      Launcher-side verification. Fails CLOSED on anything unexpected: a bad
      signature is a security event, not a network blip, so every failure path
      returns $false rather than throwing into a caller that might ignore it.

      This is the function that gets inlined into setup.ps1 in phase 2. It must
      only use APIs available on .NET Framework 4.8.
    #>
    param(
        # Deliberately NOT Mandatory: the caller feeds this straight from
        # ConvertFrom-Json on a network response, which can be $null. Mandatory
        # would throw at parameter binding, before the fail-closed logic below,
        # and a throw is easy for a caller to mistake for a network error.
        $Envelope,
        [AllowEmptyCollection()][string[]]$PublicKeyXml  # array: accept old+new during key rotation
    )
    try {
        if (-not $Envelope) { return $false }
        if (-not $Envelope.manifest) { return $false }
        if (-not $Envelope.signature) { return $false }
        if ($Envelope.alg -ne 'RS256') { return $false }

        $bytes = ConvertTo-OrcCanonicalJson $Envelope.manifest
        $sig = [Convert]::FromBase64String($Envelope.signature)

        foreach ($pub in $PublicKeyXml) {
            if (-not $pub) { continue }
            $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
            try {
                $rsa.FromXmlString($pub)
                if ($rsa.VerifyData($bytes, $sig,
                        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
                        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)) {
                    return $true
                }
            } catch {
                # a malformed key in the list must not abort the others
            } finally { $rsa.Dispose() }
        }
        return $false
    } catch {
        return $false
    }
}

function Get-OrcNodeRuntime {
    <#
      Download the official Windows x64 node.exe for $NodeVersion and verify it
      against nodejs.org's own SHASUMS256.txt before it goes anywhere near a
      payload. We are about to ship this binary to every user, so an unverified
      download here would make the whole signing chain pointless: the manifest
      would faithfully attest to a compromised runtime.
      Returns the path to the verified node.exe.
    #>
    param(
        [Parameter(Mandatory)][string]$NodeVersion,   # e.g. "22.11.0"
        [Parameter(Mandatory)][string]$DestDir
    )
    $v = "v" + $NodeVersion.TrimStart('v')
    $base = "https://nodejs.org/dist/$v"
    $file = "node-$v-win-x64.zip"
    if (-not (Test-Path $DestDir)) { New-Item -ItemType Directory -Path $DestDir -Force | Out-Null }
    $zip = Join-Path $DestDir $file

    $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try {
        Write-Host "  downloading $base/$file"
        Invoke-WebRequest -Uri "$base/$file" -OutFile $zip -UseBasicParsing -ErrorAction Stop
        $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing -ErrorAction Stop).Content
    } finally { $ProgressPreference = $old }

    $expected = $null
    foreach ($line in ($sums -split "`n")) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -eq $file) { $expected = $parts[0].ToLowerInvariant(); break }
    }
    if (-not $expected) { throw "SHASUMS256.txt has no entry for $file" }
    $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        throw "Node runtime hash mismatch. expected=$expected actual=$actual"
    }
    Write-Host "  node runtime sha256 verified against nodejs.org"

    $extract = Join-Path $DestDir "node-extract"
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
    $exe = Get-ChildItem $extract -Recurse -Filter "node.exe" | Select-Object -First 1
    if (-not $exe) { throw "node.exe not found inside $file" }
    $final = Join-Path $DestDir "node.exe"
    Copy-Item $exe.FullName $final -Force
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    return $final
}

function Test-OrcPayload {
    <# Verify the downloaded zip really is the one the signed manifest names. #>
    param(
        [Parameter(Mandatory)][string]$ZipPath,
        [Parameter(Mandatory)]$Manifest
    )
    if (-not (Test-Path $ZipPath)) { return $false }
    if ((Get-Item $ZipPath).Length -ne $Manifest.size) { return $false }
    return ((Get-OrcFileHash $ZipPath) -eq ("" + $Manifest.sha256).ToLowerInvariant())
}

function Set-OrcLauncherTestKey {
    <#
      TEST BUILDS ONLY. Returns the text of a setup.ps1 whose embedded
      $script:ReleasePublicKeys list is replaced by one PUBLIC test key. Used
      for BOTH launcher copies of a throwaway -local/-test build: the one in
      the installer ({app}\installer\setup.ps1) and the one inside the payload
      zip (versions\<v>\installer\setup.ps1, which OrcStrator.exe runs once the
      payload is installed). Callers gate on the version, and a non-test
      signed build refuses to run unless its launcher key matches the signing
      key (see Build-Release.ps1), so this never reaches a release.
    #>
    param([Parameter(Mandatory)][string]$SetupText, [Parameter(Mandatory)][string]$PublicKeyXml)
    if ($PublicKeyXml -match '<D>|<P>|<Q>') { throw "The test key must be PUBLIC only" }
    $re = New-Object System.Text.RegularExpressions.Regex('\$script:ReleasePublicKeys = @\(\r?\n(.*?)\r?\n\)', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $re.IsMatch($SetupText)) { throw "Could not find the embedded key block in setup.ps1" }
    $replacement = "`$script:ReleasePublicKeys = @(`r`n    # TEST BUILD: key replaced by -TestOnlyLauncherPublicKeyXml`r`n    '$PublicKeyXml'`r`n)"
    return $re.Replace($SetupText, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement }, 1)
}

# --- release config: the update server and the keys a release trusts ----------
# The source setup.ps1 ships with NO update URL and NO trusted key, so a copy
# built from source never checks for updates and never trusts anyone's
# releases (Test-OrcArtifactMode stays false: fail closed). A release build
# that wants self-update writes both into its PACKAGED copies of setup.ps1
# from a release config file (JSON, never part of the source tree it ships):
#
#   { "updateBaseUrl": "https://updates.example.com",
#     "releasePublicKeys": [ "<RSAKeyValue>...public only...</RSAKeyValue>" ] }
#
# The public keys are not secrets; the file is kept out of published source
# only so a source build does not silently follow someone else's releases.

function Get-OrcPublicKeyXml {
    <# The public half (XML) of a private key given as XML. #>
    param([Parameter(Mandatory)][string]$PrivateKeyXml)
    $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    try { $rsa.FromXmlString($PrivateKeyXml); return $rsa.ToXmlString($false) }
    finally { $rsa.Dispose() }
}

function Get-OrcReleaseConfig {
    <#
      Load and validate a release config. Throws on anything the launcher
      could not use safely: a non-https URL, no key, a key that does not
      import, or a key carrying private parts.
    #>
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Release config not found at '$Path'" }
    $cfg = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $Path).ProviderPath) | ConvertFrom-Json
    $url = if ($cfg.PSObject.Properties['updateBaseUrl']) { ("" + $cfg.updateBaseUrl).Trim().TrimEnd('/') } else { "" }
    if ($url -notmatch "^https://[^\s'`"]+$") { throw "Release config '$Path': updateBaseUrl must be an https URL (got '$url')" }
    $keys = @()
    if ($cfg.PSObject.Properties['releasePublicKeys']) { $keys = @($cfg.releasePublicKeys | ForEach-Object { ("" + $_).Trim() } | Where-Object { $_ }) }
    if ($keys.Count -eq 0) { throw "Release config '$Path': releasePublicKeys is empty" }
    foreach ($k in $keys) {
        if ($k -match '<D>|<P>|<Q>|<DP>|<DQ>|<InverseQ>' -or $k.Contains("'")) { throw "Release config '$Path': a release key must be a PUBLIC RSA key in XML form" }
        $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider
        try {
            try { $rsa.FromXmlString($k) } catch { throw "Release config '$Path': a release key does not import as RSA XML" }
            if (-not $rsa.PublicOnly) { throw "Release config '$Path': a release key must be PUBLIC only" }
        } finally { $rsa.Dispose() }
    }
    return [pscustomobject]@{ UpdateBaseUrl = $url; ReleasePublicKeys = $keys }
}

function Set-OrcLauncherReleaseConfig {
    <#
      Returns the text of a setup.ps1 whose $script:ReleasePublicKeys list and
      $script:DefaultUpdateBaseUrl are replaced by the given values. Applied to
      the PACKAGED copies only (the payload's and the installer's), never to
      the source file. Throws if either anchor is missing, so a refactor of
      setup.ps1 cannot silently produce a release that never updates.
    #>
    param(
        [Parameter(Mandatory)][string]$SetupText,
        [Parameter(Mandatory)][string[]]$PublicKeyXml,
        [Parameter(Mandatory)][string]$UpdateBaseUrl
    )
    foreach ($k in $PublicKeyXml) { if ($k -match '<D>|<P>|<Q>' -or $k.Contains("'")) { throw "Launcher keys must be PUBLIC RSA XML" } }
    if ($UpdateBaseUrl -notmatch "^https?://[^\s'`"]+$") { throw "Update URL must be an http(s) URL without quotes" }
    $keyRe = New-Object System.Text.RegularExpressions.Regex('\$script:ReleasePublicKeys = @\(\r?\n(.*?)\r?\n\)', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($keyRe.Matches($SetupText).Count -ne 1) { throw "Could not find exactly one embedded key block in setup.ps1" }
    $urlRe = New-Object System.Text.RegularExpressions.Regex("(?m)^\`$script:DefaultUpdateBaseUrl = '[^'\r\n]*'")
    if ($urlRe.Matches($SetupText).Count -ne 1) { throw "Could not find exactly one `$script:DefaultUpdateBaseUrl assignment in setup.ps1" }
    $lines = @($PublicKeyXml | ForEach-Object { "    '$_'" }) -join "`r`n"
    $keyBlock = "`$script:ReleasePublicKeys = @(`r`n    # Written by the release build from its release config.`r`n$lines`r`n)"
    $urlLine = "`$script:DefaultUpdateBaseUrl = '$UpdateBaseUrl'"
    $t = $keyRe.Replace($SetupText, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $keyBlock }, 1)
    return $urlRe.Replace($t, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $urlLine }, 1)
}

function Get-OrcLauncherTrust {
    <#
      Evaluate what a setup.ps1 text trusts, the way the launcher itself
      would: its $script:ReleasePublicKeys and $script:DefaultUpdateBaseUrl
      assignments, read from the AST. Used by the build to check what it is
      about to ship, and by the tests.
    #>
    param([Parameter(Mandatory)][string]$SetupText)
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($SetupText, [ref]$null, [ref]$null)
    $get = {
        param($Left)
        $ast.FindAll({ param($n)
            $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq $Left
        }, $true) | Select-Object -First 1
    }
    $k = & $get '$script:ReleasePublicKeys'
    $u = & $get '$script:DefaultUpdateBaseUrl'
    if (-not $k -or -not $u) { throw "setup.ps1 is missing its key list or its update URL assignment" }
    return [pscustomobject]@{
        ReleasePublicKeys = @(& ([scriptblock]::Create($k.Right.Extent.Text)))
        UpdateBaseUrl     = "" + (& ([scriptblock]::Create($u.Right.Extent.Text)))
    }
}

# The personal-string gate. The term list is NOT in this file: it holds
# personal strings, so it lives in a private denylist file
# that is never published (default: installer\release\personal-denylist.txt).
# Format: one case-insensitive .NET regex per line; blank lines and lines
# starting with # are ignored. The gate is fail-closed: a missing or empty
# list throws, so a release can never pass the gate by losing its list.
# Keep terms that legitimately ship (for example a substring of the update
# server's host name) out of the list, or every release fails.
#
# One exception mechanism, and only one: a line "allow-author: <value>" names
# an exact package.json `author` value that may ship. It is honoured ONLY in
# files named package.json, ONLY for the top-level "author" field, and ONLY
# when that field equals the value exactly. The same text anywhere else, in
# the same file or any other, is still a hit.
function Get-OrcPersonalAllowedAuthors {
    param([AllowEmptyString()][string]$Path = "")
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return ,@() }
    $out = New-Object System.Collections.ArrayList
    foreach ($line in [System.IO.File]::ReadAllLines((Resolve-Path -LiteralPath $Path).ProviderPath)) {
        $t = $line.Trim()
        if ($t -match '^allow-author:\s*(.+)$') { [void]$out.Add($Matches[1].Trim()) }
    }
    return ,$out.ToArray()
}

function Get-OrcPersonalPatterns {
    param([AllowEmptyString()][string]$Path = "")
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw ("Personal-string denylist not found at '$Path'. The release gate is fail-closed. " +
               "Create that file with one case-insensitive regex per line (the personal strings " +
               "that must never ship in your build), or pass -DenylistPath.")
    }
    $patterns = New-Object System.Collections.ArrayList
    $n = 0
    foreach ($line in [System.IO.File]::ReadAllLines((Resolve-Path -LiteralPath $Path).ProviderPath)) {
        $n++
        $t = $line.Trim()
        if (-not $t -or $t.StartsWith('#') -or $t -match '^allow-author:') { continue }
        try { [void](New-Object System.Text.RegularExpressions.Regex($t)) }
        catch { throw "Personal-string denylist line $n is not a valid regex" }
        [void]$patterns.Add(@{ Name = $t; Regex = $t })
    }
    if ($patterns.Count -eq 0) {
        throw "Personal-string denylist '$Path' has no patterns. The release gate is fail-closed: add at least one."
    }
    return ,$patterns.ToArray()
}

function Remove-OrcAllowedAuthor {
    <#
      Blank out the VALUE of a package.json's top-level "author" field when it
      is exactly one of -AllowedAuthors, so the gate does not flag it. The
      value is replaced with spaces of the same length, which keeps every line
      number intact. Anything that does not parse as JSON, an author that is
      not a plain string, or an author that differs by a single character is
      left untouched and scanned as normal.
    #>
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text, [Parameter(Mandatory)][string[]]$AllowedAuthors)
    $json = $null
    try { $json = $Text.TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { return $Text }
    if ($null -eq $json -or -not $json.PSObject.Properties['author']) { return $Text }
    $author = $json.author
    if ($author -isnot [string] -or ($AllowedAuthors -cnotcontains $author)) { return $Text }
    # The first "author" key at object depth 1 is the top-level one.
    $re = New-Object System.Text.RegularExpressions.Regex('"author"\s*:\s*"((?:[^"\\]|\\.)*)"')
    foreach ($m in $re.Matches($Text)) {
        $depth = 0; $inStr = $false
        for ($i = 0; $i -lt $m.Index; $i++) {
            $ch = $Text[$i]
            if ($inStr) { if ($ch -eq '\') { $i++ } elseif ($ch -eq '"') { $inStr = $false } }
            elseif ($ch -eq '"') { $inStr = $true }
            elseif ($ch -eq '{' -or $ch -eq '[') { $depth++ }
            elseif ($ch -eq '}' -or $ch -eq ']') { $depth-- }
        }
        if ($depth -ne 1) { continue }
        $g = $m.Groups[1]
        $decoded = ('{"v":"' + $g.Value + '"}' | ConvertFrom-Json).v
        if ($decoded -cne $author) { return $Text }
        return $Text.Substring(0, $g.Index) + (' ' * $g.Length) + $Text.Substring($g.Index + $g.Length)
    }
    return $Text
}

function Find-OrcPersonalStrings {
    <#
    Scan every file under $Root for -Patterns (from Get-OrcPersonalPatterns),
    skipping third-party directories (node_modules, the bundled runtime).
    Returns one object per (file, pattern) with the matching line numbers.
    Deliberately never returns the matched text: a hit can sit right next to
    a secret.
    #>
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][object[]]$Patterns,
        # Exact package.json `author` values that may ship (see
        # Get-OrcPersonalAllowedAuthors). Nothing else is ever exempt.
        [AllowEmptyCollection()][string[]]$AllowedAuthors = @(),
        [string[]]$SkipDirs = @('node_modules', 'runtime')
    )
    $rootFull = (Get-Item $Root).FullName.TrimEnd('\')
    $opts = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    $compiled = @(foreach ($p in $Patterns) {
        @{ Name = $p.Name; Re = New-Object System.Text.RegularExpressions.Regex($p.Regex, $opts) }
    })
    $hits = New-Object System.Collections.ArrayList
    foreach ($f in (Get-ChildItem $rootFull -Recurse -File -Force)) {
        $rel = $f.FullName.Substring($rootFull.Length + 1)
        $parts = $rel -split '\\'
        $skip = $false
        $dirs = if ($parts.Count -gt 1) { @($parts[0..($parts.Count - 2)]) } else { @() }
        foreach ($d in $SkipDirs) { if ($dirs -icontains $d) { $skip = $true; break } }
        if ($skip) { continue }
        $text = [System.IO.File]::ReadAllText($f.FullName)
        if ($AllowedAuthors.Count -gt 0 -and $f.Name -ieq 'package.json') {
            $text = Remove-OrcAllowedAuthor -Text $text -AllowedAuthors $AllowedAuthors
        }
        foreach ($c in $compiled) {
            $ms = $c.Re.Matches($text)
            if ($ms.Count -eq 0) { continue }
            $lines = New-Object System.Collections.Generic.List[int]
            foreach ($m in $ms) {
                $n = 1; $i = -1
                while (($i = $text.IndexOf("`n", $i + 1)) -ge 0 -and $i -lt $m.Index) { $n++ }
                if (-not $lines.Contains($n)) { $lines.Add($n) }
            }
            [void]$hits.Add([pscustomobject]@{ File = $rel; Pattern = $c.Name; Lines = ($lines -join ',') })
        }
    }
    # Callers wrap the result in @() so zero, one and many hits all count the same.
    return $hits.ToArray()
}
