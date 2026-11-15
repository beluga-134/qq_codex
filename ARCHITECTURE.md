# OICQ（原 qq_codex / retro-messenger）架构总览

> 2026-11-14 清扫后定稿。Tauri 2.11 + xterm 6 + portable-pty。
> 核心原则：**纯终端模拟器**——前端只读展示终端输出，不向 PTY 写任何用户未敲入的内容；
> 会话命名等智能全部下沉到 pi 侧（扩展），shell/WSL 零侵入。

## 1. 分层总览

```
┌─────────────────────────── Windows 进程 ───────────────────────────┐
│  formal_2.exe (Tauri)                                              │
│  ┌────────────── WebView2 (前端, TS) ───────────────┐  ┌────────┐ │
│  │ main.ts      UI 装配/联系人/笔记/设置 (2787行⚠巨石) │  │ Rust   │ │
│  │ terminal.ts  窗格/xterm/PTY流/图片提取  (1727行)    │←→│ 后端   │ │
│  │ backend.ts   invoke 唯一通道，全类型化    (712行)   │  │ (下述) │ │
│  │ ui/state/types 小而清                             │  └───┬────┘ │
│  └───────────────────────────────────────────────────┘      │      │
│                                                     portable-pty│
│                                                            │      │
│  wsl.exe (--cd 项目路径) ←──────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────┘
                                        │ WSL 内
                        bash → pi（auto-session-name 扩展自动命名）
                        sessions: ~/.pi/agent/sessions/<slug>/*.jsonl
```

## 2. Rust 后端（src-tauri/src/，共 ~3400 行，21 测试）

| 模块 | 行数 | 职责 |
|---|---|---|
| lib.rs | 608 | 装配：Builder/生命周期、invoke_handler 命令注册表、ChatStore 管理、项目存储热重载 watcher |
| projects.rs | 805 | 项目文件夹全链路：Windows 盘符 / UNC(\\wsl.localhost\分布版) / WSL home 相对路径的解析与规范化；OneCommander/配置化开文件夹 |
| chat.rs | 623 | 聊天消息存储与 demo 回复（ messenger 玩具部分） |
| pty.rs | ~360 | PTY 会话表（HashMap<id,Session>）：open/write/resize/close；wsl.exe + WSLENV 注入；kill_all 于 Drop |
| terminal_files.rs | 320 | 终端产物文件：图片读盘/stat/导出、路径安全校验（防目录穿越） |
| terminal_exec.rs | 115 | 终端命令执行与记录 |
| applog.rs | ~90 | **仅 panic.log 兜底**（release 无控制台，崩溃唯一线索）；事件流水已随看护逻辑移除 |
| types.rs | 114 | 共享类型 |

命令面（invoke_handler，60+）：bootstrap / get_conversation / send_message / pty_* / parse_project_folder / notes_* / terminal 图片与文件命令。

## 3. 前端（src/）

| 模块 | 行数 | 职责 |
|---|---|---|
| main.ts | 2787 | UI 装配 + 123 函数：联系人列表渲染、对话转录、项目目录管理、笔记面板、缩放/窗口状态。⚠ 唯一巨石，建议按 recovery→terminal 先例拆 projects-ui/notes/settings |
| terminal.ts | 1727 | 终端子系统：workspace/pane 生命周期、分屏布局树、xterm 挂载与 fit、PTY 字节流队列（write/resize 串行化）、OSC 图片提取器、路径/图片链接渲染 |
| backend.ts | 712 | 全部 Tauri invoke 的类型化包装；前端唯一 IPC 出口 |
| ui.ts / state.ts / types.ts | ~330 | toast/hover 预览、全局状态快照、类型 |

**backend.ts 是架构纪律点**：前端任何地方不允许直接 import invoke。

## 4. 核心数据流

**PTY 字节流（双向）**
```
键入: xterm onData ─→ queuePanePtyWrite(串行队列) ─→ invoke pty_write
      ─→ PtySession.writer ─→ wsl.exe ─→ bash/pi
输出: pty 读线程 ─→ 事件 channel ─→ 前端 onPtyData
      ─→ xterm.write(渲染) ＋ PtyImageExtractor(OSC 图片标记→base64→悬浮/大图)
```

**项目文件夹**
```
project-folders.json ─热重载→ 前端 contact 注册
点开 → parse_project_folder_path(盘符/UNC/WSL路径解析)
     → ProjectShellTarget{distribution, wsl_path}
     → pty open: wsl.exe -d <dist> --cd <path>   （cwd 一个参数，防注入）
```

**聊天**：ChatStore(demo) ↔ main.ts 渲染（独立于终端子系统）。

**会话命名（pi 侧）**：裸 `pi` 启动 → 扩展 `~/.pi/agent/extensions/auto-session-name.ts`
于 session_start 检测无名 → `yyyymmdd <目录名> #N`（N=该 slug 今日会话数）→
pi 状态栏自渲染。resume/fork/已命名不碰。

## 5. 构建与工具链

- **家族工具链** `E:\qq_codex\.tooling\windows\`：cargo+registry / rustup / node / npm-global / portable-git（flow、pin_note、sql_viewer 共享）
- **项目内** `.tooling\windows\vs-build-tools\`（ACL 锁死搬不动，路径经 $PSScriptRoot 推导，随改名自动跟随）
- **部署** `scripts\deploy-formal2.ps1`：Windows npm 前端 → cargo fmt → cargo test →
  `cargo build --release --features custom-protocol`（⚠必须带 feature，否则连 devUrl 白屏）
  → 换 formal_2.exe → 拉起
- 版本钉死：Cargo.lock + package-lock.json；rustc 钉版可选（rust-toolchain.toml，未做）

## 6. 已知债务与守则

1. main.ts 巨石（拆分专项）
2. 前端零测试（terminal.ts 布局树纯函数可补 vitest）
3. invoke_handler 平铺清单（加分组注释即可）
4. WebView2 UDF = %LOCALAPPDATA%\com.retro.messenger（损坏时删目录重生成）
5. 守则：ps1 必须 ASCII 或带 BOM；前端构建必须 Windows node；杀进程前查僵尸 cargo/rustc；
   改 .tooling 前确认无进程持有句柄
