[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -RequireNode

$ViteCommand = Join-Path $ProjectRoot 'node_modules\.bin\vite.cmd'
if (-not (Test-Path -LiteralPath $ViteCommand -PathType Leaf)) {
    throw 'Project dependencies are missing. Run scripts\setup-windows.cmd first.'
}

Set-Location $ProjectRoot
& $NpmCommand run dev
exit $LASTEXITCODE
