[CmdletBinding()]
param(
    # 清空 cargo 构建缓存后全量重建（feature 切换后指纹错乱时用）
    [switch]$Clean,
    # 覆盖编译目标目录（诊断磁盘问题时切到 C:）
    [string]$TargetDir = ''
)

# One-off deploy: fmt + unit tests + release build, then replace formal_2.exe
# (killing the frozen instance) and relaunch it. ASCII-only on purpose.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -RequireNode -RequireRust -RequireBuildTools

if ($TargetDir) {
    $env:CARGO_TARGET_DIR = $TargetDir
    $CargoTargetDir = $TargetDir
    Write-Output "TARGET_DIR=$TargetDir"
}

$Manifest = Join-Path $ProjectRoot 'src-tauri\Cargo.toml'

if ($Clean) {
    & $CargoCommand clean --manifest-path $Manifest
    if ($LASTEXITCODE -ne 0) { Write-Output 'CLEAN_FAIL'; exit 1 }
    Write-Output 'CLEAN_OK'
}

# Frontend must be built with the Windows node: vite 8 (rolldown) ships
# platform-specific native bindings and node_modules only has the win32 one.
& $NpmCommand run build
if ($LASTEXITCODE -ne 0) { Write-Output 'WEB_FAIL'; exit 1 }
Write-Output 'WEB_OK'

& $CargoCommand fmt --all --manifest-path $Manifest
if ($LASTEXITCODE -ne 0) { Write-Output 'FMT_FAIL'; exit 1 }
Write-Output 'FMT_OK'

& $CargoCommand test --locked --manifest-path $Manifest
if ($LASTEXITCODE -ne 0) { Write-Output 'TEST_FAIL'; exit 1 }
Write-Output 'TEST_OK'

# CRITICAL: tauri CLI builds pass --features custom-protocol so generate_context!
# serves frontendDist assets; a bare cargo build omits it and the binary loads
# devUrl (http://127.0.0.1:1420) instead -> ERR_CONNECTION_REFUSED -> blank window.
& $CargoCommand build --release --locked --features custom-protocol --manifest-path $Manifest
if ($LASTEXITCODE -ne 0) { Write-Output 'BUILD_FAIL'; exit 1 }
Write-Output 'BUILD_OK'

$old = Get-Process -Name 'formal_2' -ErrorAction SilentlyContinue
if ($old) {
    $old | Stop-Process -Force
    Start-Sleep -Milliseconds 800
    Write-Output 'KILLED_OLD'
}

$built = Join-Path $CargoTargetDir 'release\retro-messenger.exe'
Copy-Item -LiteralPath $built -Destination (Join-Path $ProjectRoot 'formal_2.exe') -Force
Copy-Item -LiteralPath $built -Destination (Join-Path $ProjectRoot 'retro-messenger.exe') -Force
Write-Output 'COPY_OK'

Start-Process -FilePath (Join-Path $ProjectRoot 'formal_2.exe') -WorkingDirectory $ProjectRoot
Write-Output 'ALL_DONE formal_2 deployed and launched'
