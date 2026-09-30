# Authenticode signing is wired into the release, switched on by its
# settings, and skipped with a visible notice while they do not exist.
# Pure: synthetic settings, temp files; downloads the pinned Microsoft signing
# client once to prove the pin is right. Signs nothing.
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\release\unit-codesign.ps1
param([string]$RepoRoot = "")

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
. (Join-Path $RepoRoot "installer\release\release-lib.ps1")

$pass = 0; $fail = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = "")
    if ($Ok) { $script:pass++; Write-Host "  PASS  $Name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $Name  $Detail" -ForegroundColor Red }
}

$have = [bool](Get-Command Get-OrcCodeSigningConfig -ErrorAction SilentlyContinue)
Check "release-lib has the code-signing helpers" $have
if ($have) {
    Write-Host "`n== Settings ==" -ForegroundColor Cyan
    $none = Get-OrcCodeSigningConfig -Environment @{}
    Check "no settings: signing is off" (-not $none.Enabled)
    Check "no settings: all six are named as missing" ($none.Missing.Count -eq 6) ($none.Missing -join ', ')
    $full = @{
        ORC_CODESIGN_ENDPOINT = 'https://eus.codesigning.azure.net/'; ORC_CODESIGN_ACCOUNT = 'example-signing'
        ORC_CODESIGN_PROFILE = 'example-profile'; AZURE_TENANT_ID = 'fake-tenant'; AZURE_CLIENT_ID = 'fake-client'
        AZURE_CLIENT_SECRET = 'fake-secret-not-real'
    }
    $on = Get-OrcCodeSigningConfig -Environment $full
    Check "all settings: signing is on" ($on.Enabled) ($on.Missing -join ', ')
    Check "the result never carries the client secret" (-not (($on | ConvertTo-Json) -match 'fake-secret-not-real'))
    $partial = $full.Clone(); $partial.Remove('AZURE_CLIENT_SECRET')
    $p = Get-OrcCodeSigningConfig -Environment $partial
    Check "one secret missing: off, and it says which" ((-not $p.Enabled) -and ($p.Missing -contains 'AZURE_CLIENT_SECRET'))
    $bad = $full.Clone(); $bad.ORC_CODESIGN_ENDPOINT = 'http://evil.example.com/'
    Check "an endpoint that is not Azure's signing service is refused" (-not (Get-OrcCodeSigningConfig -Environment $bad).Enabled)
    $bad = $full.Clone(); $bad.ORC_CODESIGN_PROFILE = 'x" /tr http://evil'
    Check "a profile name that could inject signtool arguments is refused" (-not (Get-OrcCodeSigningConfig -Environment $bad).Enabled)

    Write-Host "`n== signtool command ==" -ForegroundColor Cyan
    $setup = @{ SignTool = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe'; Dlib = 'C:\t\client\bin\x64\Azure.CodeSigning.Dlib.dll'; Metadata = 'C:\t\codesign-metadata.json' }
    $a = Get-OrcSignToolArguments -Setup $setup -File 'C:\out\OrcStrator.exe'
    $s = $a -join ' '
    Check "SHA-256 file digest" ($s -match '/fd SHA256')
    Check "RFC 3161 timestamp from Microsoft, SHA-256" ($s -match '/tr http://timestamp\.acs\.microsoft\.com /td SHA256')
    Check "the Azure dlib and its metadata" (($a -contains '/dlib') -and ($a -contains $setup.Dlib) -and ($a -contains '/dmdf') -and ($a -contains $setup.Metadata))
    Check "the file is the last argument" ($a[-1] -eq 'C:\out\OrcStrator.exe')
    $inno = Get-OrcInnoSignToolCommand -Setup $setup
    Check "Inno command quotes the tool path and signs `$f" ($inno.StartsWith('$q' + $setup.SignTool + '$q ') -and $inno.EndsWith(' $f'))
    Check "Inno command quotes the dlib path" ($inno -match [regex]::Escape('$q' + $setup.Dlib + '$q'))

    Write-Host "`n== The signing client is pinned ==" -ForegroundColor Cyan
    $tmp = Join-Path $env:TEMP "orc-unit-cs-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        $fakePkg = Join-Path $tmp 'fake.nupkg'
        [System.IO.File]::WriteAllBytes($fakePkg, [byte[]](1..100))
        $threw = $false
        try { Get-OrcSigningClient -Dir (Join-Path $tmp 'a') -Url ([Uri]$fakePkg).AbsoluteUri | Out-Null } catch { $threw = $_.Exception.Message -match 'not the pinned' }
        Check "a package whose sha256 is not the pinned one is refused before it is opened" $threw
        Check "the refused package is deleted" (-not (Test-Path (Join-Path $tmp 'a\signing-client.nupkg')))
        $dlib = $null
        try { $dlib = Get-OrcSigningClient -Dir (Join-Path $tmp 'real') } catch { Write-Host "    $_" -ForegroundColor DarkGray }
        Check "the pinned URL downloads the pinned bytes and yields the x64 dlib" ([bool]$dlib -and (Test-Path $dlib)) "$dlib"
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

    Write-Host "`n== Signature check ==" -ForegroundColor Cyan
    $unsigned = Join-Path $env:TEMP "orc-unit-cs-$([guid]::NewGuid().ToString('N').Substring(0,8)).exe"
    [System.IO.File]::WriteAllBytes($unsigned, [byte[]](77, 90) + [byte[]](1..200))
    $threw = $false; try { Assert-OrcCodeSigned -File $unsigned } catch { $threw = $true }
    Remove-Item $unsigned -Force -ErrorAction SilentlyContinue
    Check "an unsigned exe fails the after-signing check" $threw
}

Write-Host "`n== Wiring ==" -ForegroundColor Cyan
$read = { param($rel) $p = Join-Path $RepoRoot $rel; if (Test-Path $p) { [System.IO.File]::ReadAllText($p) } else { '' } }
$sign = & $read 'installer\release\Sign-Release.ps1'
$bi = & $read 'installer\release\Build-Installer.ps1'
$iss = & $read 'installer\OrcStrator.iss'
# The release workflow's side of the wiring (the sign step's settings, the
# publish gate) is checked by the private release workflow's own test.
Check "Sign-Release turns signing on from the settings" ($sign -match 'Get-OrcCodeSigningConfig' -and $sign -match 'New-OrcCodeSigningSetup')
Check "Sign-Release shows a GitHub notice when signing is skipped" ($sign -match '::notice title=Installer not code-signed::')
Check "Build-Installer signs the starter and checks the setup exe" ($bi -match 'Invoke-OrcCodeSign -Setup \$CodeSign -File \$exeOut' -and $bi -match 'Assert-OrcCodeSigned -File \$exe')
Check "Build-Installer hands the sign tool to Inno" ($bi -match '/SOrcSign=' -and $bi -match '/DCodeSign=1')
Check "the Inno script signs the setup and the uninstaller when asked" ($iss -match '(?s)#ifdef CodeSign\s+SignTool=OrcSign\s+SignedUninstaller=yes\s+#endif')

Write-Host "`n$pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
exit 0
