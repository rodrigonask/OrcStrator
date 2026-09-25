# Renders the update banner in each state to a PNG, using the REAL paint
# handler and Set-UpdateBanner extracted from setup.ps1 (no replica).
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\test-update-banner-render.ps1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$SetupPath = Join-Path $PSScriptRoot "setup.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SetupPath, [ref]$null, [ref]$null)

$fn = $ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Set-UpdateBanner'
}, $true) | Select-Object -First 1
Invoke-Expression $fn.Extent.Text

# Grab the real Add_Paint scriptblock so this renders what users actually see
$paintCall = $ast.FindAll({ param($n)
    $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -eq 'Add_Paint'
}, $true) | Select-Object -First 1
if (-not $paintCall) { throw "Could not find the Add_Paint handler" }
$paintText = $paintCall.Arguments[0].Extent.Text   # includes the outer { }
$paintBlock = [scriptblock]::Create($paintText.Substring(1, $paintText.Length - 2))

# Dark theme values from setup.ps1
$script:IsDarkMode = $true
$script:Green   = [System.Drawing.Color]::FromArgb(0, 200, 100)
$script:Yellow  = [System.Drawing.Color]::FromArgb(230, 180, 40)
$script:Red     = [System.Drawing.Color]::FromArgb(220, 70, 70)
$script:TextDim = [System.Drawing.Color]::FromArgb(140, 140, 155)
$BgPanel = [System.Drawing.Color]::FromArgb(28, 28, 36)
$FontUpdateTitle = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$FontUpdateSub   = New-Object System.Drawing.Font("Segoe UI", 8.5)

$states = @(
    @{ Title = "Up to date";          Sub = "Last updated today";                                                          Key = 'green';  Click = $false },
    @{ Title = "Update available";    Sub = "Click to update. Last updated 3 days ago - 2 new updates";                    Key = 'yellow'; Click = $true  },
    @{ Title = "Sign in to GitHub";   Sub = "OrcStrator could not reach its update source. Click to connect your GitHub account."; Key = 'yellow'; Click = $true  },
    @{ Title = "Update check failed"; Sub = "Could not reach GitHub. Last updated yesterday";                              Key = 'dim';    Click = $false },
    @{ Title = "Updates unavailable"; Sub = "This copy is not a git checkout, so it cannot update itself.";                Key = 'dim';    Click = $false },
    @{ Title = "Update failed";       Sub = "Try running 'git pull' manually in the project folder.";                      Key = 'red';    Click = $false }
)

$form = New-Object System.Windows.Forms.Form
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 18, 24)
$form.ClientSize = New-Object System.Drawing.Size(545, (20 + $states.Count * 62))
$form.FormBorderStyle = "None"

$y = 10
foreach ($s in $states) {
    $btnUpdate = New-Object System.Windows.Forms.Button
    $btnUpdate.Size = New-Object System.Drawing.Size(505, 52)
    $btnUpdate.Location = New-Object System.Drawing.Point(20, $y)
    $btnUpdate.FlatStyle = "Flat"
    $btnUpdate.BackColor = $BgPanel
    $btnUpdate.TextAlign = "MiddleLeft"
    $btnUpdate.Padding = New-Object System.Windows.Forms.Padding(0)

    # The real paint handler reads script-scoped title/sub, so restore this
    # row's own text first. Handlers fire in registration order, so this must
    # be added BEFORE the real one.
    $btnUpdate.Add_Paint({
        param($sender, $e)
        $script:UpdateTitle = $sender.Tag.T
        $script:UpdateSub   = $sender.Tag.U
    })
    $btnUpdate.Add_Paint($paintBlock)
    $form.Controls.Add($btnUpdate)

    if ($s.Click) { Set-UpdateBanner -Title $s.Title -Sub $s.Sub -ColorKey $s.Key -Clickable }
    else          { Set-UpdateBanner -Title $s.Title -Sub $s.Sub -ColorKey $s.Key }
    $btnUpdate.Tag = @{ T = $script:UpdateTitle; U = $script:UpdateSub }
    $y += 62
}

$form.Show()
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 400
[System.Windows.Forms.Application]::DoEvents()

$bmp = New-Object System.Drawing.Bitmap($form.ClientSize.Width, $form.ClientSize.Height)
$form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.ClientSize.Width, $form.ClientSize.Height)))
$out = Join-Path $env:TEMP "orc-update-banner-states.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$form.Close()
Write-Host "Saved: $out"
