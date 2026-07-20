use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, Response};
use tauri::State;

const SELF_ID: &str = "me";
const TERMINAL_ID: &str = "terminal";
const MAX_MESSAGE_CHARS: usize = 2_000;
const MAX_TERMINAL_OUTPUT_CHARS: usize = 12_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: String,
    pub display_name: String,
    pub account: String,
    pub avatar_seed: String,
    pub presence: String,
    pub status_message: String,
    pub group: String,
    pub unread_count: u32,
    pub last_message: String,
    pub last_message_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: u64,
    pub contact_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub text: String,
    pub sent_at: u64,
    pub outgoing: bool,
    pub read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub current_user: Contact,
    pub contacts: Vec<Contact>,
    pub messages: Vec<Message>,
    pub active_contact_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExecution {
    pub command_message: Message,
    pub output_message: Message,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub success: bool,
}

/// A live pseudo-terminal. The shell remains attached to this session until
/// the user explicitly closes it or the shell exits, so cd/env/interactive
/// programs keep their state between commands.
struct PtySession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct PtyState {
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
struct PtyExit {
    session_id: u64,
    exit_code: Option<u32>,
    signal: Option<String>,
    error: Option<String>,
}

#[derive(Debug)]
struct ChatStore {
    current_user: Contact,
    contacts: Vec<Contact>,
    messages: Vec<Message>,
    active_contact_id: String,
    next_message_id: u64,
}

impl ChatStore {
    fn demo() -> Self {
        let now = now_ms();
        let contacts = vec![
            Contact {
                id: "ache".into(),
                display_name: "阿澈".into(),
                account: "10240".into(),
                avatar_seed: "ache".into(),
                presence: "online".into(),
                status_message: "晚风吹过旧操场".into(),
                group: "我的好友".into(),
                unread_count: 0,
                last_message: "那就今晚八点，老地方见。".into(),
                last_message_at: now.saturating_sub(3 * 60_000),
            },
            Contact {
                id: "linxia".into(),
                display_name: "林夏".into(),
                account: "10618".into(),
                avatar_seed: "linxia".into(),
                presence: "away".into(),
                status_message: "正在离开电脑".into(),
                group: "我的好友".into(),
                unread_count: 2,
                last_message: "文件收到了吗？".into(),
                last_message_at: now.saturating_sub(18 * 60_000),
            },
            Contact {
                id: "mayu".into(),
                display_name: "马宇".into(),
                account: "20331".into(),
                avatar_seed: "mayu".into(),
                presence: "online".into(),
                status_message: "山那边信号不错".into(),
                group: "同学".into(),
                unread_count: 0,
                last_message: "周末去爬山？".into(),
                last_message_at: now.saturating_sub(42 * 60_000),
            },
            Contact {
                id: "service".into(),
                display_name: "OICQ 服务台".into(),
                account: "10000".into(),
                avatar_seed: "service".into(),
                presence: "online".into(),
                status_message: "消息服务器运行正常".into(),
                group: "系统联系人".into(),
                unread_count: 0,
                last_message: "欢迎回来，小鲸。".into(),
                last_message_at: now.saturating_sub(90 * 60_000),
            },
            Contact {
                id: TERMINAL_ID.into(),
                display_name: "终端".into(),
                account: "LOCAL SHELL".into(),
                avatar_seed: "terminal".into(),
                presence: "online".into(),
                status_message: "本机命令行 · 可执行命令".into(),
                group: "工具".into(),
                unread_count: 0,
                last_message: "输入 help 查看可用命令。".into(),
                last_message_at: now.saturating_sub(2 * 60_000),
            },
            Contact {
                id: "oldfriend".into(),
                display_name: "旧友 1999".into(),
                account: "66888".into(),
                avatar_seed: "oldfriend".into(),
                presence: "offline".into(),
                status_message: "最后上线：昨天 23:41".into(),
                group: "同学".into(),
                unread_count: 0,
                last_message: "改天再聊。".into(),
                last_message_at: now.saturating_sub(24 * 60 * 60_000),
            },
        ];

        let messages = vec![
            demo_message(
                1,
                "ache",
                "ache",
                "阿澈",
                "在吗？今晚还去老地方吗？",
                now.saturating_sub(12 * 60_000),
                false,
                true,
            ),
            demo_message(
                2,
                "ache",
                SELF_ID,
                "小鲸",
                "在。刚把 OICQ 装回来了，还是这个界面顺眼。",
                now.saturating_sub(9 * 60_000),
                true,
                true,
            ),
            demo_message(
                3,
                "ache",
                "ache",
                "阿澈",
                "那就今晚八点，老地方见。",
                now.saturating_sub(3 * 60_000),
                false,
                true,
            ),
            demo_message(
                4,
                "linxia",
                "linxia",
                "林夏",
                "我把照片压缩好了。",
                now.saturating_sub(21 * 60_000),
                false,
                false,
            ),
            demo_message(
                5,
                "linxia",
                "linxia",
                "林夏",
                "文件收到了吗？",
                now.saturating_sub(18 * 60_000),
                false,
                false,
            ),
            demo_message(
                6,
                "service",
                "service",
                "OICQ 服务台",
                "欢迎回来，小鲸。当前消息服务器运行正常。",
                now.saturating_sub(90 * 60_000),
                false,
                true,
            ),
            demo_message(
                7,
                TERMINAL_ID,
                TERMINAL_ID,
                "终端",
                "Retro Terminal 1.0\n输入 help 查看可用命令。",
                now.saturating_sub(2 * 60_000),
                false,
                true,
            ),
        ];

        let mut store = Self {
            current_user: Contact {
                id: SELF_ID.into(),
                display_name: "小鲸".into(),
                account: "10001".into(),
                avatar_seed: "self".into(),
                presence: "online".into(),
                status_message: "今天也要保持联络".into(),
                group: "self".into(),
                unread_count: 0,
                last_message: String::new(),
                last_message_at: now,
            },
            contacts,
            messages,
            active_contact_id: "ache".into(),
            next_message_id: 20,
        };

        let contact_ids: Vec<String> = store.contacts.iter().map(|item| item.id.clone()).collect();
        for contact_id in contact_ids {
            store.refresh_contact_summary(&contact_id);
        }
        store
    }

