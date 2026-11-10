[CmdletBinding()]
param(
    [switch]$RequireNode,
    [switch]$RequireRust,
    [switch]$RequireGit,
    [switch]$RequireBuildTools,
    [switch]$RequireWsl
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ToolingRoot = Join-Path $ProjectRoot '.tooling'
$WindowsToolingRoot = Join-Path $ToolingRoot 'windows'
$CacheRoot = Join-Path $ProjectRoot '.cache'
$WindowsCacheRoot = Join-Path $CacheRoot 'windows'

$NodeRoot = Join-Path $WindowsToolingRoot 'node'
$CargoHome = Join-Path $WindowsToolingRoot 'cargo'
$RustupHome = Join-Path $WindowsToolingRoot 'rustup'
$PortableGitRoot = Join-Path $WindowsToolingRoot 'portable-git'
$NpmPrefix = Join-Path $WindowsToolingRoot 'npm-global'
$VsBuildToolsRoot = Join-Path $WindowsToolingRoot 'vs-build-tools'

$NpmCache = Join-Path $WindowsCacheRoot 'npm'
$CargoTargetDir = Join-Path $WindowsCacheRoot 'cargo-target'
$DownloadCache = Join-Path $WindowsCacheRoot 'downloads'
$TempRoot = Join-Path $WindowsCacheRoot 'tmp'
$NodeCache = Join-Path $WindowsCacheRoot 'node'
$CorepackCache = Join-Path $WindowsCacheRoot 'corepack'

$LocalDirectories = @(
    $WindowsToolingRoot,
    $WindowsCacheRoot,
    $CargoHome,
    $RustupHome,
    $NpmPrefix,
    $NpmCache,
    $CargoTargetDir,
    $DownloadCache,
    $TempRoot,
    $NodeCache,
    $CorepackCache
)

foreach ($Directory in $LocalDirectories) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    }
}

function Write-Utf8WithoutBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $Encoding)
}

function Convert-ToForwardSlashPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path.Replace('\', '/')
}

$NpmRcPath = Join-Path $WindowsToolingRoot 'npmrc'
$NpmRcContent = @(
    'cache=' + (Convert-ToForwardSlashPath $NpmCache),
    'prefix=' + (Convert-ToForwardSlashPath $NpmPrefix),
    'registry=https://registry.npmmirror.com',
    'audit=false',
    'fund=false',
    'update-notifier=false'
) -join "`n"
Write-Utf8WithoutBom -Path $NpmRcPath -Content ($NpmRcContent + "`n")

$CargoConfigPath = Join-Path $CargoHome 'config.toml'
$CargoConfigContent = @'
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
'@
Write-Utf8WithoutBom -Path $CargoConfigPath -Content ($CargoConfigContent.Trim() + "`n")

$env:PROJECT_ROOT = $ProjectRoot
$env:RUSTUP_HOME = $RustupHome
$env:CARGO_HOME = $CargoHome
$env:CARGO_TARGET_DIR = $CargoTargetDir
$env:RUSTUP_DIST_SERVER = 'https://rsproxy.cn'
$env:RUSTUP_UPDATE_ROOT = 'https://rsproxy.cn/rustup'
$env:CARGO_REGISTRIES_CRATES_IO_PROTOCOL = 'sparse'
$env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'

$env:NPM_CONFIG_USERCONFIG = $NpmRcPath
$env:NPM_CONFIG_CACHE = $NpmCache
$env:NPM_CONFIG_PREFIX = $NpmPrefix
$env:NPM_CONFIG_REGISTRY = 'https://registry.npmmirror.com'
$env:NPM_CONFIG_AUDIT = 'false'
$env:NPM_CONFIG_FUND = 'false'
$env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
$env:NODE_REPL_HISTORY = Join-Path $NodeCache 'repl_history'
$env:COREPACK_HOME = $CorepackCache

