# OICQ 2003 Desktop

一个使用 Rust + Tauri 2 重写的复古即时通讯桌面应用。界面以 OICQ 为主体，融合 MSN 的联系人信息区和 Windows XP 的窗口控件；聊天联系人中包含一个通过 `portable-pty` + xterm.js 连接 Windows `wsl.exe` 默认发行版的完整 Linux 终端。

## Windows 原生运行

请在 Windows Terminal 或 `cmd.exe` 中进入项目根目录后运行以下命令。桌面版必须作为 Windows 原生进程启动，以直接使用 WebView2、Windows 图形界面和系统中文输入法；嵌入终端和 Codex 则运行在 WSL2 中。

### 系统要求

- 64 位 Windows 10 或 Windows 11
- Microsoft Edge WebView2 Runtime
- WSL2、一个默认 Linux 发行版，以及该发行版中已安装并登录的 Codex
- Visual Studio 2022 Build Tools，包含“使用 C++ 的桌面开发”和 Windows 10/11 SDK

可先用 `wsl --status` 和 `wsl -l -v` 确认默认发行版及 WSL 版本。应用不会安装或调用 Windows 版 Codex，也不会把 WSL 内的 Codex 登录信息复制到 Windows。

```batch
REM 首次安装或修复完整 Windows 开发环境；缺少 MSVC 时会请求 UAC
.\scripts\setup-windows.cmd -InstallBuildTools
```

如果系统已安装带 Windows SDK 的 MSVC Build Tools，可省略 `-InstallBuildTools`。安装脚本发现 WebView2、WSL 或 MSVC 缺失时会返回失败，不会把不完整环境报告为“ready”。

首次配置脚本会把 Windows Node、MinGit、Rust 和 Cargo 工具链放在项目的 `.tooling/` 中，并把下载缓存放在 `.cache/` 中，不依赖系统 PATH 中的 Node 或 Rust。MSVC、Windows SDK 和 WebView2 是 Windows 系统组件，即使主体安装到项目目录也会写入系统注册信息，无法作为完全免安装的便携目录使用。

仓库级 `.npmrc` 使用 npmmirror，`.cargo/config.toml` 使用 rsproxy；首次配置脚本也会为 Rustup 下载设置国内镜像。依赖版本由 `package-lock.json` 和 `src-tauri/Cargo.lock` 锁定。

所有安装包、版本、校验值、落盘目录、Windows 系统写入和安全清理方式统一记录在 [WINDOWS_INSTALLATION.md](WINDOWS_INSTALLATION.md)。

### 启动与检查

```batch
REM 启动 Windows 原生 Tauri 桌面窗口
.\start.cmd

REM 只启动浏览器预览
.\scripts\web.cmd

REM 构建前端并执行 Rust 测试、检查
.\scripts\check.cmd
```

浏览器预览地址为 `http://127.0.0.1:1420/`。桌面版的聊天状态由 Rust 管理；浏览器预览使用行为一致的内存后端，但不会启动 `wsl.exe` 或执行真实系统命令。

选择“终端”后，Windows GUI 会通过 `wsl.exe` 启动默认发行版的持久 Linux shell。`cd`、环境变量、ANSI、方向键、Tab、Ctrl+C 和交互程序会保留在同一个 PTY 中。直接输入 `codex` 会使用 WSL 发行版内已有的 Codex、`HOME`、登录状态和网络配置，不需要也不应安装 Windows 版 Codex。

窗口使用无边框原生拖动与缩放：小窗口可拖动顶部，最大化后双击顶部还原。消息输入框和终端命令输入框使用 Windows 原生中文输入法组合事件，并以 UTF-8 把确认后的文本发送到 WSL，候选词确认时不会误触发送。

左侧好友/项目功能区可通过分隔线上的折叠按钮或 Ctrl+B 折叠为窄条，折叠状态会保存在本地，为右侧聊天窗口与 WSL 终端腾出空间。

在项目终端里运行 codex、Claude Code 或 pi 等 AI CLI 时，左侧对应的项目文件夹会显示实时状态：黄色脉冲表示 AI 正在工作，红色闪烁表示等待审批，绿色短暂常亮表示已完成。检测基于终端输出启发式，匹配失败时静默降级，不影响终端本身。

## 目录

- `src/`：TypeScript 界面、复古主题与浏览器预览后端
- `src-tauri/`：Rust 聊天状态、Tauri commands、WSL PTY 与 Windows 桌面配置
- `.tooling/`：项目内的 Windows Node、MinGit、Rust、Cargo 和构建工具
- `.cache/`：npm、Cargo、Rustup 等下载与运行缓存
- `.cargo/`、`.npmrc`：项目级国内镜像配置
- `scripts/`：Windows 环境安装、启动和检查入口
