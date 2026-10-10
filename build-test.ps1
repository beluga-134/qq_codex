param(
    [Parameter(Mandatory = $true)][string]$Name
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\env.ps1') -RequireNode -RequireRust -RequireBuildTools
Set-Location $PSScriptRoot
& $NpmCommand run tauri -- build --no-bundle
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$Source = Join-Path $CargoTargetDir 'release\retro-messenger.exe'
$Target = Join-Path $PSScriptRoot "$Name.exe"
Copy-Item -LiteralPath $Source -Destination $Target -Force
Write-Output ("{0} -> {1} bytes" -f $Target, (Get-Item -LiteralPath $Target).Length)
