# HANDOFF：qqcodex 大修收尾（2026-11-13 01:50）

## 任务目标
qqcodex 卡死排查修复 → 最终按用户决策：回退上一版 + 路径修复 + 工具链家族化，删除全部失败自愈逻辑，改为显示可恢复的 pi 会话 id。

## 已完成（全部验证过）
1. **构建链修复**：裸 cargo 缺 `custom-protocol` feature 会连 devUrl 白屏 → Cargo.toml 加 [features]；部署脚本 `scripts/deploy-formal2.ps1`（npm前端→fmt→test→release→换exe→拉起）。
2. **registry 腐坏修复**：坏 crate 源档导致漂移编译错误 → registry 已重下（旧档在 `cargo/registry.broken-0113`）。
3. **代码终态**：watchdog.rs 已删；resume.rs=纯id生成器；recovery.ts=新对话+id显示；terminal.ts=正则修复+窗格会话条+输入嗅探；backend/main 已清死引用。git 仅剩：Cargo.toml、scripts/env.ps1、exe 二进制变更。
4. **工具链家族化**：`E:\qq_codex\.tooling\windows`（cargo/rustup/node/npm/git 共享）；vs-build-tools 留在项目内（ACL 拒搬）。4 脚本已改：qq_codex/env.ps1、flow/package.ps1、pin_note/build.ps1、sql_viewer/env.ps1。
5. **运行中**：formal_2.exe pid 14132（01:47 构建），recovery.log 静默=无自愈逻辑，符合设计。

## 2026-11-14 最终形态（覆盖上方所有形态描述）
- 会话命名已完全移交 pi：~/.pi/agent/extensions/auto-session-name.ts（session_start 时无名字则自动 `yyyymmdd <目录名> #N`，实测落地）。
- qqcodex 已回纯终端模拟器：拦截/注入/resume_dialog_open/新会话按钮/徽章全部删除；src 仅剩路径正则修复 vs HEAD。
- 百度网盘 MCP 已删（~/.pi/agent/mcp.json 清空；旧进程随旧会话消亡）。

- 悬浮徽章/新会话按钮/输入嗅探全部删除；recovery.ts 已不存在。
- 终态功能：窗格里敲裸 `pi` 回车 → 自动扩展 `pi --session-id <id> --name "20261113 /路径 #N"`（名字由 resume_dialog_open 生成，pi 状态栏路径右侧显示 • 名字）；带参 pi 命令原样放行。
- 语法：tsc 干净；运行 pid 42908（19:20 构建）。

## 进行中/待办（新会话入口）
1. **改名 oicq**（用户已定名）：停 formal_2 → `mv /mnt/e/qq_codex/qq_codex /mnt/e/qq_codex/oicq` → **改 3 处 vs-build-tools 引用**（flow/package.ps1 的 $VcVars、pin_note/build.ps1 的 $VsDevCmdPath、sql_viewer/env.ps1 的 VsDevCmd Insert 行，都含 `qq_codex` 字样）→ 重启。本会话 cwd 在项目内不能改。
2. 清理（确认稳定几天后）：`.tooling/windows/` 下 `rustup.broken-0113`、`cargo/bin.broken-0113`、`cargo/registry.broken-0113`、家族目录里 `rustup.broken-0113`；`logs/{heartbeat.json,resume.json,webview-crashed.flag}` 已是惰性残留可删；`scripts/migrate-toolchain.ps1` 使命已完成可删。
3. 可选：rust-toolchain.toml 钉 channel="1.99.1"（会触发一次精确版本下载）；给 flow/sql_viewer/pin_note 也钉。

## 坑与红线（本夜血泪）
- PowerShell 5.1 读无 BOM 的 UTF-8 ps1 会按 GBK 误解中文注释 → ps1 必须 ASCII 或带 BOM；验证用 `Language.Parser::ParseFile`（Tokenize 验不出）。
- `powershell -File` 未捕获异常可能 exit 0，`&&` 链会被骗。
- Move-Item 遇文件句柄被占（僵尸 cargo/rustup）会半途搬空壳；vs-build-tools 的文件 ACL 直接拒搬。
- WSL 侧 `npm run build` 必失败（rolldown 原生二进制仅 win32）；前端必须 Windows node。
- 构建/杀进程前先 tasklist 查僵尸 cargo.exe/rustup.exe。

## 下次入口
读本文件 → 若做改名：按"待办1"三步走 → 验证：改完后 qq_codex 相关路径 grep 应只剩 `..\oicq\...`。
