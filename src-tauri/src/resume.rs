//! pi 会话恢复索引与崩溃检测。
//!
//! - `resume.json`（exe 旁）：panel ↔ pi 会话映射，随窗格开关实时更新（原子写）。
//!   对话本体在 pi 自己的 sessions 目录（`~/.pi/agent/sessions/<cwd>/<…>_<id>.jsonl`），
//!   本文件只是"自动拉起谁"的索引，丢了可手动 `pi --resume` 兜底。
//! - 崩溃判定：启动时心跳文件 `logs/heartbeat.json` 残留（上次未能正常退出），
//!   或看门狗写入的 `logs/webview-crashed.flag`（webview 崩溃后重建窗口）。
//! - 恢复流程：前端 `resume_status` 消费崩溃标记取回 panel 清单 → 杀光遗留
//!   PTY（防 webview 崩溃场景旧 pi 还活着导致同一 jsonl 双进程写）→ 对每个
//!   panel 重开终端窗格并写入 `pi --session-id <id>`，对话视图与上下文由 pi 复原。
//! - 防死循环：恢复动作要求距上次恢复 ≥5 分钟，否则置 fatalLoop 由前端停手。

use crate::applog;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

const HEARTBEAT_FILE: &str = "logs/heartbeat.json";
const WEBVIEW_FLAG_FILE: &str = "logs/webview-crashed.flag";
const FATAL_LOOP_WINDOW_SECS: u64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelRecord {
    pub(crate) contact_id: String,
    pub(crate) pane_id: u32,
    pub(crate) project_path: String,
    pub(crate) project_wsl_path: Option<String>,
    pub(crate) session_id: String,
    pub(crate) session_name: String,
    pub(crate) opened_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CounterRecord {
    date: String,
    count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ResumeFile {
    version: u32,
    panels: Vec<PanelRecord>,
    counters: HashMap<String, CounterRecord>,
    last_recovery_epoch: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PanelInfo {
    session_id: String,
    session_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResumeStatus {
    crashed: bool,
    fatal_loop: bool,
    panels: Vec<PanelRecord>,
}

static STATE: OnceLock<Mutex<ResumeFile>> = OnceLock::new();
/// 崩溃标记（一次性消费）：启动时心跳残留或 webview 重建标记。
static CRASH_FLAG: OnceLock<Mutex<bool>> = OnceLock::new();

/// 初始化：载入 resume.json、检测上次崩溃、写入本次心跳（setup 中调用一次）。
pub(crate) fn init(_app: &AppHandle) {
    let base = applog::base_dir();
    let heartbeat = base.join(HEARTBEAT_FILE);
    let webview_flag = base.join(WEBVIEW_FLAG_FILE);
    let mut crashed = false;
    if heartbeat.exists() {
        crashed = true;
        applog::event("resume", "检测到心跳残留：上次为异常退出");
    }
    if webview_flag.exists() {
        crashed = true;
        applog::event("resume", "检测到 webview 崩溃重建标记");
    }
    CRASH_FLAG.set(Mutex::new(crashed)).ok();
    STATE.set(Mutex::new(load_file(&base))).ok();
    let _ = fs::write(
        &heartbeat,
        format!(
            "{{\"pid\":{},\"startedAt\":\"{}\"}}",
            std::process::id(),
            applog::now_string()
        ),
    );
    applog::event(
        "resume",
        &format!(
            "应用启动 pid={} 上次异常退出={}",
            std::process::id(),
            crashed
        ),
    );
}

/// 正常退出时清除心跳（RunEvent::Exit 调用；残留即判定崩溃）。
pub(crate) fn heartbeat_remove() {
    let path = applog::base_dir().join(HEARTBEAT_FILE);
    let _ = fs::remove_file(&path);
    applog::event("resume", "应用正常退出，心跳已清除");
}

/// 看门狗重建主窗口后调用：标记 webview 崩溃，供前端 resume_status 消费。
pub(crate) fn mark_webview_crashed() {
    let path = applog::base_dir().join(WEBVIEW_FLAG_FILE);
    let _ = fs::write(&path, applog::now_string());
    if let Some(flag) = CRASH_FLAG.get() {
        if let Ok(mut value) = flag.lock() {
            *value = true;
        }
    }
}

/// 开新对话窗格：生成会话 id 与名字（`20261109 E:/path #N`），登记并落盘。
#[tauri::command]
pub(crate) fn resume_dialog_open(
    contact_id: String,
    pane_id: u32,
    project_path: String,
    project_wsl_path: Option<String>,
) -> Result<PanelInfo, String> {
    let mut state = lock_state()?;
    let today = applog::now_date();
    let counter = state.counters.entry(contact_id.clone()).or_default();
    if counter.date != today {
        counter.date = today;
        counter.count = 0;
    }
    counter.count += 1;
    let session_name = format!(
        "{} {} #{}",
        applog::now_ymd8(),
        display_path(&project_path, project_wsl_path.as_deref(), &contact_id),
        counter.count
    );
    let session_id = format!(
        "qqcodex-{}-p{}-{:04}",
        applog::now_hms_compact(),
        pane_id,
        applog::now_epoch() % 10000
    );
    let record = PanelRecord {
        contact_id,
        pane_id,
        project_path,
        project_wsl_path,
        session_id: session_id.clone(),
        session_name: session_name.clone(),
        opened_at: applog::now_string(),
    };
    state
        .panels
        .retain(|item| !(item.contact_id == record.contact_id && item.pane_id == record.pane_id));
    state.panels.push(record);
    save_file(&state)?;
    applog::event(
        "resume",
        &format!("新对话注册 {session_name} id={session_id}"),
    );
    Ok(PanelInfo {
        session_id,
        session_name,
    })
}

/// 关闭对话窗格：pane_id 为 None 时清除该联系人的全部记录。
#[tauri::command]
pub(crate) fn resume_dialog_close(contact_id: String, pane_id: Option<u32>) -> Result<(), String> {
    let mut state = lock_state()?;
    let before = state.panels.len();
    state.panels.retain(|item| {
        item.contact_id != contact_id || pane_id.is_some_and(|id| item.pane_id != id)
    });
    if state.panels.len() != before {
        save_file(&state)?;
        applog::event(
            "resume",
            &format!("对话窗格注销 contact={contact_id} pane={pane_id:?}"),
        );
    }
    Ok(())
}

/// 前端启动时查询：崩溃标记一次性消费，fatalLoop 抑制连环重启。
#[tauri::command]
pub(crate) fn resume_status() -> ResumeStatus {
    let crashed = CRASH_FLAG
        .get()
        .and_then(|flag| {
            flag.lock()
                .ok()
                .map(|mut value| std::mem::replace(&mut *value, false))
        })
        .unwrap_or(false);
    let state = lock_state().ok();
    let (panels, fatal_loop) = state
        .map(|state| {
            let fatal = state
                .last_recovery_epoch
                .is_some_and(|at| applog::now_epoch().saturating_sub(at) < FATAL_LOOP_WINDOW_SECS);
            (state.panels.clone(), fatal)
        })
        .unwrap_or_else(|| (Vec::new(), false));
    if crashed {
        applog::event(
            "resume",
            &format!(
                "恢复检查：crashed=true panels={} fatalLoop={}",
                panels.len(),
                fatal_loop
            ),
        );
    }
    ResumeStatus {
        crashed,
        fatal_loop,
        panels,
    }
}

/// 前端恢复动作完成后调用：记录恢复时间（防死循环窗口计时起点）。
#[tauri::command]
pub(crate) fn resume_mark_recovered() -> Result<(), String> {
    let mut state = lock_state()?;
    state.last_recovery_epoch = Some(applog::now_epoch());
    save_file(&state)?;
    applog::event("resume", "会话恢复流程已执行");
    Ok(())
}

fn lock_state() -> Result<std::sync::MutexGuard<'static, ResumeFile>, String> {
    STATE
        .get()
        .and_then(|state| state.lock().ok())
        .ok_or_else(|| "恢复状态未初始化".to_string())
}

fn load_file(base: &PathBuf) -> ResumeFile {
    fs::read_to_string(base.join("resume.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .map(|mut file: ResumeFile| {
            if file.version == 0 {
                file.version = 1;
            }
            file
        })
        .unwrap_or_default()
}

fn save_file(state: &ResumeFile) -> Result<(), String> {
    let base = applog::base_dir();
    let target = base.join("resume.json");
    let tmp = base.join("resume.json.tmp");
    let json = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(&tmp, json).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &target).map_err(|error| error.to_string())?;
    Ok(())
}

fn display_path(project_path: &str, wsl_path: Option<&str>, fallback: &str) -> String {
    // 优先用 WSL 原生路径（pi 的真实 cwd，如 /home/beluga/PROJ/...），
    // Windows 盘符形式只在没有 WSL 路径时兑底。
    let raw = if let Some(wsl) = wsl_path.filter(|text| !text.trim().is_empty()) {
        wsl
    } else if !project_path.trim().is_empty() {
        project_path
    } else {
        fallback
    };
    raw.replace('\\', "/")
}
