[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$TauriArguments = @()
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -RequireNode -RequireRust -RequireGit -RequireBuildTools -RequireWsl

if (-not (Test-WebView2Runtime)) {
    throw 'Microsoft Edge WebView2 Runtime is missing. Install the Evergreen Runtime before starting the native app.'
}

$TauriCommand = Join-Path $ProjectRoot 'node_modules\.bin\tauri.cmd'
if (-not (Test-Path -LiteralPath $TauriCommand -PathType Leaf)) {
    throw 'Project dependencies are missing. Run scripts\setup-windows.cmd first.'
}

Set-Location $ProjectRoot
& $NpmCommand run tauri -- dev @TauriArguments
exit $LASTEXITCODE
