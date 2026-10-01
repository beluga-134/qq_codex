# Windows 安装与环境记录

本文记录本项目当前 Windows 开发环境的安装来源、落盘位置、系统级写入、验证和清理方式。当前项目根目录为：

```text
C:\path\to\qq_codex
```

后文以 `<项目根目录>` 表示该目录。若移动仓库，应重新运行配置脚本，不要继续使用旧目录中的绝对路径缓存。

## 架构边界

本项目不是 Windows 版 Codex 客户端。运行关系如下：

```text
Windows 原生 Tauri/WebView2 GUI
        |
        +-- portable-pty -> C:\Windows\System32\wsl.exe -> 默认 WSL 发行版 shell
                                                        -> WSL 内的 codex
```

- Windows 只运行 Tauri GUI、WebView2、前端开发服务器和 Rust 构建工具。
- “终端”联系人启动的是默认 `wsl.exe` 发行版中的持久 Linux PTY，不是 PowerShell 或 `cmd.exe`。
- Codex 只使用 WSL 中已有的 `/usr/bin/codex`、Linux `HOME`、登录状态和网络配置。
- 项目没有安装 Windows 版 Codex，也不会复制 WSL 中的 Codex 凭据。当前 `.tooling\windows\npm-global` 只有项目使用的 npm/npx。
- `.cmd` 入口使用 `powershell.exe -ExecutionPolicy Bypass -File ...`。该参数只对这一次子 PowerShell 进程放宽脚本执行策略，不修改系统或用户的永久 Execution Policy，也不代表把 Codex 安装到 Windows；脚本仍会按本文列出的路径正常读写。

## 当前环境快照

以下版本在 2026-07-20 已实际验证：

| 项目 | 当前版本或状态 | 所在位置 |
| --- | --- | --- |
| Node.js | `22.22.2`，x64 Windows ZIP | `<项目根目录>\.tooling\windows\node` |
| npm | `10.9.7` | `<项目根目录>\.tooling\windows\npm-global` |
| MinGit | 包版本 `2.55.0.3`，命令报告 `2.55.0.windows.3` | `<项目根目录>\.tooling\windows\portable-git` |
| rustup | `1.29.0` | `<项目根目录>\.tooling\windows\cargo\bin` 与 `.tooling\windows\rustup` |
| Rust | `rustc 1.97.1`、`cargo 1.97.1`，`x86_64-pc-windows-msvc` stable/minimal | `<项目根目录>\.tooling\windows\cargo` 与 `.tooling\windows\rustup` |
| rustfmt | `1.9.0-stable` | `<项目根目录>\.tooling\windows\cargo\bin` |
| Visual Studio 2022 Build Tools | MSVC `19.44.35228`，VC Tools `14.44.35207` | 主体位于 `<项目根目录>\.tooling\windows\vs-build-tools` |
| Windows SDK | `10.0.26100.0` | Windows 系统组件，主要位于 `C:\Program Files (x86)\Windows Kits\10` |
| Microsoft Edge WebView2 Runtime | `150.0.4078.83`，配置项目之前已经存在 | Windows 系统组件 |
| WSL | 默认发行版 `Ubuntu`，WSL 2，配置项目之前已经存在 | Windows/WSL 系统组件 |
| WSL Codex | `/usr/bin/codex`，`codex-cli 0.144.6`，配置项目之前已经存在 | 默认 WSL 发行版 |

前端直接依赖由 `package-lock.json` 锁定，当前主要包括 Tauri API `2.11.1`、Tauri CLI `2.11.4`、TypeScript `5.9.3` 和 Vite `8.1.5`。Rust 依赖由 `src-tauri\Cargo.lock` 锁定，`Cargo.toml` 当前使用 Tauri `2.11.5`。完整传递依赖版本以两个 lock 文件为准，不在本文重复维护一份易过期的清单。

## 安装相关文件

| 文件 | 用途 |
| --- | --- |
| `scripts\setup-windows.cmd` | Windows 首次配置入口，以单次进程级 `ExecutionPolicy Bypass` 调用 PowerShell |
| `scripts\setup-windows.ps1` | 下载、校验和部署 Node/MinGit/Rust/npm，可选调用 Visual Studio Installer，并恢复锁定依赖 |
| `scripts\env.ps1` | 创建项目内目录，生成 npm/Cargo 配置，设置当前进程环境，并探测 MSVC、WebView2 和 WSL |
| `.npmrc`、`.cargo\config.toml` | 仓库级 npmmirror 与 rsproxy 配置 |
| `package-lock.json`、`src-tauri\Cargo.lock` | 锁定前端和 Rust 依赖 |
| `start.cmd`、`scripts\dev.cmd`、`scripts\dev.ps1` | 加载项目环境并启动 Windows 原生 Tauri GUI |
| `scripts\web.cmd`、`scripts\web.ps1` | 只启动本机浏览器预览 |
| `scripts\check.cmd`、`scripts\check.ps1` | 构建、格式、测试和 MSVC/SDK 完整性检查 |

