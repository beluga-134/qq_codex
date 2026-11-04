//! 持久 PTY 会话（wsl.exe/登录 shell）：open/write/resize/close 与 shell 候选配置。

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::Duration;
use tauri::ipc::{Channel, Response};
use tauri::State;
use crate::projects::*;
use crate::terminal_exec::*;
use crate::types::*;


/// A live pseudo-terminal. The shell remains attached to this session until
/// the user explicitly closes it or the shell exits, so cd/env/interactive
/// programs keep their state between commands.
pub(crate) struct PtySession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub(crate) struct PtyState {
    sessions: Arc<Mutex<HashMap<u64, PtySession>>>,
    next_id: AtomicU64,
}

impl Drop for PtyState {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut session) in sessions.drain() {
                let _ = session.killer.kill();
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyExit {
    session_id: u64,
    exit_code: Option<u32>,
    signal: Option<String>,
    error: Option<String>,
}

#[cfg(target_os = "windows")]
pub(crate) fn pty_shell_candidates() -> Vec<(&'static str, CommandBuilder)> {
    vec![("WSL", CommandBuilder::new("wsl.exe"))]
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn pty_shell_candidates() -> Vec<(&'static str, CommandBuilder)> {
    vec![("系统默认 shell", CommandBuilder::new_default_prog())]
}

pub(crate) fn configure_pty_command(
    command: &mut CommandBuilder,
    project_target: Option<&ProjectShellTarget>,
) {
    #[cfg(target_os = "windows")]
    if let Some(project_target) = project_target {
        if let Some(distribution) = project_target.wsl_distribution.as_deref() {
            command.args(["--distribution", distribution]);
        }
        command.args(["--cd", project_target.wsl_path.as_str()]);
    } else {
        command.cwd(terminal_working_directory());
    }

    #[cfg(not(target_os = "windows"))]
    command.cwd(
        project_target
            .map(|target| PathBuf::from(&target.wsl_path))
            .unwrap_or_else(terminal_working_directory),
    );

    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "RetroMessenger");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // 前端 xterm.js 通过 xterm-addon-image 渲染 iTerm2 内联图片协议（OSC 1337）；
    // pi 读取该变量改用 iterm2 协议输出图片，只影响本应用拉起的 PTY。
    command.env("PI_IMAGE_PROTOCOL", "iterm2");
    // wsl.exe 默认不把上述变量带入 Linux 会话，只有列在 WSLENV 里才能跨过
    // Windows→WSL 边界；/u 表示仅 Win→WSL 单向传递。
    const WSLENV_FORWARD: &str =
        "COLORTERM/u:TERM_PROGRAM/u:TERM_PROGRAM_VERSION/u:PI_IMAGE_PROTOCOL/u";
    let wslenv = match std::env::var_os("WSLENV") {
        Some(existing) if !existing.is_empty() => {
            format!("{}:{}", existing.to_string_lossy(), WSLENV_FORWARD)
        }
        _ => WSLENV_FORWARD.to_string(),
    };
    command.env("WSLENV", wslenv);

    #[cfg(target_os = "windows")]
    if let Some(path) = std::env::var_os("PATH") {
        // portable-pty merges registry environment entries on Windows; restore
        // the launcher's project-local Node/Cargo paths after that merge.
        command.env("PATH", path);
    }

    // The bundled development Node setup exports this variable for npm. It
    // makes nvm print a warning in every interactive shell and can interfere
    // with Codex's own Node discovery, so leave the normal shell environment
    // in charge of its prefix.
    command.env_remove("NPM_CONFIG_PREFIX");
    command.env_remove("npm_config_prefix");
}

#[cfg(target_os = "linux")]
pub(crate) fn configure_wslg_input_backend() {
    if std::env::var_os("GDK_BACKEND").is_some() {
        return;
    }

    let is_wsl = std::env::var_os("WSL_INTEROP").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|release| release.to_ascii_lowercase().contains("microsoft"))
            .unwrap_or(false);
    if is_wsl {
        // WSLg does not yet expose the native Wayland input-method protocol to
        // desktop apps. GTK's X11 backend lets the user's Fcitx/IBus GTK module
        // handle composition, while still respecting an explicit user choice.
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

/// Open a persistent login shell and stream every byte it writes to xterm.js.
/// `Response` keeps the payload binary, which matters for split UTF-8 sequences
/// and for terminal protocols such as mouse reporting.
#[tauri::command(async)]
pub(crate) fn pty_open(
    rows: u16,
    cols: u16,
    project_path: Option<String>,
    project_wsl_path: Option<String>,
    project_wsl_distribution: Option<String>,
    on_data: Channel<Response>,
    on_exit: Channel<PtyExit>,
    state: State<'_, PtyState>,
) -> Result<PtyOpenResult, String> {
    if project_wsl_path.is_none() && project_wsl_distribution.is_some() {
        return Err("项目缺少 WSL 路径缓存，请重新添加该项目".into());
    }
    let (project_target, project_resolution) = if let Some(wsl_path) = project_wsl_path.as_deref() {
        if legacy_wsl_home_cache_path(wsl_path) {
            let resolved = parse_project_folder_for_current_platform(wsl_path)?;
            let target = project_shell_target(&resolved);
            (Some(target), Some(project_folder_resolution(resolved)))
        } else {
            (
                Some(project_shell_target_from_cache(
                    wsl_path,
                    project_wsl_distribution.as_deref(),
                )?),
                None,
            )
        }
    } else if let Some(project_path) = project_path.as_deref() {
        let resolved = resolve_project_folder_path(project_path)?;
        let target = project_shell_target(&resolved);
        (Some(target), Some(project_folder_resolution(resolved)))
    } else {
        (None, None)
    };
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("无法创建终端：{error}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("无法读取终端：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("无法写入终端：{error}"))?;
    let mut spawn_errors = Vec::new();
    let mut child = None;
    for (shell_name, mut command) in pty_shell_candidates() {
        configure_pty_command(&mut command, project_target.as_ref());
        match pair.slave.spawn_command(command) {
            Ok(spawned) => {
                child = Some(spawned);
                break;
            }
            Err(error) => spawn_errors.push(format!("{shell_name}：{error}")),
        }
    }
    let mut child = child.ok_or_else(|| format!("无法启动 shell：{}", spawn_errors.join("；")))?;
    let killer = child.clone_killer();
    // The slave must be dropped after spawning. Keeping it alive in the parent
    // prevents EOF from reaching the reader when the child exits.
    drop(pair.slave);

    let session_id = state
        .next_id
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    let sessions = Arc::clone(&state.sessions);
    {
        let mut sessions_guard = sessions
            .lock()
            .map_err(|_| "终端状态锁不可用".to_string())?;
        sessions_guard.insert(
            session_id,
            PtySession {
                master: Arc::new(Mutex::new(pair.master)),
                writer: Arc::new(Mutex::new(writer)),
                killer,
            },
        );
    }

    let data_channel = on_data.clone();
    let reader_done = Arc::new(AtomicBool::new(false));
    let reader_done_signal = Arc::clone(&reader_done);
    let mut reader_killer = child.clone_killer();
    thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        let mut channel_failed = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    if data_channel
                        .send(Response::new(buffer[..length].to_vec()))
                        .is_err()
                    {
                        channel_failed = true;
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        if channel_failed {
            let _ = reader_killer.kill();
        }
        reader_done_signal.store(true, Ordering::Release);
    });

    thread::spawn(move || {
        let exit = match child.wait() {
            Ok(status) => PtyExit {
                session_id,
                exit_code: Some(status.exit_code()),
                signal: status.signal().map(str::to_owned),
                error: None,
            },
            Err(error) => PtyExit {
                session_id,
                exit_code: None,
                signal: None,
                error: Some(error.to_string()),
            },
        };

        // Let the reader flush bytes that were already produced before
        // publishing the exit notification. The timeout prevents a broken
        // PTY from keeping the wait thread alive indefinitely.
        for _ in 0..50 {
            if reader_done.load(Ordering::Acquire) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        if let Ok(mut sessions_guard) = sessions.lock() {
            sessions_guard.remove(&session_id);
        }
        let _ = on_exit.send(exit);
    });

    Ok(PtyOpenResult {
        session_id,
        project: project_resolution,
    })
}

#[tauri::command]
pub(crate) fn pty_write(session_id: u64, data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let writer = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "终端状态锁不可用".to_string())?;
        sessions
            .get(&session_id)
            .map(|session| Arc::clone(&session.writer))
            .ok_or_else(|| "终端会话已结束".to_string())?
    };
    let mut writer = writer.lock().map_err(|_| "终端写入锁不可用".to_string())?;
    writer
        .write_all(&data)
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写入终端失败：{error}"))
}

#[tauri::command]
pub(crate) fn pty_resize(
    session_id: u64,
    rows: u16,
    cols: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let master = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "终端状态锁不可用".to_string())?;
        sessions
            .get(&session_id)
            .map(|session| Arc::clone(&session.master))
            .ok_or_else(|| "终端会话已结束".to_string())?
    };
    let master = master.lock().map_err(|_| "终端大小锁不可用".to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("调整终端大小失败：{error}"))
}

#[tauri::command]
pub(crate) fn pty_close(session_id: u64, state: State<'_, PtyState>) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "终端状态锁不可用".to_string())?;
    let mut session = sessions
        .remove(&session_id)
        .ok_or_else(|| "终端会话已结束".to_string())?;
    session
        .killer
        .kill()
        .map_err(|error| format!("关闭终端失败：{error}"))
}
