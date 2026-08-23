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

function Get-DevPortOwners {
    param([Parameter(Mandatory = $true)][int]$Port)

    return @(
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            Where-Object { $_ -gt 0 }
    )
}

function Test-ProjectViteProcess {
    param([Parameter(Mandatory = $true)]$ProcessInfo)

    if ($ProcessInfo.Name -ine 'node.exe') {
        return $false
    }

    $CommandLine = [string]$ProcessInfo.CommandLine
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or $CommandLine -notmatch '(?i)\bvite(?:\.js)?\b') {
        return $false
    }

    $ForwardProjectRoot = $ProjectRoot.Replace('\', '/')
    return $CommandLine.IndexOf($ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $CommandLine.Replace('\', '/').IndexOf($ForwardProjectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Stop-StaleProjectDesktopApp {
    $ExpectedExecutable = [System.IO.Path]::GetFullPath(
        (Join-Path $CargoTargetDir 'debug\retro-messenger.exe')
    )
    $Processes = @(
        Get-CimInstance Win32_Process -Filter "Name = 'retro-messenger.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                [string]::Equals(
                    [System.IO.Path]::GetFullPath($_.ExecutablePath),
                    $ExpectedExecutable,
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
    )
    if ($Processes.Count -eq 0) {
        return
    }

    $TaskKill = Join-Path (Join-Path $env:SystemRoot 'System32') 'taskkill.exe'
    foreach ($ProcessInfo in $Processes) {
        Write-Host "Stopping stale project desktop app (PID $($ProcessInfo.ProcessId))..." -ForegroundColor Yellow
        $null = & $TaskKill /PID $ProcessInfo.ProcessId /T /F 2>&1
    }

    for ($Attempt = 0; $Attempt -lt 30; $Attempt += 1) {
        $StillRunning = @(
            Get-CimInstance Win32_Process -Filter "Name = 'retro-messenger.exe'" -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.ExecutablePath -and
                    [string]::Equals(
                        [System.IO.Path]::GetFullPath($_.ExecutablePath),
                        $ExpectedExecutable,
                        [StringComparison]::OrdinalIgnoreCase
                    )
                }
        )
        if ($StillRunning.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 100
    }

    throw 'The stale project desktop app did not exit in time.'
}

function Stop-StaleProjectDevServer {
    param([Parameter(Mandatory = $true)][int]$Port)

    $OwnerIds = @(Get-DevPortOwners -Port $Port)
    if ($OwnerIds.Count -eq 0) {
        return
    }

    $ForeignOwners = New-Object System.Collections.Generic.List[string]
    foreach ($ProcessId in $OwnerIds) {
        $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
        if (-not $ProcessInfo) {
            # The desktop process can take its parent Vite server down while
            # this scan is running. Treat an already-exited owner as released.
            continue
        }
        if (-not (Test-ProjectViteProcess -ProcessInfo $ProcessInfo)) {
            $ForeignOwners.Add("$($ProcessInfo.Name) (PID $ProcessId)")
            continue
        }

        Write-Host "Stopping stale project Vite server on port $Port (PID $ProcessId)..." -ForegroundColor Yellow
        $TaskKill = Join-Path (Join-Path $env:SystemRoot 'System32') 'taskkill.exe'
        $null = & $TaskKill /PID $ProcessId /T /F 2>&1
    }

    if ($ForeignOwners.Count -gt 0) {
        throw "Port $Port is occupied by another application: $($ForeignOwners -join ', '). It was not terminated."
    }

    for ($Attempt = 0; $Attempt -lt 30; $Attempt += 1) {
        if (@(Get-DevPortOwners -Port $Port).Count -eq 0) {
            Write-Host "Port $Port is ready."
            return
        }
        Start-Sleep -Milliseconds 100
    }

    throw "The stale project dev server did not release port $Port in time."
}

Set-Location $ProjectRoot
Stop-StaleProjectDesktopApp
Stop-StaleProjectDevServer -Port 1420
& $NpmCommand run tauri -- dev @TauriArguments
exit $LASTEXITCODE