## 下载源与校验

国内有可靠镜像的组件使用国内源；Visual Studio Build Tools 使用微软官方入口。WebView2、WSL 和 WSL Codex 本次没有下载或安装。

| 下载或安装项 | 来源 | 缓存文件 | 当前缓存文件 SHA-256 |
| --- | --- | --- | --- |
| Node.js `22.22.2` | npmmirror：`https://npmmirror.com/mirrors/node/v22.22.2/` | `.cache\windows\downloads\node-v22.22.2-win-x64.zip` | `7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c` |
| MinGit `2.55.0.3` | npmmirror：`https://registry.npmmirror.com/-/binary/git-for-windows/v2.55.0.windows.3/` | `.cache\windows\downloads\MinGit-2.55.0.3-64-bit.zip` | `f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05` |
| rustup-init，MSVC x64 | rsproxy：`https://rsproxy.cn/rustup/dist/x86_64-pc-windows-msvc/` | `.cache\windows\downloads\rustup-init.exe` | `86478e53f769379d7f0ebfa7c9aa97cb76ca92233f79aa2cc0dbee2efaac73c7` |
| Visual Studio 2022 Build Tools bootstrapper | 微软官方：`https://aka.ms/vs/17/release/vs_BuildTools.exe` | `.cache\windows\downloads\vs_BuildTools.exe` | `c9cc76c0d03cbcb523e18b559a978ce5df11a667ef78e4e4d264331f1227ddd7` |

校验规则：

- Node ZIP 的期望值从同一版本目录的 `SHASUMS256.txt` 读取，再由脚本执行 SHA-256 校验。
- MinGit 的 SHA-256 固定在 `scripts\setup-windows.ps1` 中。
- rustup-init 的期望值从 rsproxy 同目录的 `rustup-init.exe.sha256` 读取，再由脚本校验。
- `aka.ms` 的 Build Tools bootstrapper 是会更新的滚动入口。上表是当前缓存文件的快照值，脚本不把它当永久固定值，而是检查有效的 Microsoft Authenticode 签名。bootstrapper 后续下载的工作负载包由 Visual Studio Installer 自己校验。
- npm 包从 `https://registry.npmmirror.com` 获取；Rust crates 使用 `sparse+https://rsproxy.cn/index/`；Rust toolchain 和 rustfmt 使用 `https://rsproxy.cn`。依赖内容分别由 npm lockfile 完整性字段、Cargo lockfile 和 Rustup 元数据校验。
- Visual Studio 工作负载没有可信且由脚本支持的国内镜像，因此保留微软官方源，不应替换为来源不明的离线包。

仓库级镜像配置位于 `.npmrc` 和 `.cargo\config.toml`。Windows 脚本还会生成 `.tooling\windows\npmrc` 与 `.tooling\windows\cargo\config.toml`，并在当前进程设置对应的 npm、Cargo 和 Rustup 环境变量；不会永久修改系统 PATH。

## 项目内落盘位置

首次配置会创建或使用以下目录：

| 路径 | 内容 | 是否可随项目清理 |
| --- | --- | --- |
| `.tooling\windows\node` | Node.js | 是 |
| `.tooling\windows\npm-global` | npm/npx；不含 Windows Codex | 是 |
| `.tooling\windows\portable-git` | MinGit | 是 |
| `.tooling\windows\cargo` | Cargo home、cargo/rustc/rustup/rustfmt 代理和 crate registry | 是 |
| `.tooling\windows\rustup` | Rust toolchain | 是 |
| `.tooling\windows\vs-build-tools` | Visual Studio Build Tools 主体 | 否，必须先由 Visual Studio Installer 卸载 |
| `.cache\windows\downloads` | 上表安装包和校验文件 | 是 |
| `.cache\windows\npm` | Windows 脚本使用的 npm 缓存 | 是 |
| `.cache\windows\cargo-target` | Windows Rust 构建产物 | 是 |
| `.cache\windows\tmp` | 配置脚本的临时展开和编译探测文件 | 是 |
| `.cache\windows\node`、`.cache\windows\corepack` | Node/Corepack 状态与缓存 | 是 |
| `node_modules` | `npm ci` 按 `package-lock.json` 恢复的前端依赖 | 是 |
| `dist` | 前端构建结果 | 是 |

仓库 `.npmrc` 另指定 `.cache\npm` 作为不经过 Windows 环境脚本时的 npm 缓存。Windows 的 `env.ps1` 会用进程级配置覆盖为 `.cache\windows\npm`。

