# Update channels (stable default, beta opt-in via ORC_UPDATE_CHANNEL or the
# launcher-state setting "updateChannel"). Drives the REAL setup.ps1
# functions against a REAL local HTTP server serving REAL signed manifests.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-update-channel.ps1

param([int]$Port = 3413)

. (Join-Path $PSScriptRoot "release\release-lib.ps1")
Set-StrictMode -Off

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)
foreach ($name in @('Find-Exe', 'Get-LauncherState', 'Save-LauncherState', 'Set-LauncherStateValue',
                    'ConvertTo-OrcCanonicalJson', 'Test-OrcSignedManifest', 'Test-OrcPayload', 'Compare-OrcVersion',
                    'Get-OrcInstallRoot', 'Get-OrcActiveVersion', 'Set-OrcActiveVersion', 'Get-OrcVersionPath',
                    'Get-OrcUpdateChannel', 'Get-OrcInstallId', 'Get-OrcUpdateHeaders', 'Test-OrcManifestFresh', 'Get-OrcUpdateManifest', 'Get-OrcStagedManifest', 'ConvertFrom-OrcSignedManifestText',
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

$sandbox = Join-Path $env:TEMP "orc-channel-test-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$serveDir = Join-Path $sandbox "serve"
$root = Join-Path $sandbox "app"
$StateFile = Join-Path $sandbox "launcher-state.json"
New-Item -ItemType Directory -Path $serveDir, $root -Force | Out-Null
$key = New-OrcSigningKey -Bits 2048
$savedChannel = $env:ORC_UPDATE_CHANNEL
$base = "http://localhost:$Port"

function Publish {
    param([string]$Version, [string]$Channel, [string]$AsFile = "")
    $stage = Join-Path $sandbox "build-$Version"
    New-Item -ItemType Directory -Path (Join-Path $stage "server\dist") -Force | Out-Null
    Set-Content (Join-Path $stage "server\dist\index.js") "// $Version" -Encoding UTF8
    $zip = Join-Path $serveDir "orcstrator-$Version.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
    Remove-Item $stage -Recurse -Force
    $m = New-OrcManifest -Version $Version -ZipPath $zip -GitSha "deadbee" -BuiltAt "2026-09-24T00:00:00Z" `
                         -NodeAbi 127 -Channel $Channel -BundledRuntime $true -Url "$base/orcstrator-$Version.zip"
    $name = if ($AsFile) { $AsFile } else { "$Channel.json" }
    Write-OrcJsonFile -Path (Join-Path $serveDir $name) -Json ((New-OrcSignedManifest -Manifest $m -PrivateKeyXml $key.PrivateXml) | ConvertTo-Json -Depth 12)
}

$listener = $null; $ps = $null
try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("$base/")
    $listener.Start()
    $script:requests = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
    $ps = [powershell]::Create()
    $ps.Runspace = [runspacefactory]::CreateRunspace(); $ps.Runspace.Open()
    $ps.Runspace.SessionStateProxy.SetVariable('listener', $listener)
    $ps.Runspace.SessionStateProxy.SetVariable('serveDir', $serveDir)
    $ps.Runspace.SessionStateProxy.SetVariable('requests', $script:requests)
    $ps.AddScript({
        while ($listener.IsListening) {
            try {
                $ctx = $listener.GetContext()
                $name = $ctx.Request.Url.AbsolutePath.TrimStart('/')
                [void]$requests.Add($name)
                $file = Join-Path $serveDir $name
                if ($name -and (Test-Path $file -PathType Leaf)) {
                    $bytes = [System.IO.File]::ReadAllBytes($file)
                    $ctx.Response.ContentType = if ($name -like '*.json') { 'application/json' } else { 'application/zip' }
                    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                } else { $ctx.Response.StatusCode = 404 }
                $ctx.Response.Close()
            } catch { break }
        }
    }.ToString()) | Out-Null
    $null = $ps.BeginInvoke()
    Start-Sleep -Milliseconds 300

    Write-Host "== Which channel ==" -ForegroundColor Cyan
    [Environment]::SetEnvironmentVariable('ORC_UPDATE_CHANNEL', $null, 'Process')
    Check "default is stable" ((Get-OrcUpdateChannel) -eq 'stable')
    Set-LauncherStateValue -Name "updateChannel" -Value "beta"
    Check "launcher-state updateChannel=beta -> beta" ((Get-OrcUpdateChannel) -eq 'beta')
    $env:ORC_UPDATE_CHANNEL = "stable"
    Check "ORC_UPDATE_CHANNEL wins over the state setting" ((Get-OrcUpdateChannel) -eq 'stable')
    $env:ORC_UPDATE_CHANNEL = " BETA "
    Check "env value is trimmed and case-insensitive" ((Get-OrcUpdateChannel) -eq 'beta')
    $env:ORC_UPDATE_CHANNEL = "nightly"
    Check "unknown channel falls back to stable" ((Get-OrcUpdateChannel) -eq 'stable')
    [Environment]::SetEnvironmentVariable('ORC_UPDATE_CHANNEL', $null, 'Process')
    Set-LauncherStateValue -Name "updateChannel" -Value ""

    Publish -Version "2.1.0" -Channel "stable"
    Publish -Version "2.2.0-beta.1" -Channel "beta"

    Write-Host "`n== stable follows stable.json ==" -ForegroundColor Cyan
    $script:requests.Clear()
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml)
    Check "fetched stable.json" (@($script:requests) -contains 'stable.json' -and @($script:requests) -notcontains 'beta.json') "requests: $(@($script:requests) -join ',')"
    Check "got the stable release" ($m -and $m.version -eq '2.1.0') $script:UpdateRejectReason

    Write-Host "`n== beta follows beta.json ==" -ForegroundColor Cyan
    $env:ORC_UPDATE_CHANNEL = "beta"
    $script:requests.Clear()
    $r = Invoke-OrcArtifactUpdate -Root $root -BaseUrl $base -PublicKeyXml @($key.PublicXml)
    Check "fetched beta.json" (@($script:requests) -contains 'beta.json') "requests: $(@($script:requests) -join ',')"
    Check "installed the beta release" ($r.Updated -and (Get-OrcActiveVersion $root) -eq '2.2.0-beta.1') $r.Reason
    [Environment]::SetEnvironmentVariable('ORC_UPDATE_CHANNEL', $null, 'Process')
    Set-LauncherStateValue -Name "updateChannel" -Value "beta"
    $script:requests.Clear()
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml)
    Check "state setting alone switches the fetch to beta.json" (@($script:requests) -contains 'beta.json' -and $m.version -eq '2.2.0-beta.1')
    Set-LauncherStateValue -Name "updateChannel" -Value ""

    Write-Host "`n== SECURITY: a manifest signed for another channel is refused ==" -ForegroundColor Cyan
    # A genuine, correctly signed BETA manifest replayed at the stable URL.
    Publish -Version "2.3.0-beta.1" -Channel "beta" -AsFile "stable.json"
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel 'stable'
    Check "refused" ($null -eq $m)
    Check "reason names the channel" ($script:UpdateRejectReason -match "channel 'beta'") "got '$script:UpdateRejectReason'"
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel 'nightly'
    Check "an unknown channel is refused before any request" ($null -eq $m -and $script:UpdateRejectReason -match 'unknown update channel')
    # And the mirror image: a stable manifest replayed at the beta URL.
    Publish -Version "2.4.0" -Channel "stable" -AsFile "beta.json"
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel 'beta'
    Check "a stable manifest at the beta URL is refused" ($null -eq $m -and $script:UpdateRejectReason -match "channel 'stable'") "got '$script:UpdateRejectReason'"

    Write-Host "`n== SECURITY: the channel field is mandatory ==" -ForegroundColor Cyan
    # Correctly signed, but the signed bytes name no channel at all. Before,
    # a missing field skipped the check, so it verified at ANY channel URL.
    function Publish-NoChannel {
        param([string]$Version, [string]$AsFile, $Value = $null, [switch]$Omit)
        $stage = Join-Path $sandbox "build-nc-$Version"
        New-Item -ItemType Directory -Path (Join-Path $stage "server\dist") -Force | Out-Null
        Set-Content (Join-Path $stage "server\dist\index.js") "// $Version" -Encoding UTF8
        $zip = Join-Path $serveDir "orcstrator-$Version.zip"
        if (Test-Path $zip) { Remove-Item $zip -Force }
        [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip)
        Remove-Item $stage -Recurse -Force
        $m = New-OrcManifest -Version $Version -ZipPath $zip -GitSha "deadbee" -BuiltAt "2026-09-24T00:00:00Z" `
                             -NodeAbi 127 -Channel 'stable' -BundledRuntime $true -Url "$base/orcstrator-$Version.zip"
        if ($Omit) { $m.Remove('channel') } else { $m.channel = $Value }
        Write-OrcJsonFile -Path (Join-Path $serveDir $AsFile) -Json ((New-OrcSignedManifest -Manifest $m -PrivateKeyXml $key.PrivateXml) | ConvertTo-Json -Depth 12)
    }
    Publish-NoChannel -Version "2.5.0" -AsFile "stable.json" -Omit
    $raw = Get-Content (Join-Path $serveDir "stable.json") -Raw | ConvertFrom-Json
    Check "fixture: signed, no channel property" ((Test-OrcSignedManifest -Envelope $raw -PublicKeyXml @($key.PublicXml)) -and -not $raw.manifest.PSObject.Properties['channel'])
    foreach ($ch in 'stable', 'beta') {
        Publish-NoChannel -Version "2.5.0" -AsFile "$ch.json" -Omit
        $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel $ch
        Check "no channel field -> refused at the $ch URL" ($null -eq $m -and $script:UpdateRejectReason -match 'no channel') "got '$script:UpdateRejectReason'"
    }
    Publish-NoChannel -Version "2.5.0" -AsFile "stable.json" -Value ""
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel 'stable'
    Check "empty channel string -> refused" ($null -eq $m -and $script:UpdateRejectReason -match 'no channel') "got '$script:UpdateRejectReason'"
    Publish-NoChannel -Version "2.5.0" -AsFile "stable.json" -Value "STABLE"
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel 'stable'
    Check "channel compared exactly ('STABLE' is not 'stable')" ($null -eq $m) "got '$script:UpdateRejectReason'"
    $r = Invoke-OrcArtifactUpdate -Root (Join-Path $sandbox "nc-app") -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel 'stable'
    Check "the updater installs nothing from a channel-less manifest" (-not $r.Updated -and -not (Test-Path (Join-Path $sandbox "nc-app\versions\2.5.0"))) $r.Reason
    Publish -Version "2.5.0" -Channel "stable"
    $m = Get-OrcUpdateManifest -BaseUrl $base -PublicKeyXml @($key.PublicXml) -Channel 'stable'
    Check "the same release WITH its channel is accepted" ($m -and $m.version -eq '2.5.0') $script:UpdateRejectReason
}
finally {
    $env:ORC_UPDATE_CHANNEL = $savedChannel
    if ($listener) { try { $listener.Stop(); $listener.Close() } catch { } }
    if ($ps) { try { $ps.Dispose() } catch { } }
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { 'Red' } else { 'Green' })
exit $(if ($fail) { 1 } else { 0 })
