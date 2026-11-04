//! 模拟终端命令执行（浏览器预览后端）：命令运行、平台差异、输出截断。

use std::path::{Path, PathBuf};
use std::process::Command;
use crate::types::*;


pub(crate) fn terminal_working_directory() -> PathBuf {
    if let Ok(project_root) = std::env::var("PROJECT_ROOT") {
        let path = PathBuf::from(project_root);
        if path.is_dir() {
            return path;
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(project_root) = manifest_dir.parent().filter(|path| path.is_dir()) {
        return project_root.to_path_buf();
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub(crate) fn terminal_help_text() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "可直接在 WSL 中执行 Linux shell 命令。\n常用命令：pwd  ls  whoami  date  cargo --version\n输出最多保留 12000 个字符。"
    }

    #[cfg(not(target_os = "windows"))]
    {
        "可直接执行当前系统 shell 命令。\n常用命令：pwd  ls  whoami  date  cargo --version\n命令最长运行 20 秒，输出最多保留 12000 个字符。"
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn run_platform_terminal_command(
    command: &str,
    cwd: &Path,
) -> std::io::Result<std::process::Output> {
    Command::new("wsl.exe")
        .args(["--exec", "/bin/sh", "-lc", command])
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .output()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn run_platform_terminal_command(
    command: &str,
    cwd: &Path,
) -> std::io::Result<std::process::Output> {
    Command::new("timeout")
        .args(["20s", "bash", "-lc", command])
        .current_dir(cwd)
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .output()
}

#[cfg(target_os = "windows")]
pub(crate) fn terminal_command_timed_out(_exit_code: Option<i32>) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn terminal_command_timed_out(exit_code: Option<i32>) -> bool {
    exit_code == Some(124)
}

pub(crate) fn run_terminal_command(command: &str, cwd: &Path) -> (String, Option<i32>, bool) {
    if matches!(command.trim().to_ascii_lowercase().as_str(), "help" | "?") {
        return (terminal_help_text().into(), Some(0), true);
    }

    let result = run_platform_terminal_command(command, cwd);

    match result {
        Ok(output) => {
            let exit_code = output.status.code();
            let success = output.status.success();
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let mut text = stdout.trim_end().to_string();
            if !stderr.trim().is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(stderr.trim_end());
            }
            if text.is_empty() {
                text = if terminal_command_timed_out(exit_code) {
                    "命令超过 20 秒，已终止。".into()
                } else if success {
                    "(命令执行完成，没有输出)".into()
                } else {
                    format!("命令执行失败，退出代码：{}", exit_code.unwrap_or(-1))
                };
            }
            (truncate_terminal_output(text), exit_code, success)
        }
        Err(error) => (format!("无法启动 WSL shell：{error}"), None, false),
    }
}

pub(crate) fn truncate_terminal_output(value: String) -> String {
    let mut characters = value.chars();
    let mut output: String = characters
        .by_ref()
        .take(MAX_TERMINAL_OUTPUT_CHARS)
        .collect();
    if characters.next().is_some() {
        output.push_str("\n... 输出已截断 ...");
    }
    output
}