    fn snapshot(&self) -> AppSnapshot {
        AppSnapshot {
            current_user: self.current_user.clone(),
            contacts: self.contacts.clone(),
            messages: self.messages.clone(),
            active_contact_id: self.active_contact_id.clone(),
        }
    }

    fn conversation(&self, contact_id: &str) -> Result<Vec<Message>, String> {
        self.contact(contact_id)?;
        Ok(self
            .messages
            .iter()
            .filter(|message| message.contact_id == contact_id)
            .cloned()
            .collect())
    }

    fn send_message(&mut self, contact_id: &str, text: &str) -> Result<Message, String> {
        self.contact(contact_id)?;
        let text = normalize_message(text)?;
        let message = Message {
            id: self.take_message_id(),
            contact_id: contact_id.into(),
            sender_id: SELF_ID.into(),
            sender_name: self.current_user.display_name.clone(),
            text,
            sent_at: now_ms(),
            outgoing: true,
            read: true,
        };
        self.messages.push(message.clone());
        self.active_contact_id = contact_id.into();
        self.refresh_contact_summary(contact_id);
        Ok(message)
    }

    fn execute_terminal(&mut self, input: &str) -> Result<TerminalExecution, String> {
        self.contact(TERMINAL_ID)?;
        let command = normalize_message(input)?;
        let cwd = terminal_working_directory();
        let command_message = Message {
            id: self.take_message_id(),
            contact_id: TERMINAL_ID.into(),
            sender_id: SELF_ID.into(),
            sender_name: self.current_user.display_name.clone(),
            text: command.clone(),
            sent_at: now_ms(),
            outgoing: true,
            read: true,
        };
        self.messages.push(command_message.clone());

        let (text, exit_code, success) = run_terminal_command(&command, &cwd);
        let output_message = Message {
            id: self.take_message_id(),
            contact_id: TERMINAL_ID.into(),
            sender_id: TERMINAL_ID.into(),
            sender_name: "终端".into(),
            text,
            sent_at: now_ms(),
            outgoing: false,
            read: true,
        };
        self.messages.push(output_message.clone());
        self.active_contact_id = TERMINAL_ID.into();
        self.refresh_contact_summary(TERMINAL_ID);

        Ok(TerminalExecution {
            command_message,
            output_message,
            cwd: cwd.to_string_lossy().into_owned(),
            exit_code,
            success,
        })
    }

