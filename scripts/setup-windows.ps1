[CmdletBinding()]
param(
    [switch]$InstallBuildTools,
    [switch]$SkipProjectDependencies
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$NodeVersion = '22.22.2'
$NpmVersion = '10.9.7'
$GitVersion = '2.55.0.3'
$GitRelease = '2.55.0.windows.3'
$GitArchiveSha256 = 'f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05'
$WindowsSdkComponent = 'Microsoft.VisualStudio.Component.Windows11SDK.26100'
$ManagedMarker = '.qq-codex-managed'
$NpmRegistry = 'https://registry.npmmirror.com'

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'This setup requires 64-bit Windows.'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

. (Join-Path $PSScriptRoot 'env.ps1')

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $false)][string[]]$ArgumentList = @()
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($ArgumentList -join ' ')"
    }
}

function Download-File {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination,
        [switch]$Refresh
    )

    if ((-not $Refresh) -and (Test-Path -LiteralPath $Destination -PathType Leaf)) {
        return
    }

    $Parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $Parent -PathType Container)) {
        New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    }

    $Partial = $Destination + '.part-' + [Guid]::NewGuid().ToString('N')
    Write-Host "Downloading $Url"
    $Client = New-Object System.Net.WebClient
    $Client.Headers.Add('User-Agent', 'qq-codex-windows-setup/1.0')
    try {
        $Client.DownloadFile($Url, $Partial)
        if ((Get-Item -LiteralPath $Partial).Length -le 0) {
            throw "Downloaded file is empty: $Url"
        }
        Move-Item -LiteralPath $Partial -Destination $Destination -Force
    }
    finally {
        $Client.Dispose()
        if (Test-Path -LiteralPath $Partial) {
            Remove-Item -LiteralPath $Partial -Force
        }
    }
}

function Get-ExpectedHash {
    param(
        [Parameter(Mandatory = $true)][string]$ChecksumFile,
        [Parameter(Mandatory = $true)][string]$FileName
    )

    $Pattern = '(?im)^([0-9a-f]{64})\s+\*?' + [regex]::Escape($FileName) + '\s*$'
    $Match = [regex]::Match([System.IO.File]::ReadAllText($ChecksumFile), $Pattern)
    if (-not $Match.Success) {
        throw "No SHA-256 entry for $FileName in $ChecksumFile"
    }
    return $Match.Groups[1].Value.ToLowerInvariant()
}

function Get-FirstHash {
    param([Parameter(Mandatory = $true)][string]$ChecksumFile)

    $Match = [regex]::Match([System.IO.File]::ReadAllText($ChecksumFile), '(?i)\b([0-9a-f]{64})\b')
    if (-not $Match.Success) {
        throw "No SHA-256 value found in $ChecksumFile"
    }
    return $Match.Groups[1].Value.ToLowerInvariant()
}

function Assert-FileHash {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedHash
    )

    $ActualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash.ToLowerInvariant()) {
        throw "SHA-256 mismatch for $Path. Expected $ExpectedHash, got $ActualHash."
    }
}

