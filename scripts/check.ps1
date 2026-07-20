[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -RequireNode -RequireRust -RequireGit -RequireBuildTools

$TscCommand = Join-Path $ProjectRoot 'node_modules\.bin\tsc.cmd'
if (-not (Test-Path -LiteralPath $TscCommand -PathType Leaf)) {
    throw 'Project dependencies are missing. Run scripts\setup-windows.cmd first.'
}

Set-Location $ProjectRoot
& $NpmCommand run build
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $CargoCommand fmt --all --manifest-path (Join-Path $ProjectRoot 'src-tauri\Cargo.toml') -- --check
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $CargoCommand test --locked --manifest-path (Join-Path $ProjectRoot 'src-tauri\Cargo.toml')
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $CargoCommand check --locked --manifest-path (Join-Path $ProjectRoot 'src-tauri\Cargo.toml')
exit $LASTEXITCODE
