//! 应用日志与 panic 兜底：exe 旁 `logs/` 目录（不可写时回退 %LOCALAPPDATA%）。
//!
//! - `recovery.log`：看门狗、崩溃检测、会话恢复等关键事件流水（append）。
//! - `panic.log`：Rust panic 兜底。release 构建 `windows_subsystem = "windows"`
//!   无控制台，stderr 无人接收，这里是崩溃排查的唯一线索。
//!
//! 时间统一用本地时区固定 UTC+8 格式化（无 chrono 依赖的手写换算）。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

static BASE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 初始化日志目录并安装 panic hook（setup 中调用一次）。
pub(crate) fn init(_app: &AppHandle) {
    let base = resolve_base_dir();
    let logs = base.join("logs");
    let _ = std::fs::create_dir_all(&logs);
    BASE_DIR.set(base).ok();
    install_panic_hook(&logs);
}

/// exe 所在目录（fallback %LOCALAPPDATA%\com.retro.messenger）。
pub(crate) fn base_dir() -> PathBuf {
    BASE_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resolve_base_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let logs = parent.join("logs");
            if std::fs::create_dir_all(&logs).is_ok() {
                let probe = logs.join(".probe");
                if std::fs::write(&probe, b"ok").is_ok() {
                    let _ = std::fs::remove_file(&probe);
                    return parent.to_path_buf();
                }
            }
        }
    }
    let fallback = std::env::var("LOCALAPPDATA")
        .map(|local| PathBuf::from(local).join("com.retro.messenger"))
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(fallback.join("logs"));
    fallback
}

/// 追加一条事件到 `logs/recovery.log`。
pub(crate) fn event(category: &str, msg: &str) {
    let Some(base) = BASE_DIR.get() else { return };
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(base.join("logs").join("recovery.log"))
    else {
        return;
    };
    let _ = writeln!(file, "[{}] [{}] {}", now_string(), category, msg);
}

fn install_panic_hook(logs: &PathBuf) {
    let logs = logs.clone();
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(text) = info.payload().downcast_ref::<&str>() {
            (*text).to_string()
        } else if let Some(text) = info.payload().downcast_ref::<String>() {
            text.clone()
        } else {
            "unknown payload".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("panic.log"))
        else {
            return;
        };
        let _ = writeln!(
            file,
            "[{}] payload={payload} location={location}",
            now_string()
        );
    }));
}

pub(crate) fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `2026-11-09 23:12:34`（UTC+8）。
pub(crate) fn now_string() -> String {
    let (date, hms) = split_local(now_epoch());
    format!("{date} {hms}")
}

/// `2026-11-09`（UTC+8）。
pub(crate) fn now_date() -> String {
    split_local(now_epoch()).0
}

/// `20261109`（UTC+8）。
pub(crate) fn now_ymd8() -> String {
    split_local(now_epoch()).0.replace('-', "")
}

/// `223301`（UTC+8，时分秒紧凑）。
pub(crate) fn now_hms_compact() -> String {
    split_local(now_epoch()).1.replace(':', "")
}

fn split_local(epoch: u64) -> (String, String) {
    let local = epoch + 8 * 3600; // 固定 UTC+8
    let days = (local / 86400) as i64;
    let secs = local % 86400;
    let (year, month, day) = civil_from_days(days);
    (
        format!("{year:04}-{month:02}-{day:02}"),
        format!(
            "{:02}:{:02}:{:02}",
            secs / 3600,
            secs % 3600 / 60,
            secs % 60
        ),
    )
}

/// Howard Hinnant 的 civil 日期算法（天数 → 年月日）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}
