[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1') -RequireNode -RequireRust -RequireGit -RequireBuildTools

Set-Location $ProjectRoot
& $NpmCommand run tauri build
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

# 仓库习惯在根目录保留一份可直接运行的 exe，构建后同步刷新，避免陈旧副本
$BuiltExe = Join-Path $CargoTargetDir 'release\retro-messenger.exe'
if (Test-Path -LiteralPath $BuiltExe -PathType Leaf) {
    Copy-Item -LiteralPath $BuiltExe -Destination (Join-Path $ProjectRoot 'retro-messenger.exe') -Force
    Write-Output "Updated retro-messenger.exe in project root."
}

exit 0