## 不可避免的 Windows 系统写入

Node、npm、MinGit 和 Rust 都按项目目录部署。Visual Studio Build Tools/Windows SDK、WebView2 和 WSL 则不是完全便携组件。即使 Build Tools 主体通过 `--installPath` 指向项目目录，微软安装器仍会写系统位置并请求 UAC。

Visual Studio Build Tools 与 Windows SDK 的主要系统写入包括：

- `C:\Program Files (x86)\Microsoft Visual Studio\Installer`：Visual Studio Installer、`vswhere.exe` 和维护组件。
- `C:\Program Files (x86)\Windows Kits\10`：Windows SDK 头文件、库和工具。
- `C:\ProgramData\Microsoft\VisualStudio`：实例、安装器、包和维护状态数据。
- `C:\ProgramData\Package Cache`：bootstrapper/MSI 的维护与卸载缓存。
- `C:\Windows\Installer`：Windows Installer 的 MSI/MSP 缓存。
- `%LOCALAPPDATA%\Temp\dd_*` 及其他 `%TEMP%` 内容：Visual Studio 安装日志和临时文件。
- `C:\Program Files (x86)\Microsoft Visual Studio\Shared`、`C:\Program Files\Microsoft Visual Studio\Shared` 等共享组件目录，是否出现取决于所选包和当前系统已有组件。
- Windows 组件存储、服务维护记录和重启挂起状态；具体位置与 Windows/安装器版本有关。

常见的注册表写入范围包括：

- `HKLM\SOFTWARE\Microsoft\VisualStudio`，包括实例/Setup 信息
- `HKLM\SOFTWARE\WOW6432Node\Microsoft\VisualStudio`，包括实例/Setup 信息
- `HKLM\SOFTWARE\Microsoft\Windows Kits`
- `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows Kits`
- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
- `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`
- Windows Installer 的产品、组件和修复注册信息

上述是已知的主要落点，不是对微软安装器每次写入的逐文件承诺；实际清单会随安装器、SDK 和 Windows 版本变化。如需安全审计级的完整变更记录，应在干净快照上使用虚拟机和 Process Monitor 采集。

WebView2 Runtime 和 WSL 在本项目配置前已经安装，本脚本只探测，不安装它们：

- WebView2 Runtime 通常位于 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application`，版本信息由 Edge Update 注册表维护。
- 当前机器的 WebView2 探测记录位于 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`；脚本也兼容对应的 64 位 HKLM 和 HKCU 路径。
- 本应用启动后会创建 WebView2 用户数据 `%LOCALAPPDATA%\com.retro.messenger\EBWebView`。这是应用运行数据，不在项目目录内。
- WSL 的发行版磁盘、Windows 功能、网络和注册信息仍由 Windows/WSL 管理，本项目不会移动、注册或注销发行版。
- `/usr/bin/codex` 及其 Linux 配置完全留在 WSL；Windows 安装脚本只执行探测命令。

## 首次配置

必须在 Windows Terminal 或 `cmd.exe` 中运行，不要在 WSL shell 中执行 `.cmd` 安装入口：

```batch
cd /d C:\path\to\qq_codex
.\scripts\setup-windows.cmd -InstallBuildTools
```

行为说明：

- `-InstallBuildTools` 仅在未检测到可用 MSVC 时安装 Visual Studio 2022 Build Tools，并会弹出 UAC。脚本显式添加 `Microsoft.VisualStudio.Workload.VCTools`、`Microsoft.VisualStudio.Component.VC.Tools.x86.x64` 和 `Microsoft.VisualStudio.Component.Windows11SDK.26100`，同时启用 `--includeRecommended`。
- 如果系统已装好可用的 MSVC 与 Windows SDK，可省略 `-InstallBuildTools`。
- `-SkipProjectDependencies` 可暂时跳过 `npm ci` 和 `cargo fetch --locked`，但之后必须不带此参数重跑，才能完整构建。
- setup 会实际调用 `cl.exe`、`link.exe` 和 `rc.exe` 编译、链接带资源的最小 Windows 程序，同时检查 `mt.exe`、Windows SDK、WebView2 和可初始化的默认 WSL 发行版；缺少这些必需项会非零退出。`scripts\check.cmd` 会在构建前重复同一完整门禁。
- WSL 中缺少 Codex 只会警告，因为普通 WSL 终端仍能使用；如要在应用中运行 Codex，应先在 WSL 内自行安装并登录。
- Visual Studio Installer 返回 `3010` 表示需要重启。重启 Windows 后再次运行同一 setup 命令完成验证。

## 启动与日常检查

启动 Windows 原生 GUI：

```batch
cd /d C:\path\to\qq_codex
.\start.cmd
```

在应用中选择“终端”联系人后，可直接输入：

