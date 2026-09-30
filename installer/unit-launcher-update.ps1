# The launcher's update check, run for real against a stub update server on
# localhost. The functions are pulled out of setup.ps1 by AST (so the test
# cannot drift from the shipped code); the state file lives in a temp folder.
# Covers the install id, "no update" is not an attack, and freshness.
#
# Pure: no install, no app start, nothing leaves this machine.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\unit-launcher-update.ps1
param([string]$SetupPath = "")

$ErrorActionPreference = 'Stop'
if (-not $SetupPath) { $SetupPath = Join-Path $PSScriptRoot "setup.ps1" }
. (Join-Path $PSScriptRoot "release\release-lib.ps1")

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$parseErrors)
Check "setup.ps1 parses in Windows PowerShell with no errors" (@($parseErrors).Count -eq 0) ((@($parseErrors) | Select-Object -First 2 | ForEach-Object { "$($_.Message) @ $($_.Extent.StartLineNumber)" }) -join ' | ')
$want = @('Get-LauncherState', 'Save-LauncherState', 'Set-LauncherStateValue', 'Get-OrcInstallId', 'Get-OrcUpdateChannel',
          'ConvertTo-OrcCanonicalJson', 'Test-OrcSignedManifest', 'ConvertFrom-OrcSignedManifestText', 'Get-OrcUpdateManifest',
          'Compare-OrcVersion', 'Test-OrcManifestFresh', 'Get-OrcInstallRoot', 'Get-OrcVersionPath', 'Install-OrcRelease', 'Get-OrcUpdateHeaders', 'Get-OrcDownload')
$found = @()
foreach ($name in $want) {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
    if ($fn) { Invoke-Expression $fn.Extent.Text; $found += $name }
}
$setupText = [System.IO.File]::ReadAllText($SetupPath)
$script:LogLines = New-Object System.Collections.ArrayList
function Log { param([string]$Msg) [void]$script:LogLines.Add($Msg) }
function Get-StateValue([string]$Name) { try { $o = [System.IO.File]::ReadAllText($StateFile) | ConvertFrom-Json; if ($o.PSObject.Properties[$Name]) { return $o.$Name } } catch { }; return $null }

$tmp = Join-Path $env:TEMP "orc-unit-lu-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force $tmp | Out-Null
$StateFile = Join-Path $tmp "launcher-state.json"
$env:ORC_UPDATE_CHANNEL = 'beta'

# --- stub update server: answers from $shared.Mode, records request headers ----
$port = Get-Random -Minimum 20000 -Maximum 40000
$shared = [hashtable]::Synchronized(@{ Mode = '204'; Body = ''; Headers = @(); Urls = @() })
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
$ps = [PowerShell]::Create()
[void]$ps.AddScript({
    param($l, $s)
    while ($l.IsListening) {
        try { $ctx = $l.GetContext() } catch { break }
        $h = @{}; foreach ($k in $ctx.Request.Headers.AllKeys) { $h[$k.ToLowerInvariant()] = $ctx.Request.Headers[$k] }
        $s.Headers += , $h; $s.Urls += $ctx.Request.RawUrl
        if ($s.Mode -eq '204') {
            $ctx.Response.StatusCode = 204
            $ctx.Response.AddHeader('x-orc-reason', 'not in rollout (10%)')
        } else {
            $b = [System.Text.Encoding]::UTF8.GetBytes($s.Body)
            $ctx.Response.StatusCode = 200
            $ctx.Response.ContentType = 'application/json'
            $ctx.Response.OutputStream.Write($b, 0, $b.Length)
        }
        $ctx.Response.Close()
    }
}).AddArgument($listener).AddArgument($shared)
$handle = $ps.BeginInvoke()
$base = "http://localhost:$port"