    fn generate_reply(&mut self, contact_id: &str) -> Result<Message, String> {
        let contact = self.contact(contact_id)?.clone();
        let read = contact_id == self.active_contact_id;
        let context = self
            .messages
            .iter()
            .rev()
            .find(|message| message.contact_id == contact_id && message.outgoing)
            .map(|message| message.text.as_str())
            .unwrap_or("");
        let text = contextual_reply(&contact, context);
        let message = Message {
            id: self.take_message_id(),
            contact_id: contact_id.into(),
            sender_id: contact.id.clone(),
            sender_name: contact.display_name,
            text,
            sent_at: now_ms(),
            outgoing: false,
            read,
        };
        self.messages.push(message.clone());
        self.refresh_contact_summary(contact_id);
        Ok(message)
    }

    fn mark_read(&mut self, contact_id: &str) -> Result<Contact, String> {
        self.contact(contact_id)?;
        self.active_contact_id = contact_id.into();
        for message in &mut self.messages {
            if message.contact_id == contact_id && !message.outgoing {
                message.read = true;
            }
        }
        self.refresh_contact_summary(contact_id);
        self.contact(contact_id).cloned()
    }

    fn set_presence(&mut self, presence: &str) -> Result<Contact, String> {
        let mut presence = presence.trim().to_ascii_lowercase();
        if presence == "invisible" {
            presence = "offline".into();
        }
        if !matches!(presence.as_str(), "online" | "away" | "busy" | "offline") {
            return Err("状态必须是 online、away、busy 或 offline".into());
        }
        self.current_user.presence = presence;
        Ok(self.current_user.clone())
    }

    fn contact(&self, contact_id: &str) -> Result<&Contact, String> {
        self.contacts
            .iter()
            .find(|contact| contact.id == contact_id)
            .ok_or_else(|| format!("找不到联系人：{contact_id}"))
    }

    fn take_message_id(&mut self) -> u64 {
        let id = self.next_message_id;
        self.next_message_id = self.next_message_id.saturating_add(1);
        id
    }

    fn refresh_contact_summary(&mut self, contact_id: &str) {
        let last_message = self
            .messages
            .iter()
            .filter(|message| message.contact_id == contact_id)
            .max_by_key(|message| (message.sent_at, message.id))
            .map(|message| (message.text.clone(), message.sent_at));
        let unread_count = self
            .messages
            .iter()
            .filter(|message| {
                message.contact_id == contact_id && !message.outgoing && !message.read
            })
            .count()
            .min(u32::MAX as usize) as u32;

        if let Some(contact) = self
            .contacts
            .iter_mut()
            .find(|contact| contact.id == contact_id)
        {
            contact.unread_count = unread_count;
            if let Some((text, sent_at)) = last_message {
                contact.last_message = text;
                contact.last_message_at = sent_at;
            }
        }
    }
}

fn demo_message(
    id: u64,
    contact_id: &str,
    sender_id: &str,
    sender_name: &str,
    text: &str,
    sent_at: u64,
    outgoing: bool,
    read: bool,
) -> Message {
    Message {
        id,
        contact_id: contact_id.into(),
        sender_id: sender_id.into(),
        sender_name: sender_name.into(),
        text: text.into(),
        sent_at,
        outgoing,
        read,
    }
}

fn normalize_message(input: &str) -> Result<String, String> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Err("消息不能为空".into());
    }
    if trimmed.chars().count() > MAX_MESSAGE_CHARS {
        return Err(format!("消息不能超过 {MAX_MESSAGE_CHARS} 个字符"));
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err("消息包含不支持的控制字符".into());
    }
    Ok(trimmed.into())
}

fn terminal_working_directory() -> PathBuf {
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

fn run_terminal_command(command: &str, cwd: &Path) -> (String, Option<i32>, bool) {
    if matches!(command.trim().to_ascii_lowercase().as_str(), "help" | "?") {
        return (
            "可直接执行当前系统 shell 命令。\n常用命令：pwd  ls  whoami  date  cargo --version\n命令最长运行 20 秒，输出最多保留 12000 个字符。".into(),
            Some(0),
            true,
        );
    }

    #[cfg(target_os = "windows")]
    let result = Command::new("cmd")
        .args(["/D", "/S", "/C", command])
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .output();

    #[cfg(not(target_os = "windows"))]
    let result = Command::new("timeout")
        .args(["20s", "bash", "-lc", command])
        .current_dir(cwd)
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .output();

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
                text = if exit_code == Some(124) {
                    "命令超过 20 秒，已终止。".into()
                } else if success {
                    "(命令执行完成，没有输出)".into()
                } else {
                    format!("命令执行失败，退出代码：{}", exit_code.unwrap_or(-1))
                };
            }
            (truncate_terminal_output(text), exit_code, success)
        }
        Err(error) => (format!("无法启动本机 shell：{error}"), None, false),
    }
}