```sh
pwd
command -v codex
codex --version
```

这些命令在默认 WSL 发行版中执行。输出应依次包含项目对应的 WSL 映射路径、Codex 可执行文件路径和当前 Codex 版本。

只启动浏览器预览：

```batch
.\scripts\web.cmd
```

预览仅监听 `http://127.0.0.1:1420/`，使用内存后端，不启动真实 `wsl.exe`。因此 Node 首次启动时如出现 Windows 防火墙提示，不需要为公网/专用网络添加入站放行规则。

执行完整检查：

```batch
.\scripts\check.cmd
```

该命令依次执行前端 TypeScript/Vite 构建、`cargo fmt --check`、锁定依赖的 Rust 测试和 `cargo check`。它也会用 MSVC 实际编译、链接一个 Windows SDK 探针。

可独立检查系统和 WSL 状态：

```batch
wsl.exe --status
wsl.exe -l -v
wsl.exe --exec /bin/sh -lc "printf '中文 UTF-8\n'; command -v codex; codex --version"
```

可在 PowerShell 中加载项目环境并查看 Windows 工具版本：

```powershell
. .\scripts\env.ps1 -RequireNode -RequireRust -RequireGit -RequireBuildTools -RequireWsl
& $NodeCommand --version
& $NpmCommand --version
& $GitCommand --version
& $RustcCommand --version
& $CargoCommand --version
```

## 更新与修复

- 重跑 `.\scripts\setup-windows.cmd` 是恢复项目内工具、重新执行 `npm ci`、预取锁定 crates 并复查系统前置项的标准方式。
- Node、npm 和 MinGit 版本由 `scripts\setup-windows.ps1` 中的常量固定。要升级应先评估并修改这些常量及 SHA-256；MinGit 已存在且可运行时 setup 会保留它，升级时需先移除其项目内目录。
- Rust 使用项目内 Rustup。加载 `scripts\env.ps1` 后通过 `$RustupCommand` 更新 stable，并重新添加 rustfmt；不要调用系统中另一个 Rustup。
- 前端与 Rust 项目依赖只有在有意更新 `package-lock.json` 或 `src-tauri\Cargo.lock` 时才升级。日常 setup/check 使用锁文件，不做隐式大版本升级。
- Visual Studio Build Tools 和 Windows SDK 的更新、修复与组件变更必须使用 Visual Studio Installer。
- WebView2 Runtime 由 Microsoft Edge Update 维护。WSL/发行版和 WSL 内 Codex 分别在 Windows 和 WSL 内按原安装方式维护，不由本项目脚本更新。

## 卸载与清理

先关闭应用、Vite、Cargo 和所有由本项目启动的终端进程。

### 1. 卸载 Visual Studio Build Tools

如果 Build Tools 实例是本项目通过 `-InstallBuildTools` 安装的，打开：

```text
C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe
```

也可从“Visual Studio Installer”界面找到安装路径为 `<项目根目录>\.tooling\windows\vs-build-tools` 的实例，然后选择“更多” -> “卸载”。必须先完成此步骤，**不要直接删除 `.tooling\windows\vs-build-tools`**；直接删除会破坏 Installer 维护状态，并留下 SDK、共享组件、注册表和 MSI 缓存。

Windows SDK 或共享组件可能被其他 Visual Studio/Windows 开发工具共同使用。只在确认没有其他实例依赖时，才通过 Visual Studio Installer 或 Windows“已安装的应用”卸载；不要手工删除 `Windows Kits`、`C:\Windows\Installer`、`C:\ProgramData\Package Cache` 或相关注册表项。

### 2. 删除项目内工具与缓存

在 Build Tools 卸载完成后，可从项目根目录删除：

```batch
rmdir /s /q .tooling
rmdir /s /q .cache
rmdir /s /q node_modules
rmdir /s /q dist
```

这些命令不会卸载 WebView2、WSL 或 WSL Codex。若只想释放下载/构建空间，可仅删除 `.cache`；下次 setup/check 会重新创建。

### 3. 可选清理 WebView2 应用数据

关闭应用后可删除本应用自己的 WebView2 用户数据：

```batch
rmdir /s /q "%LOCALAPPDATA%\com.retro.messenger\EBWebView"
```

这会清除该 GUI 的浏览数据和 WebView 状态，不会卸载共享 WebView2 Runtime。WebView2 和 WSL 原本就存在，不应因为删除本项目而卸载；尤其不要执行 `wsl --unregister`，否则会删除相应 Linux 发行版及其 Codex 环境和数据。

Visual Studio 安装完成并确认无需排障后，`%LOCALAPPDATA%\Temp\dd_*` 日志可按普通临时文件清理。MSI/MSP 缓存和安装器注册表必须交给微软安装器维护，不能手工清除。