function Assert-MicrosoftSignature {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Signature = Get-AuthenticodeSignature -FilePath $Path
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode validation failed for $Path`: $($Signature.StatusMessage)"
    }
    if (-not $Signature.SignerCertificate -or $Signature.SignerCertificate.Subject -notmatch 'Microsoft') {
        throw "The executable is not signed by Microsoft: $Path"
    }
}

function Replace-ManagedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path -LiteralPath $Candidate -PathType Container)) {
        throw "Managed directory candidate does not exist: $Candidate"
    }
    [System.IO.File]::WriteAllText((Join-Path $Candidate $ManagedMarker), $Description)

    $Backup = $null
    if (Test-Path -LiteralPath $Destination) {
        $Marker = Join-Path $Destination $ManagedMarker
        if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
            throw "$Description already exists but is not setup-managed: $Destination"
        }
        $Backup = $Destination + '.backup-' + [Guid]::NewGuid().ToString('N')
        Move-Item -LiteralPath $Destination -Destination $Backup
    }

    try {
        Move-Item -LiteralPath $Candidate -Destination $Destination
    }
    catch {
        if ((-not (Test-Path -LiteralPath $Destination)) -and $Backup -and (Test-Path -LiteralPath $Backup)) {
            Move-Item -LiteralPath $Backup -Destination $Destination
        }
        throw
    }

    if ($Backup -and (Test-Path -LiteralPath $Backup)) {
        Remove-Item -LiteralPath $Backup -Recurse -Force
    }
}

function Install-Node {
    $ExpectedVersion = 'v' + $NodeVersion
    if ((Test-Path -LiteralPath $NodeCommand -PathType Leaf) -and (Test-Path -LiteralPath $BundledNpmCommand -PathType Leaf)) {
        $CurrentVersion = (& $NodeCommand --version 2>$null)
        if ($LASTEXITCODE -eq 0 -and $CurrentVersion -eq $ExpectedVersion) {
            Write-Host "Node $NodeVersion is already installed at $NodeRoot"
            return
        }
    }

    $ArchiveBase = "node-v$NodeVersion-win-x64"
    $ArchiveName = $ArchiveBase + '.zip'
    $MirrorBase = "https://npmmirror.com/mirrors/node/v$NodeVersion"
    $ArchivePath = Join-Path $DownloadCache $ArchiveName
    $ChecksumPath = Join-Path $DownloadCache "node-v$NodeVersion-SHASUMS256.txt"

    $ValidCachedPair = $false
    if ((Test-Path -LiteralPath $ChecksumPath -PathType Leaf) -and (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
        try {
            $ExpectedHash = Get-ExpectedHash -ChecksumFile $ChecksumPath -FileName $ArchiveName
            Assert-FileHash -Path $ArchivePath -ExpectedHash $ExpectedHash
            $ValidCachedPair = $true
        }
        catch {
            $ValidCachedPair = $false
        }
    }

    if (-not $ValidCachedPair) {
        Download-File -Url "$MirrorBase/SHASUMS256.txt" -Destination $ChecksumPath -Refresh
        $ExpectedHash = Get-ExpectedHash -ChecksumFile $ChecksumPath -FileName $ArchiveName
        if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
            try {
                Assert-FileHash -Path $ArchivePath -ExpectedHash $ExpectedHash
            }
            catch {
                Remove-Item -LiteralPath $ArchivePath -Force
            }
        }
        Download-File -Url "$MirrorBase/$ArchiveName" -Destination $ArchivePath
        Assert-FileHash -Path $ArchivePath -ExpectedHash $ExpectedHash
    }

    $StageRoot = Join-Path $TempRoot ('node-' + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $StageRoot -Force
        $Candidate = Join-Path $StageRoot $ArchiveBase
        $CandidateNode = Join-Path $Candidate 'node.exe'
        if (-not (Test-Path -LiteralPath $CandidateNode -PathType Leaf)) {
            throw "Node archive has an unexpected layout: $ArchivePath"
        }
        $CandidateVersion = (& $CandidateNode --version)
        if ($LASTEXITCODE -ne 0 -or $CandidateVersion -ne $ExpectedVersion) {
            throw "Extracted Node version is invalid: $CandidateVersion"
        }
        Replace-ManagedDirectory -Candidate $Candidate -Destination $NodeRoot -Description "Node $NodeVersion win-x64"
    }
    finally {
        if (Test-Path -LiteralPath $StageRoot) {
            Remove-Item -LiteralPath $StageRoot -Recurse -Force
        }
    }
}

function Install-PortableGit {
    if (Test-Path -LiteralPath $GitCommand -PathType Leaf) {
        $CurrentVersion = (& $GitCommand --version 2>$null)
        if ($LASTEXITCODE -eq 0 -and $CurrentVersion.ToString().Trim() -eq "git version $GitRelease") {
            Write-Host "$CurrentVersion is already installed at $PortableGitRoot"
            return
        }
    }

    $ArchiveName = "MinGit-$GitVersion-64-bit.zip"
    $MirrorBase = "https://registry.npmmirror.com/-/binary/git-for-windows/v$GitRelease"
    $ArchivePath = Join-Path $DownloadCache $ArchiveName

    if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
        try {
            Assert-FileHash -Path $ArchivePath -ExpectedHash $GitArchiveSha256
        }
        catch {
            Remove-Item -LiteralPath $ArchivePath -Force
        }
    }
    Download-File -Url "$MirrorBase/$ArchiveName" -Destination $ArchivePath
    Assert-FileHash -Path $ArchivePath -ExpectedHash $GitArchiveSha256

    $StageRoot = Join-Path $TempRoot ('portable-git-' + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $StageRoot -Force
        $CandidateGit = Join-Path $StageRoot 'cmd\git.exe'
        if (-not (Test-Path -LiteralPath $CandidateGit -PathType Leaf)) {
            throw "PortableGit archive has an unexpected layout: $ArchivePath"
        }
        $CandidateVersion = (& $CandidateGit --version)
        if ($LASTEXITCODE -ne 0 -or $CandidateVersion.ToString().Trim() -ne "git version $GitRelease") {
            throw "Extracted MinGit version is invalid: $CandidateVersion"
        }
        Replace-ManagedDirectory -Candidate $StageRoot -Destination $PortableGitRoot -Description "MinGit $GitVersion x64"
    }
    finally {
        if (Test-Path -LiteralPath $StageRoot) {
            Remove-Item -LiteralPath $StageRoot -Recurse -Force
        }
    }
}

function Install-Rust {
    if ((Test-Path -LiteralPath $CargoCommand -PathType Leaf) -and
        (Test-Path -LiteralPath $RustcCommand -PathType Leaf) -and
        (Test-Path -LiteralPath $RustupCommand -PathType Leaf)) {
        $RustVersion = (& $RustcCommand --version 2>$null)
        $RustExitCode = $LASTEXITCODE
        $ActiveToolchain = (& $RustupCommand show active-toolchain 2>$null)
        $RustupExitCode = $LASTEXITCODE
        if ($RustExitCode -eq 0 -and $RustupExitCode -eq 0 -and $ActiveToolchain.ToString().Trim() -match '^stable-x86_64-pc-windows-msvc\b') {
            Write-Host "$RustVersion is already installed under $CargoHome"
            return
        }
    }

    $RustupInstaller = Join-Path $DownloadCache 'rustup-init.exe'
    $RustupChecksum = Join-Path $DownloadCache 'rustup-init.exe.sha256'
    $RustupBaseUrl = 'https://rsproxy.cn/rustup/dist/x86_64-pc-windows-msvc'
    $ValidCachedPair = $false
    if ((Test-Path -LiteralPath $RustupChecksum -PathType Leaf) -and (Test-Path -LiteralPath $RustupInstaller -PathType Leaf)) {
        try {
            $ExpectedHash = Get-FirstHash -ChecksumFile $RustupChecksum
            Assert-FileHash -Path $RustupInstaller -ExpectedHash $ExpectedHash
            $ValidCachedPair = $true
        }
        catch {
            $ValidCachedPair = $false
        }
    }

    if (-not $ValidCachedPair) {
        Download-File -Url "$RustupBaseUrl/rustup-init.exe.sha256" -Destination $RustupChecksum -Refresh
        $ExpectedHash = Get-FirstHash -ChecksumFile $RustupChecksum
        if (Test-Path -LiteralPath $RustupInstaller -PathType Leaf) {
            try {
                Assert-FileHash -Path $RustupInstaller -ExpectedHash $ExpectedHash
            }
            catch {
                Remove-Item -LiteralPath $RustupInstaller -Force
            }
        }
        Download-File -Url "$RustupBaseUrl/rustup-init.exe" -Destination $RustupInstaller
        Assert-FileHash -Path $RustupInstaller -ExpectedHash $ExpectedHash
    }
    Invoke-Checked -FilePath $RustupInstaller -ArgumentList @(
        '-y',
        '--no-modify-path',
        '--profile', 'minimal',
        '--default-host', 'x86_64-pc-windows-msvc',
        '--default-toolchain', 'stable'
    )

    if ((-not (Test-Path -LiteralPath $CargoCommand -PathType Leaf)) -or (-not (Test-Path -LiteralPath $RustcCommand -PathType Leaf))) {
        throw "rustup completed but cargo/rustc was not created under $CargoHome"
    }
}

function Install-Rustfmt {
    $RustfmtCommand = Join-Path (Join-Path $CargoHome 'bin') 'rustfmt.exe'
    if (Test-Path -LiteralPath $RustfmtCommand -PathType Leaf) {
        $null = & $RustfmtCommand --version 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "rustfmt is already installed under $CargoHome"
            return
        }
    }

    Invoke-Checked -FilePath $RustupCommand -ArgumentList @('component', 'add', 'rustfmt')
    $RustfmtVersion = (& $RustfmtCommand --version 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "rustup completed but rustfmt is not usable under $CargoHome"
    }
    Write-Host "Installed $RustfmtVersion"
}

function Install-LocalNpm {
    $InstalledNpm = Join-Path $NpmPrefix 'npm.cmd'
    if (Test-Path -LiteralPath $InstalledNpm -PathType Leaf) {
        $InstalledNpmVersion = (& $InstalledNpm --version 2>$null)
        if ($LASTEXITCODE -eq 0 -and $InstalledNpmVersion -eq $NpmVersion) {
            Write-Host "npm $NpmVersion is already installed under $NpmPrefix"
            return
        }
    }

    $BundledNpm = Join-Path $NodeRoot 'npm.cmd'
    Invoke-Checked -FilePath $BundledNpm -ArgumentList @(
        'install', '--global', "npm@$NpmVersion",
        '--registry', $NpmRegistry,
        '--no-audit', '--no-fund', '--loglevel', 'warn'
    )

    if (-not (Test-Path -LiteralPath $InstalledNpm -PathType Leaf)) {
        throw "Local npm was not created at $InstalledNpm"
    }
    $InstalledNpmVersion = (& $InstalledNpm --version)
    if ($LASTEXITCODE -ne 0 -or $InstalledNpmVersion -ne $NpmVersion) {
        throw "Expected npm $NpmVersion, got $InstalledNpmVersion"
    }

}

function Install-ProjectDependencies {
    if ($SkipProjectDependencies) {
        Write-Host 'Skipping npm ci and cargo fetch by request.'
        return
    }

    Push-Location $ProjectRoot
    try {
        Invoke-Checked -FilePath (Join-Path $NpmPrefix 'npm.cmd') -ArgumentList @(
            'ci', '--registry', $NpmRegistry, '--no-audit', '--no-fund'
        )
        Invoke-Checked -FilePath $CargoCommand -ArgumentList @(
            'fetch', '--locked', '--manifest-path', (Join-Path $ProjectRoot 'src-tauri\Cargo.toml')
        )
    }
    finally {
        Pop-Location
    }
}

function Install-VsBuildTools {
    Write-Warning 'Visual Studio Build Tools cannot be fully portable. The selected workload is targeted at the project directory, but the Visual Studio Installer, registry records, Windows SDK, servicing files, and some shared components are written to Windows system locations.'
    Write-Host "Requested VS Build Tools install path: $VsBuildToolsRoot"

    $Bootstrapper = Join-Path $DownloadCache 'vs_BuildTools.exe'
    if (Test-Path -LiteralPath $Bootstrapper -PathType Leaf) {
        try {
            Assert-MicrosoftSignature -Path $Bootstrapper
        }
        catch {
            Remove-Item -LiteralPath $Bootstrapper -Force
        }
    }
    Download-File -Url 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -Destination $Bootstrapper
    Assert-MicrosoftSignature -Path $Bootstrapper

    $Arguments = '--quiet --wait --norestart --nocache --installPath "{0}" --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add {1} --includeRecommended' -f $VsBuildToolsRoot, $WindowsSdkComponent
    $Process = Start-Process -FilePath $Bootstrapper -ArgumentList $Arguments -Verb RunAs -Wait -PassThru
    if ($Process.ExitCode -ne 0 -and $Process.ExitCode -ne 3010) {
        throw "Visual Studio Build Tools installer failed with exit code $($Process.ExitCode)."
    }
    if ($Process.ExitCode -eq 3010) {
        Write-Warning 'Visual Studio Build Tools requested a Windows restart.'
    }
}

Write-Step 'Installing project-local Node from npmmirror'
Install-Node

# Refresh command paths after Node was installed.
. (Join-Path $PSScriptRoot 'env.ps1')

Write-Step 'Installing project-local PortableGit from npmmirror'
Install-PortableGit

Write-Step 'Installing project-local Rust through rsproxy'
Install-Rust
Install-Rustfmt

Write-Step 'Installing project-local npm'
Install-LocalNpm

Write-Step 'Restoring locked project dependencies'
Install-ProjectDependencies

$MissingPrerequisites = @()
$BuildToolsStatus = Get-MsvcBuildEnvironmentStatus
if (-not $BuildToolsStatus.Ready) {
    if ($InstallBuildTools) {
        Write-Step 'Installing Visual Studio Build Tools'
        Install-VsBuildTools
        . (Join-Path $PSScriptRoot 'env.ps1')
        $BuildToolsStatus = Get-MsvcBuildEnvironmentStatus
        if (-not $BuildToolsStatus.Ready) {
            throw "Visual Studio Build Tools installation completed, but the build probe failed: $($BuildToolsStatus.Reason). A Windows restart or installer repair may be required."
        }
    }
    else {
        Write-Warning "MSVC Build Tools are incomplete: $($BuildToolsStatus.Reason). Re-run scripts\setup-windows.cmd -InstallBuildTools, or repair Visual Studio 2022 Build Tools with the Desktop C++ workload and Windows SDK."
        $MissingPrerequisites += 'MSVC Build Tools with a Windows SDK'
    }
}
else {
    Write-Host 'MSVC Build Tools detected.'
}

if (-not (Test-WebView2Runtime)) {
    Write-Warning 'Microsoft Edge WebView2 Runtime was not detected. Install the Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ before starting the Tauri window.'
    $MissingPrerequisites += 'Microsoft Edge WebView2 Runtime'
}
else {
    Write-Host 'Microsoft Edge WebView2 Runtime detected.'
}

if (Test-WslAvailable) {
    Write-Host 'WSL is available. The embedded terminal uses wsl.exe and reuses the Codex installation and login from the default WSL distribution.'
    if (Test-WslCodexAvailable) {
        $WslCodexVersion = Get-WslCodexVersion
        Write-Host "WSL Codex detected: $WslCodexVersion"
    }
    else {
        Write-Warning 'Codex was not found in the default WSL distribution. The WSL terminal will work, but the codex command must be installed and logged in inside WSL.'
    }
}
else {
    Write-Warning 'A usable default WSL distribution was not detected. The desktop app can only start after WSL is installed and initialized. Codex remains inside WSL; no Windows Codex package is installed.'
    $MissingPrerequisites += 'an initialized default WSL distribution'
}

if ($MissingPrerequisites.Count -gt 0) {
    throw ('Project-local tooling was installed, but the Windows runtime is incomplete: ' + ($MissingPrerequisites -join '; '))
}

Write-Step 'Windows environment is ready'
Write-Host "Tooling: $WindowsToolingRoot"
Write-Host "Caches:  $WindowsCacheRoot"
Write-Host 'Start the native desktop app with start.cmd after WSL and MSVC are available.'
