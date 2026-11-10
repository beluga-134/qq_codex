param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -RequireRust
Set-Location $ProjectRoot
$Manifest = Join-Path $ProjectRoot 'src-tauri\Cargo.toml'

& $CargoCommand fmt --all --manifest-path $Manifest
if ($LASTEXITCODE -ne 0) { Write-Output 'FMT_APPLY_FAIL'; exit 1 }

& $CargoCommand fmt --all --manifest-path $Manifest -- --check
if ($LASTEXITCODE -ne 0) { Write-Output 'FMT_CHECK_FAIL'; exit 1 }

& $CargoCommand test --locked --manifest-path $Manifest 2>&1
if ($LASTEXITCODE -ne 0) { Write-Output 'CARGO_TEST_FAIL'; exit 1 }

Write-Output 'ALL_DONE rust fmt applied + verified + cargo test passed'