fn truncate_terminal_output(value: String) -> String {
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

fn contextual_reply(contact: &Contact, context: &str) -> String {
    let context = context.trim();
    let lower = context.to_lowercase();

    if context.is_empty() {
        return format!("嗨，我是{}。你还在吗？", contact.display_name);
    }
    if contains_any(&lower, &["你好", "在吗", "hello", "hey", "嗨"])
        || lower.split_whitespace().any(|word| word == "hi")
    {
        return "在呢！看到你的消息啦，今天过得怎么样？".into();
    }
    if contains_any(&lower, &["文件", "照片", "图片", "附件", "file", "photo"]) {
        return "收到，我一会儿打开看看，整理好再回复你。".into();
    }
    if contains_any(
        &lower,
        &["几点", "时间", "开会", "会议", "meeting", "tomorrow"],
    ) {
        return "没问题，我记在小本子上了，到时候准时上线。".into();
    }
    if contains_any(&lower, &["吃饭", "午饭", "晚饭", "夜宵", "lunch", "dinner"]) {
        return "可以呀，还是老地方？定好时间告诉我。".into();
    }
    if contains_any(&lower, &["谢谢", "多谢", "thank"]) {
        return "别客气，朋友之间不用这么见外。".into();
    }
    if contains_any(&lower, &["再见", "晚安", "下线", "bye"]) {
        return "好，回头再聊。下次上线记得敲我！".into();
    }
    if lower.contains('?')
        || context.contains('？')
        || contains_any(&lower, &["怎么", "为什么", "可以吗", "是不是"])
    {
        return "这个问题有点意思。我想了一下，应该可以，我们再把细节对一对。".into();
    }

    const FALLBACKS: [&str; 5] = [
        "嗯嗯，我在认真听。你接着说。",
        "听起来不错，等你有空我们细聊。",
        "我明白你的意思了，这个想法挺有趣。",
        "收到！我刚好也想和你说说这件事。",
        "好呀，就这么说定了，晚点我再敲你。",
    ];
    let key = format!("{}:{context}", contact.id);
    FALLBACKS[(stable_hash(&key) % FALLBACKS.len() as u64) as usize].into()
}

fn contains_any(text: &str, candidates: &[&str]) -> bool {
    candidates.iter().any(|candidate| text.contains(candidate))
}

fn stable_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

type ManagedChatState = Mutex<ChatStore>;

#[tauri::command]
fn bootstrap(state: State<'_, ManagedChatState>) -> Result<AppSnapshot, String> {
    let store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    Ok(store.snapshot())
}

#[tauri::command]
fn get_conversation(
    contact_id: String,
    state: State<'_, ManagedChatState>,
) -> Result<Vec<Message>, String> {
    let store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.conversation(&contact_id)
}

#[tauri::command]
fn send_message(
    contact_id: String,
    text: String,
    state: State<'_, ManagedChatState>,
) -> Result<Message, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.send_message(&contact_id, &text)
}

#[tauri::command]
fn generate_reply(
    contact_id: String,
    state: State<'_, ManagedChatState>,
) -> Result<Message, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.generate_reply(&contact_id)
}

#[tauri::command]
fn execute_terminal(
    command: String,
    state: State<'_, ManagedChatState>,
) -> Result<TerminalExecution, String> {
    let mut store = state.lock().map_err(|_| "终端状态暂时不可用".to_string())?;
    store.execute_terminal(&command)
}

/// Open a persistent login shell and stream every byte it writes to xterm.js.
/// `Response` keeps the payload binary, which matters for split UTF-8 sequences
/// and for terminal protocols such as mouse reporting.
#[tauri::command]
fn pty_open(
    rows: u16,
    cols: u16,
    on_data: Channel<Response>,
    on_exit: Channel<PtyExit>,
    state: State<'_, PtyState>,
) -> Result<u64, String> {
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

    let mut command = CommandBuilder::new_default_prog();
    command.cwd(terminal_working_directory());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "RetroMessenger");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // The bundled development Node setup exports this variable for npm. It
    // makes nvm print a warning in every interactive shell and can interfere
    // with Codex's own Node discovery, so leave the normal shell environment
    // in charge of its prefix.
    command.env_remove("NPM_CONFIG_PREFIX");
    command.env_remove("npm_config_prefix");

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("无法读取终端：{error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("无法写入终端：{error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("无法启动 shell：{error}"))?;
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

    Ok(session_id)
}