try {
    $key = New-OrcSigningKey -Bits 2048
    $zip = Join-Path $tmp "orcstrator-9.9.9-beta.1.zip"
    [System.IO.File]::WriteAllBytes($zip, [byte[]](1..64))

    Write-Host "`n== install id ==" -ForegroundColor Cyan
    Check "setup.ps1 has Get-OrcInstallId" ($found -contains 'Get-OrcInstallId')
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel beta
    $sent = if ($shared.Headers.Count) { $shared.Headers[-1]['x-orc-install-id'] } else { $null }
    $g = [guid]::Empty
    Check "the update check sends an X-Orc-Install-Id header" ([bool]$sent) "headers: $(($shared.Headers[-1].Keys) -join ', ')"
    Check "the install id is a GUID" ($sent -and [guid]::TryParse($sent, [ref]$g))
    $saved = if (Test-Path $StateFile) { (Get-Content $StateFile -Raw | ConvertFrom-Json).installId } else { $null }
    Check "the install id is kept in launcher-state" ($saved -and $saved -eq $sent) "state '$saved', sent '$sent'"
    [void](Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel beta)
    Check "the same id is sent on the next check" ($shared.Headers[-1]['x-orc-install-id'] -eq $sent)
    Check "the id never goes in the URL" (@($shared.Urls | Where-Object { $_ -match '\?' }).Count -eq 0) ($shared.Urls -join ', ')

    Write-Host "`n== a 204 is 'no update', not a signature failure ==" -ForegroundColor Cyan
    Check "204 returns no manifest" ($null -eq $m)
    Check "204 is reported as 'no update offered right now'" ($script:UpdateRejectReason -eq 'no update offered right now') "got '$($script:UpdateRejectReason)'"
    Check "204 does not match the red-alarm pattern" ($script:UpdateRejectReason -notmatch 'SIGNATURE|HASH')
    $bannerFn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Check-ForArtifactUpdates' }, $true) | Select-Object -First 1
    Check "the banner shows 'No update right now' (green) for it, in the same branch" ($bannerFn -and $bannerFn.Extent.Text -match '(?s)"no update offered right now"[^{]*\{(?:(?!elseif).)*?Set-UpdateBanner -Title "No update right now"[^\r\n]*-ColorKey ''green''')

    Write-Host "`n== a real signed manifest still goes through ==" -ForegroundColor Cyan
    $man = New-OrcManifest -Version '9.9.9-beta.1' -ZipPath $zip -GitSha 'abc1234' -BuiltAt ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) -NodeAbi 127 -Channel beta
    $shared.Body = (New-OrcSignedManifest -Manifest $man -PrivateKeyXml $key.PrivateXml) | ConvertTo-Json -Depth 12
    $shared.Mode = 'json'
    $m2 = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel beta
    Check "a signed manifest is accepted" ($m2 -and $m2.version -eq '9.9.9-beta.1') "reason '$($script:UpdateRejectReason)'"
    $shared.Body = $shared.Body -replace '"nodeAbi":\s*127', '"nodeAbi": 115'
    $m3 = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel beta
    Check "a tampered one is still the red SIGNATURE failure" ((-not $m3) -and $script:UpdateRejectReason -eq 'SIGNATURE VERIFICATION FAILED')

    Write-Host "`n== the payload download carries the same headers (licence) ==" -ForegroundColor Cyan
    if ($found -contains 'Get-OrcDownload') {
        Set-LauncherStateValue -Name 'licenceKey' -Value 'lic-test-123'
        $shared.Mode = 'json'; $shared.Body = 'zip-bytes'
        $dl = Get-OrcDownload -Url "$base/download/9.9.9/orcstrator-9.9.9.zip" -TimeoutSec 20
        $h = $shared.Headers[-1]
        Check "the payload download sends the licence key as a Bearer header" ($h['authorization'] -eq 'Bearer lic-test-123') "got '$($h['authorization'])'"
        Check "and the install id" ($h['x-orc-install-id'] -eq $sent)
        Check "and never puts the key in the URL" ($shared.Urls[-1] -notmatch 'lic-test')
        if ($dl -and (Test-Path -LiteralPath $dl)) { [System.IO.File]::Delete($dl) }
    }
    Write-Host "`n== freshness (expiresAt) ==" -ForegroundColor Cyan
    Check "setup.ps1 has Test-OrcManifestFresh" ($found -contains 'Test-OrcManifestFresh')
    $now = (Get-Date).ToUniversalTime()
    $fmt = { param($d) $d.ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture) }
    $serve = { param($ver, $exp, $min)
        $a = @{ Version = $ver; ZipPath = $zip; GitSha = 'abc1234'; BuiltAt = (& $fmt $now); NodeAbi = 127; Channel = 'beta' }
        if ($exp) { $a.ExpiresAt = $exp }
        if ($min) { $a.MinVersion = $min }
        $shared.Body = (New-OrcSignedManifest -Manifest (New-OrcManifest @a) -PrivateKeyXml $key.PrivateXml) | ConvertTo-Json -Depth 12
        $shared.Mode = 'json'
        Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel beta
    }
    $fresh = & $serve '9.9.9-beta.1' (& $fmt $now.AddDays(30)) ''
    Check "an unexpired manifest is accepted" ($fresh -and $fresh.version -eq '9.9.9-beta.1') "reason '$($script:UpdateRejectReason)'"
    $stale = & $serve '9.9.9-beta.1' (& $fmt $now.AddDays(-1)) ''
    Check "an expired signed manifest is not trusted as current" ($null -eq $stale)
    Check "and says so without the red alarm" (($script:UpdateRejectReason -match 'out of date') -and ($script:UpdateRejectReason -notmatch 'SIGNATURE|HASH')) "got '$($script:UpdateRejectReason)'"
    if ($found -contains 'Test-OrcManifestFresh') {
        Check "a manifest with no expiresAt (every release before this) stays valid" (Test-OrcManifestFresh -Manifest ([pscustomobject]@{ version = '1' }))
        Check "an unreadable expiresAt is never current" (-not (Test-OrcManifestFresh -Manifest ([pscustomobject]@{ expiresAt = 'soon' })))
    }

    Write-Host "`n== the floor (minVersion) ==" -ForegroundColor Cyan
    $up = & $serve '9.9.9-beta.2' (& $fmt $now.AddDays(30)) '9.9.9-beta.2'
    Check "a release carrying minVersion is accepted" ($up -and $up.version -eq '9.9.9-beta.2')
    $floor = (Get-StateValue updateFloor)
    Check "its minVersion becomes this computer's floor" ($floor -eq '9.9.9-beta.2') "got '$floor'"
    $old = & $serve '9.9.9-beta.1' (& $fmt $now.AddDays(30)) ''
    Check "a replayed older release (validly signed) is then refused" ($null -eq $old)
    Check "and says why, without the red alarm" (($script:UpdateRejectReason -match 'older than the minimum') -and ($script:UpdateRejectReason -notmatch 'SIGNATURE|HASH')) "got '$($script:UpdateRejectReason)'"
    $newer = & $serve '9.9.10' (& $fmt $now.AddDays(30)) ''
    Check "a newer release still goes through" ($newer -and $newer.version -eq '9.9.10')
    $lower = & $serve '9.9.11' (& $fmt $now.AddDays(30)) '9.9.9-beta.1'
    Check "a lower minVersion never lowers the floor" ($lower -and ((Get-StateValue updateFloor) -eq '9.9.9-beta.2'))

    Write-Host "`n== the launcher and the release tools agree on version order ==" -ForegroundColor Cyan
    $pairs = @(@('2.10.0', '2.9.0'), @('2.1.0', '2.1.0-beta.10'), @('2.1.0-beta.10', '2.1.0-beta.9'), @('2.1.0-beta.1.1', '2.1.0-beta.1'), @('2.1.0-1', '2.1.0-alpha'), @('2.1.0', '2.1.0'), @('2.1.0+b1', '2.1.0'))
    $agree = $true
    foreach ($p in $pairs) {
        foreach ($o in @(@($p[0], $p[1]), @($p[1], $p[0]))) {
            if ((Compare-OrcVersion $o[0] $o[1]) -ne (Compare-OrcReleaseVersion $o[0] $o[1])) { $agree = $false; Write-Host "    differ on $($o -join ' vs ')" }
        }
    }
    Check "Compare-OrcVersion (setup.ps1) and Compare-OrcReleaseVersion (release-lib) agree" $agree

    Write-Host "`n== the state file is written atomically ==" -ForegroundColor Cyan
    Set-LauncherStateValue -Name 'updateChannel' -Value 'beta'
    $afterJson = $null; try { $afterJson = [System.IO.File]::ReadAllText($StateFile) | ConvertFrom-Json } catch { }
    Check "a save leaves complete JSON with every earlier value" ((Get-StateValue updateChannel) -eq 'beta' -and $sent -and (Get-StateValue installId) -eq $sent)
    Check "no temp file is left behind" (@(Get-ChildItem $tmp -Filter 'launcher-state.json.*.tmp').Count -eq 0)
    # A save that cannot complete must leave the previous file exactly as it was.
    $good = if (Test-Path $StateFile) { [System.IO.File]::ReadAllText($StateFile) } else { "" }
    if (-not (Test-Path $StateFile)) { [System.IO.File]::WriteAllText($StateFile, "{}") }
    $lock = [System.IO.File]::Open($StateFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try { Set-LauncherStateValue -Name 'updateChannel' -Value 'stable' } finally { $lock.Dispose() }
    Check "a save that fails part way leaves the old file intact" ((Test-Path $StateFile) -and [System.IO.File]::ReadAllText($StateFile) -eq $good)
    Check "and still leaves no temp file" (@(Get-ChildItem $tmp -Filter 'launcher-state.json.*.tmp').Count -eq 0)
    $saveFn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Save-LauncherState' }, $true) | Select-Object -First 1
    Check "Save-LauncherState swaps in a temp file (File.Replace), never writes in place" ($saveFn -and $saveFn.Extent.Text -match 'File\]::Replace' -and $saveFn.Extent.Text -notmatch 'Set-Content -Path \$StateFile')

    Write-Host "`n== TLS 1.2 is switched on at start ==" -ForegroundColor Cyan
    $tls = @($ast.EndBlock.Statements | Where-Object { $_.Extent.Text -match 'ServicePointManager\]::SecurityProtocol' -and $_.Extent.Text -match 'Tls12' })
    Check "a top-level statement makes sure TLS 1.2 is available" ($tls.Count -ge 1)
    $firstFn = ($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] } | Select-Object -First 1)
    Check "it runs before any function is defined (so before any request)" ($tls.Count -ge 1 -and $firstFn -and $tls[0].Extent.StartOffset -lt $firstFn.Extent.StartOffset)
    if ($tls.Count -ge 1) {
        # Run the real statement in a fresh process for each starting value.
        $block = $tls[0].Extent.Text
        $cases = @(
            @{ Start = 'SystemDefault';  Want = 'SystemDefault';    Why = 'the OS default (TLS 1.3 capable) is left alone' },
            @{ Start = 'Ssl3, Tls';      Want = 'Ssl3, Tls, Tls12'; Why = 'an old explicit list gains TLS 1.2 and keeps the rest' },
            @{ Start = 'Tls12, Tls13';   Want = 'Tls12, Tls13';     Why = 'a list that already has TLS 1.2 is left alone' }
        )
        foreach ($c in $cases) {
            $script = "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]'$($c.Start)' } catch { 'unsupported'; exit }`n$block`n[Net.ServicePointManager]::SecurityProtocol.ToString()"
            $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($script))
            $got = ((& powershell -NoProfile -EncodedCommand $enc) -join '').Trim()
            if ($got -eq 'unsupported') { Write-Host "    ($($c.Start) not settable on this machine, skipped)" -ForegroundColor DarkGray; continue }
            Check "TLS: $($c.Why)" ($got -eq $c.Want) "start '$($c.Start)', got '$got'"
        }
    }

    Write-Host "`n== hash and extract from one handle ==" -ForegroundColor Cyan
    if ($found -contains 'Install-OrcRelease') {
        $root = Join-Path $tmp "app"
        $payload = Join-Path $tmp "payload.zip"
        Add-Type -AssemblyName System.IO.Compression
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        function New-TestZip([string]$Path, [string]$Js) {
            $zs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
            try {
                $za = New-Object System.IO.Compression.ZipArchive($zs, [System.IO.Compression.ZipArchiveMode]::Create)
                try {
                    $en = $za.CreateEntry('server/dist/index.js'); $w = New-Object System.IO.StreamWriter($en.Open()); $w.Write($Js); $w.Dispose()
                } finally { $za.Dispose() }
            } finally { $zs.Dispose() }
        }
        New-TestZip $payload 'console.log(1)'
        $evil = Join-Path $tmp "evil.zip"
        New-TestZip $evil 'require("child_process").exec("EVIL")'
        $evilBytes = [System.IO.File]::ReadAllBytes($evil)
        $pm = [pscustomobject]@{ version = '9.9.9-beta.1'; size = (Get-Item $payload).Length; sha256 = (Get-FileHash $payload -Algorithm SHA256).Hash.ToLowerInvariant() }
        # The attack: the payload is replaced AFTER its hash was checked and
        # BEFORE it is extracted. The hook is New-Item, which Install-OrcRelease
        # calls in between (it creates the staging folder); a same-user process
        # racing the launcher could do the same at that moment.
        $script:SwapArmed = $true; $script:SwapResult = 'not attempted'
        function New-Item {
            if ($script:SwapArmed) {
                $script:SwapArmed = $false
                try { [System.IO.File]::WriteAllBytes($payload, $evilBytes); $script:SwapResult = 'swapped' } catch { $script:SwapResult = 'blocked' }
            }
            Microsoft.PowerShell.Management\New-Item @args
        }
        $r1 = Install-OrcRelease -Root $root -Manifest $pm -ZipPath $payload
        Remove-Item Function:\New-Item
        $installedJs = Join-Path $root 'versions\9.9.9-beta.1\server\dist\index.js'
        $got = if (Test-Path $installedJs) { [System.IO.File]::ReadAllText($installedJs) } else { '(nothing installed)' }
        Check "swapping the payload between the hash check and the extraction is impossible" ($script:SwapResult -eq 'blocked') "swap: $($script:SwapResult)"
        Check "what gets installed is always the signed payload, never the swapped one" ($got -notmatch 'EVIL') "installed: $got"
        New-TestZip $payload 'console.log(1)'
        if (Test-Path (Join-Path $root 'versions')) { Remove-Item (Join-Path $root 'versions') -Recurse -Force }
        $r2 = Install-OrcRelease -Root $root -Manifest $pm -ZipPath $payload
        Check "an untouched payload installs" ($r2 -and (Test-Path (Join-Path $root 'versions\9.9.9-beta.1\server\dist\index.js')))
        $bad = [pscustomobject]@{ version = '9.9.9-beta.2'; size = $pm.size; sha256 = ('0' * 64) }
        Check "a payload whose hash is wrong is refused" (-not (Install-OrcRelease -Root $root -Manifest $bad -ZipPath $payload))
        $instFn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Install-OrcRelease' }, $true) | Select-Object -First 1
        Check "Install-OrcRelease extracts from the same handle it hashed" ($instFn.Extent.Text -match 'FileShare\]::Read\)' -and $instFn.Extent.Text -match 'ZipArchive\(\$fs' -and $instFn.Extent.Text -notmatch 'ZipFile\]::ExtractToDirectory\(\$ZipPath')
    }
} finally {
    $listener.Stop(); $listener.Close()
    $ps.Stop(); $ps.Dispose()
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:ORC_UPDATE_CHANNEL -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
exit 0
