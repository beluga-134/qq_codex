# OICQ 2003 Desktop

一个使用 Rust + Tauri 2 重写的复古即时通讯桌面应用。界面以 OICQ 为主体，融合 MSN 的联系人信息区和 Windows XP 的窗口控件；聊天联系人中包含一个使用 `portable-pty` + xterm.js 的完整本机终端。

## 运行

项目使用当前目录内的 Node、Rust、Cargo 和 WebKitGTK 开发环境，不需要修改系统级工具链。

```bash
# 启动 Tauri 桌面窗口
./scripts/dev.sh

# 只启动浏览器预览
./scripts/web.sh

# 构建前端并执行 Rust 测试、检查
./scripts/check.sh
```

浏览器预览地址为 `http://127.0.0.1:1420/`。桌面版的聊天状态由 Rust 管理；浏览器预览使用行为一致的内存后端。选择“终端”后会启动持久登录 shell，`cd`、环境变量、ANSI、方向键、Tab、Ctrl+C、vim/top 等交互程序都在同一个 PTY 中工作，直接输入 `codex` 即可使用 Codex 的交互界面和流式输出。Codex 的登录状态、网络访问和命令是否可用仍取决于当前用户环境。

窗口使用无边框原生拖动与缩放：小窗口拖动顶部，最大化后双击顶部还原；桌面运行时请使用项目内的 `scripts/env.sh` 环境，以确保本地 Node/Cargo/PATH 能传递到终端。

## 目录

- `src/`：TypeScript 界面、复古主题与浏览器预览后端
- `src-tauri/`：Rust 聊天状态、Tauri commands 与桌面配置
- `.tooling/`：项目本地 Node、Rust 和 WebKitGTK 环境
- `scripts/`：桌面启动、网页预览和检查入口