function Find-VsDevCmd {
    $Candidates = New-Object System.Collections.Generic.List[string]
    $Candidates.Add((Join-Path $VsBuildToolsRoot 'Common7\Tools\VsDevCmd.bat'))

    if (${env:ProgramFiles(x86)}) {
        $Candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'))
    }
    if ($env:ProgramFiles) {
        $Candidates.Add((Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'))
    }

    foreach ($Candidate in $Candidates) {
        if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
            return [System.IO.Path]::GetFullPath($Candidate)
        }
    }

    $VsWhereCandidates = New-Object System.Collections.Generic.List[string]
    if (${env:ProgramFiles(x86)}) {
        $VsWhereCandidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'))
    }
    if ($env:ProgramFiles) {
        $VsWhereCandidates.Add((Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe'))
    }

    foreach ($VsWhere in $VsWhereCandidates) {
        if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) {
            continue
        }

        $InstallPaths = @(& $VsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
        if ($LASTEXITCODE -ne 0) {
            continue
        }

        foreach ($InstallPath in $InstallPaths) {
            if (-not [string]::IsNullOrWhiteSpace($InstallPath)) {
                $DevCmd = Join-Path $InstallPath.Trim() 'Common7\Tools\VsDevCmd.bat'
                if (Test-Path -LiteralPath $DevCmd -PathType Leaf) {
                    return [System.IO.Path]::GetFullPath($DevCmd)
                }
            }
        }
    }

    return $null
}

function Import-VsDeveloperEnvironment {
    param([Parameter(Mandatory = $true)][string]$DevCmdPath)

    $Command = 'call "{0}" -no_logo -arch=x64 -host_arch=x64 >nul && set' -f $DevCmdPath
    $EnvironmentLines = @(& $env:ComSpec /d /s /c $Command)
    if ($LASTEXITCODE -ne 0) {
        throw "Visual Studio developer environment failed to load from: $DevCmdPath"
    }

    foreach ($Line in $EnvironmentLines) {
        $Separator = $Line.IndexOf('=')
        if ($Separator -le 0) {
            continue
        }

        $Name = $Line.Substring(0, $Separator)
        if ($Name.StartsWith('=')) {
            continue
        }
        $Value = $Line.Substring($Separator + 1)
        [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    }
}

function New-BuildToolsStatus {
    param(
        [Parameter(Mandatory = $true)][bool]$Ready,
        [Parameter(Mandatory = $true)][string]$Reason
    )

    return [PSCustomObject]@{
        Ready = $Ready
        Reason = $Reason
    }
}

function Get-MsvcBuildEnvironmentStatus {
    $RequiredEnvironment = @('VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'INCLUDE', 'LIB')
    foreach ($VariableName in $RequiredEnvironment) {
        $Value = [Environment]::GetEnvironmentVariable($VariableName, 'Process')
        if ([string]::IsNullOrWhiteSpace($Value)) {
            return New-BuildToolsStatus -Ready $false -Reason "missing environment variable $VariableName"
        }
    }

    if (-not (Test-Path -LiteralPath $env:VCToolsInstallDir -PathType Container)) {
        return New-BuildToolsStatus -Ready $false -Reason "VCToolsInstallDir does not exist: $env:VCToolsInstallDir"
    }
    if (-not (Test-Path -LiteralPath $env:WindowsSdkDir -PathType Container)) {
        return New-BuildToolsStatus -Ready $false -Reason "WindowsSdkDir does not exist: $env:WindowsSdkDir"
    }

    $Tools = @{}
    foreach ($ToolName in @('cl.exe', 'link.exe', 'rc.exe', 'mt.exe')) {
        $Tool = Get-Command $ToolName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $Tool) {
            return New-BuildToolsStatus -Ready $false -Reason "required build tool is unavailable: $ToolName"
        }
        $Tools[$ToolName] = $Tool.Source
    }

    $ProbeRoot = Join-Path $TempRoot ('msvc-probe-' + [Guid]::NewGuid().ToString('N'))
    $SourcePath = Join-Path $ProbeRoot 'probe.c'
    $ResourceScriptPath = Join-Path $ProbeRoot 'probe.rc'
    $ObjectPath = Join-Path $ProbeRoot 'probe.obj'
    $ResourcePath = Join-Path $ProbeRoot 'probe.res'
    $ExecutablePath = Join-Path $ProbeRoot 'probe.exe'

    $Source = @'
#include <windows.h>
int main(void) { return GetModuleHandleW(NULL) == NULL; }
'@
    $ResourceScript = @'
1 VERSIONINFO
FILEVERSION 1,0,0,0
PRODUCTVERSION 1,0,0,0
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "FileDescription", "qq-codex build probe"
    END
  END
END
'@

    try {
        New-Item -ItemType Directory -Path $ProbeRoot -Force | Out-Null
        Write-Utf8WithoutBom -Path $SourcePath -Content ($Source.Trim() + "`n")
        Write-Utf8WithoutBom -Path $ResourceScriptPath -Content ($ResourceScript.Trim() + "`n")

        $CompilerOutput = @(& $Tools['cl.exe'] /nologo /WX /c "/Fo$ObjectPath" $SourcePath 2>&1)
        $CompilerExitCode = $LASTEXITCODE
        if ($CompilerExitCode -ne 0 -or -not (Test-Path -LiteralPath $ObjectPath -PathType Leaf)) {
            return New-BuildToolsStatus -Ready $false -Reason ("cl.exe probe failed ($CompilerExitCode): " + ($CompilerOutput -join ' '))
        }

        $ResourceOutput = @(& $Tools['rc.exe'] /nologo /fo $ResourcePath $ResourceScriptPath 2>&1)
        $ResourceExitCode = $LASTEXITCODE
        if ($ResourceExitCode -ne 0 -or -not (Test-Path -LiteralPath $ResourcePath -PathType Leaf)) {
            return New-BuildToolsStatus -Ready $false -Reason ("rc.exe probe failed ($ResourceExitCode): " + ($ResourceOutput -join ' '))
        }

        $LinkerOutput = @(& $Tools['link.exe'] /nologo "/out:$ExecutablePath" /machine:x64 $ObjectPath $ResourcePath kernel32.lib 2>&1)
        $LinkerExitCode = $LASTEXITCODE
        if ($LinkerExitCode -ne 0 -or -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
            return New-BuildToolsStatus -Ready $false -Reason ("link.exe probe failed ($LinkerExitCode): " + ($LinkerOutput -join ' '))
        }

        return New-BuildToolsStatus -Ready $true -Reason 'MSVC compiler, linker, resource compiler, and Windows SDK are usable'
    }
    catch {
        return New-BuildToolsStatus -Ready $false -Reason ("build probe failed: " + $_.Exception.Message)
    }
    finally {
        if (Test-Path -LiteralPath $ProbeRoot) {
            Remove-Item -LiteralPath $ProbeRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$VsDevCmdPath = Find-VsDevCmd
if ($VsDevCmdPath) {
    Import-VsDeveloperEnvironment -DevCmdPath $VsDevCmdPath
}

$PathCandidates = @(
    $NpmPrefix,
    $NodeRoot,
    (Join-Path $CargoHome 'bin'),
    (Join-Path $PortableGitRoot 'cmd')
)
$ExistingPathEntries = @()
if ($env:Path) {
    $ExistingPathEntries = @($env:Path -split ';')
}

$PathSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$MergedPath = New-Object System.Collections.Generic.List[string]
foreach ($PathEntry in @($PathCandidates + $ExistingPathEntries)) {
    if ([string]::IsNullOrWhiteSpace($PathEntry)) {
        continue
    }
    $TrimmedEntry = $PathEntry.Trim()
    if ($PathSet.Add($TrimmedEntry)) {
        $MergedPath.Add($TrimmedEntry)
    }
}
$env:Path = $MergedPath -join ';'

$NodeCommand = Join-Path $NodeRoot 'node.exe'
$BundledNpmCommand = Join-Path $NodeRoot 'npm.cmd'
$LocalNpmCommand = Join-Path $NpmPrefix 'npm.cmd'
$NpmCommand = $BundledNpmCommand
if (Test-Path -LiteralPath $LocalNpmCommand -PathType Leaf) {
    $NpmCommand = $LocalNpmCommand
}
$CargoCommand = Join-Path (Join-Path $CargoHome 'bin') 'cargo.exe'
$RustcCommand = Join-Path (Join-Path $CargoHome 'bin') 'rustc.exe'
$RustupCommand = Join-Path (Join-Path $CargoHome 'bin') 'rustup.exe'
$GitCommand = Join-Path (Join-Path $PortableGitRoot 'cmd') 'git.exe'
$WslCommand = Join-Path (Join-Path $env:SystemRoot 'System32') 'wsl.exe'

function Invoke-WslProbe {
    param(
        [Parameter(Mandatory = $true)][string]$ShellCommand,
        [switch]$InteractiveLogin,
        [int]$TimeoutMilliseconds = 12000
    )

    if (-not (Test-Path -LiteralPath $WslCommand -PathType Leaf)) {
        return [PSCustomObject]@{
            Succeeded = $false
            TimedOut = $false
            ExitCode = $null
            Output = ''
            Error = 'wsl.exe was not found'
        }
    }

    if ($ShellCommand.Contains('"')) {
        throw 'WSL probe commands must not contain double quotes.'
    }

    $ShellMode = '-lc'
    if ($InteractiveLogin) {
        $ShellMode = '-lic'
    }

    $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $WslCommand
    $StartInfo.Arguments = "--exec bash $ShellMode `"$ShellCommand`""
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    $Utf8 = New-Object System.Text.UTF8Encoding($false)
    $StartInfo.StandardOutputEncoding = $Utf8
    $StartInfo.StandardErrorEncoding = $Utf8

    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = $StartInfo
    $OutputTask = $null
    $ErrorTask = $null
    try {
        if (-not $Process.Start()) {
            throw 'wsl.exe did not start'
        }
        $OutputTask = $Process.StandardOutput.ReadToEndAsync()
        $ErrorTask = $Process.StandardError.ReadToEndAsync()

        if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
            $TaskKill = Join-Path (Join-Path $env:SystemRoot 'System32') 'taskkill.exe'
            if (Test-Path -LiteralPath $TaskKill -PathType Leaf) {
                $null = & $TaskKill /PID $Process.Id /T /F 2>&1
            }
            if (-not $Process.WaitForExit(3000)) {
                try { $Process.Kill() } catch { }
                $null = $Process.WaitForExit(2000)
            }
            return [PSCustomObject]@{
                Succeeded = $false
                TimedOut = $true
                ExitCode = $null
                Output = ''
                Error = "WSL probe timed out after $TimeoutMilliseconds ms"
            }
        }

        $Process.WaitForExit()
        if (-not $OutputTask.Wait(2000) -or -not $ErrorTask.Wait(2000)) {
            return [PSCustomObject]@{
                Succeeded = $false
                TimedOut = $true
                ExitCode = $Process.ExitCode
                Output = ''
                Error = 'WSL probe output streams did not close in time'
            }
        }
        $Output = $OutputTask.Result.Trim()
        $ErrorOutput = $ErrorTask.Result.Trim()
        return [PSCustomObject]@{
            Succeeded = ($Process.ExitCode -eq 0)
            TimedOut = $false
            ExitCode = $Process.ExitCode
            Output = $Output
            Error = $ErrorOutput
        }
    }
    catch {
        return [PSCustomObject]@{
            Succeeded = $false
            TimedOut = $false
            ExitCode = $null
            Output = ''
            Error = $_.Exception.Message
        }
    }
    finally {
        $Process.Dispose()
    }
}

function Test-WslAvailable {
    $Probe = Invoke-WslProbe -ShellCommand 'exit 0'
    return $Probe.Succeeded
}

function Test-WslCodexAvailable {
    $Probe = Invoke-WslProbe -ShellCommand 'command -v codex >/dev/null 2>&1' -InteractiveLogin
    return $Probe.Succeeded
}

function Get-WslCodexVersion {
    $Probe = Invoke-WslProbe -ShellCommand 'codex --version' -InteractiveLogin
    if (-not $Probe.Succeeded) {
        return $null
    }
    return $Probe.Output
}

function Test-WebView2Runtime {
    $ClientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $RegistryPaths = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$ClientId",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$ClientId",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$ClientId"
    )

    foreach ($RegistryPath in $RegistryPaths) {
        if (-not (Test-Path -LiteralPath $RegistryPath)) {
            continue
        }
        $Properties = Get-ItemProperty -LiteralPath $RegistryPath -Name 'pv' -ErrorAction SilentlyContinue
        if ($Properties -and -not [string]::IsNullOrWhiteSpace($Properties.pv) -and $Properties.pv -ne '0.0.0.0') {
            return $true
        }
    }
    return $false
}

if ($RequireNode -and -not (Test-Path -LiteralPath $NodeCommand -PathType Leaf)) {
    throw 'Project-local Node is missing. Run scripts\setup-windows.cmd first.'
}
if ($RequireRust -and ((-not (Test-Path -LiteralPath $CargoCommand -PathType Leaf)) -or (-not (Test-Path -LiteralPath $RustcCommand -PathType Leaf)))) {
    throw 'Project-local Rust is missing. Run scripts\setup-windows.cmd first.'
}
if ($RequireGit -and -not (Test-Path -LiteralPath $GitCommand -PathType Leaf)) {
    throw 'Project-local PortableGit is missing. Run scripts\setup-windows.cmd first.'
}
if ($RequireBuildTools) {
    $BuildToolsStatus = Get-MsvcBuildEnvironmentStatus
    if (-not $BuildToolsStatus.Ready) {
        throw "MSVC Build Tools or the Windows SDK are incomplete: $($BuildToolsStatus.Reason). Run scripts\setup-windows.cmd -InstallBuildTools, or repair the Desktop C++ workload."
    }
}
if ($RequireWsl -and -not (Test-WslAvailable)) {
    throw 'A usable default WSL distribution with bash is required. Install or initialize WSL, then verify it with: wsl.exe --exec bash -lc "exit 0"'
}
