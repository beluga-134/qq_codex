//! Webview 看门狗：心跳检测 WebView 运行时崩溃/冻结并自动重建主窗口。
//!
//! 背景：Windows 上 WebView2 的 browser 主进程崩溃（Crashpad 记录
//! SubCode=0x80000003 一类内部断言）时，wry 0.55 不监听
//! `ICoreWebView2Environment.ProcessFailed`，Tauri 收不到任何通知，
//! 窗口直接白屏/整树消亡。本模块用应用层心跳兜底：
//!
//! - 看门狗线程每 [`PING_INTERVAL`] 对主窗口 `eval` 一次
//!   `window.__wdPing&&window.__wdPing()`（同步 JS，不受 rAF/后台节流影响）；
//! - 前端 `__wdPing` 通过 invoke 回调 [`watchdog_pong`] 清零失联计数；
//! - 连续 [`MISSES_ALLOWED`] 个周期无 pong（约 15–18s）判定 webview 已死，
//!   销毁主窗口并按 tauri.conf.json 的原始窗口配置重建——
//!   wry 每个 webview 独立创建 WebView2 environment，重建即拉起新的
//!   browser 进程树，聊天 store / PTY 会话等 Rust 侧状态全部保留。
//!
//! 误判防护：启动与重建后有 [`GRACE`] 宽限期（前端加载/vite dev 慢）；
//! 心跳用连续缺失判定，系统短暂睡眠/卡顿不会立即触发重建。

use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{applog, resume};

const MAIN_LABEL: &str = "main";
const PING_INTERVAL: Duration = Duration::from_secs(3);
const MISSES_ALLOWED: u32 = 6; // 约 18s 无响应判死
const GRACE: Duration = Duration::from_secs(30); // 启动/重建后宽限
const RESUME_DELAY: Duration = Duration::from_millis(1500); // destroy 落地等待

/// 失联计数：每次 ping 递增，pong 清零。
static MISSES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 启动看门狗线程（setup 中调用一次）。
pub fn spawn(app: AppHandle) {
    thread::Builder::new()
        .name("webview-watchdog".into())
        .spawn(move || supervise(app))
        .expect("spawn webview watchdog thread");
}

fn supervise(app: AppHandle) {
    thread::sleep(GRACE);
    let mut misses: u32;
    loop {
        thread::sleep(PING_INTERVAL);
        let Some(win) = app.get_webview_window(MAIN_LABEL) else {
            // 主窗口不存在：应用退出中（关窗即退出是默认行为），收工。
            return;
        };
        // 先记账再 ping：pong 会清零，周期内未清零即一次失联。
        MISSES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        misses = MISSES.load(std::sync::atomic::Ordering::Relaxed);
        if misses > MISSES_ALLOWED {
            applog::event(
                "watchdog",
                &format!("webview 心跳失联 {misses} 个周期，重建主窗口"),
            );
            if rebuild_main_window(&app).is_err() {
                applog::event("watchdog", "重建失败，放弃看护");
                return;
            }
            MISSES.store(0, std::sync::atomic::Ordering::Relaxed);
            resume::mark_webview_crashed();
            thread::sleep(GRACE); // 新页面加载宽限
            continue;
        }
        // eval 为 fire-and-forget；同步 JS 调用不依赖渲染帧调度。
        let _ = win.eval("window.__wdPing&&window.__wdPing()");
    }
}

/// 销毁旧主窗口并按 tauri.conf.json 原配置重建（新 WebView2 进程树）。
fn rebuild_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(old) = app.get_webview_window(MAIN_LABEL) {
        let _ = old.destroy();
    }
    thread::sleep(RESUME_DELAY); // destroy 异步生效，等旧进程树退场避免 label 冲突

    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_LABEL)
        .cloned();
    let mut last_err = None;
    for _ in 0..3 {
        let result = match &config {
            Some(window_config) => match WebviewWindowBuilder::from_config(app, window_config) {
                Ok(builder) => builder.build(),
                Err(err) => Err(err),
            },
            None => WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::default()).build(),
        };
        match result {
            Ok(win) => {
                // 新页面就绪后提示（此时旧页面监听已随进程消亡，由新页面接住）。
                let app = app.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(5));
                    let _ = app.emit("webview-recovered", ());
                    let _ = win.set_focus();
                });
                applog::event("watchdog", "主窗口已重建");
                return Ok(());
            }
            Err(err) => {
                applog::event("watchdog", &format!("重建尝试失败: {err}"));
                last_err = Some(err);
                thread::sleep(PING_INTERVAL);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| tauri::Error::WindowNotFound))
}

/// 前端心跳回执（`window.__wdPing` → invoke）。
#[tauri::command]
pub fn watchdog_pong() {
    MISSES.store(0, std::sync::atomic::Ordering::Relaxed);
}