#[tauri::command]
fn pty_write(session_id: u64, data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
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
fn pty_resize(
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
fn pty_close(session_id: u64, state: State<'_, PtyState>) -> Result<(), String> {
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

#[tauri::command]
fn mark_read(contact_id: String, state: State<'_, ManagedChatState>) -> Result<Contact, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.mark_read(&contact_id)
}

#[tauri::command]
fn set_presence(presence: String, state: State<'_, ManagedChatState>) -> Result<Contact, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.set_presence(&presence)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(ChatStore::demo()))
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            get_conversation,
            send_message,
            generate_reply,
            execute_terminal,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            mark_read,
            set_presence
        ])
        .run(tauri::generate_context!())
        .expect("error while running Retro Messenger");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_message_trims_and_validates_input() {
        let mut store = ChatStore::demo();
        let message = store
            .send_message("ache", "  你好，晚上聊！\r\n  ")
            .expect("valid message should be accepted");

        assert_eq!(message.text, "你好，晚上聊！");
        assert!(message.outgoing);
        assert_eq!(store.active_contact_id, "ache");
        assert_eq!(store.contact("ache").unwrap().last_message, message.text);
        assert!(store.send_message("ache", " \n\t ").is_err());
        assert!(store
            .send_message("ache", &"好".repeat(MAX_MESSAGE_CHARS + 1))
            .is_err());
        assert!(store.send_message("missing", "hello").is_err());
    }

    #[test]
    fn generated_reply_is_contextual_and_deterministic() {
        let contact = ChatStore::demo().contact("ache").unwrap().clone();
        assert_eq!(
            contextual_reply(&contact, "文件已经发给你了"),
            contextual_reply(&contact, "文件已经发给你了")
        );
        assert!(contextual_reply(&contact, "文件已经发给你了").contains("收到"));

        let mut store = ChatStore::demo();
        store.send_message("ache", "明天几点开会？").unwrap();
        let reply = store.generate_reply("ache").unwrap();
        assert!(!reply.outgoing);
        assert!(reply.read);
        assert!(reply.text.contains("准时"));
        assert_eq!(store.contact("ache").unwrap().unread_count, 0);

        store.mark_read("linxia").unwrap();
        let background_reply = store.generate_reply("ache").unwrap();
        assert!(!background_reply.read);
        assert_eq!(store.contact("ache").unwrap().unread_count, 1);
    }

    #[test]
    fn terminal_executes_commands_and_records_the_session() {
        let mut store = ChatStore::demo();
        let execution = store.execute_terminal("echo retro-terminal").unwrap();

        assert!(execution.success);
        assert_eq!(execution.exit_code, Some(0));
        assert!(execution.output_message.text.contains("retro-terminal"));
        assert_eq!(store.active_contact_id, TERMINAL_ID);
        assert_eq!(
            store.contact(TERMINAL_ID).unwrap().last_message,
            execution.output_message.text
        );
        assert!(store.execute_terminal(" \n ").is_err());
    }

    #[test]
    fn state_snapshot_read_and_presence_changes_stay_consistent() {
        let mut store = ChatStore::demo();
        assert_eq!(store.contact("linxia").unwrap().unread_count, 2);

        let contact = store.mark_read("linxia").unwrap();
        assert_eq!(contact.unread_count, 0);
        assert_eq!(store.active_contact_id, "linxia");
        assert!(store
            .conversation("linxia")
            .unwrap()
            .iter()
            .all(|message| message.outgoing || message.read));

        let current_user = store.set_presence(" Away ").unwrap();
        assert_eq!(current_user.presence, "away");
        assert!(store.set_presence("sleeping").is_err());

        let snapshot = store.snapshot();
        assert_eq!(snapshot.current_user.presence, "away");
        assert_eq!(snapshot.contacts.len(), 6);
        assert_eq!(snapshot.active_contact_id, "linxia");
    }
}
