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
use tauri::{Emitter, State};

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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderLocation {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderResolution {
    pub name: String,
    pub path: String,
    pub wsl_path: String,
    pub wsl_distribution: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpenResult {
    pub session_id: u64,
    pub project: Option<ProjectFolderResolution>,
}

/// External, user-editable JSON file (`project-folders.json` next to the exe)
/// that stores project directories (roster groups) and their project folders.
/// The file is portable: copying it alongside the exe carries the roster to
/// another machine without any per-computer state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDirectoryRecord {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderRecord {
    pub id: String,
    pub directory_id: String,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl_distribution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStoreFile {
    #[serde(default)]
    pub directories: Vec<ProjectDirectoryRecord>,
    #[serde(default)]
    pub folders: Vec<ProjectFolderRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedProjectFolder {
    location: ProjectFolderLocation,
    wsl_path: String,
    wsl_distribution: Option<String>,
    windows_path: Option<String>,
    source: ProjectFolderSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectFolderSource {
    WindowsDrive,
    WindowsUnc,
    WslUnc,
    Wsl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectShellTarget {
    wsl_path: String,
    wsl_distribution: Option<String>,
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
                display_name: "WSL 终端".into(),
                account: "WSL SHELL".into(),
                avatar_seed: "terminal".into(),
                presence: "online".into(),
                status_message: "WSL2 默认发行版 · Linux shell".into(),
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
                "WSL 终端",
                "Retro WSL Terminal 1.0\n输入 help 查看可用 Linux 命令。",
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

    fn create_terminal_contact(&mut self) -> Contact {
        let mut ordinal = 2_u32;
        let (id, display_name) = loop {
            let id = format!("terminal-{ordinal}");
            if self.contacts.iter().all(|contact| contact.id != id) {
                break (id, format!("WSL 终端 {ordinal}"));
            }
            ordinal = ordinal.saturating_add(1);
        };
        let contact = Contact {
            id: id.clone(),
            display_name,
            account: format!("WSL SHELL #{ordinal}"),
            avatar_seed: "terminal".into(),
            presence: "online".into(),
            status_message: "独立 WSL2 终端会话".into(),
            group: "工具".into(),
            unread_count: 0,
            last_message: "等待启动 Linux shell。".into(),
            last_message_at: now_ms(),
        };
        self.contacts.push(contact.clone());
        self.active_contact_id = id;
        contact
    }

    fn rename_terminal_contact(
        &mut self,
        contact_id: &str,
        display_name: &str,
    ) -> Result<Contact, String> {
        if !is_terminal_contact_id(contact_id) {
            return Err("只能重命名 WSL 终端".into());
        }
        let display_name = normalize_terminal_name(display_name)?;
        let contact = self
            .contacts
            .iter_mut()
            .find(|contact| contact.id == contact_id)
            .ok_or_else(|| format!("找不到终端：{contact_id}"))?;
        contact.display_name = display_name;
        Ok(contact.clone())
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
            sender_name: "WSL 终端".into(),
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

fn is_terminal_contact_id(contact_id: &str) -> bool {
    contact_id == TERMINAL_ID
        || contact_id
            .strip_prefix("terminal-")
            .map(|suffix| {
                !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
            })
            .unwrap_or(false)
}

fn normalize_terminal_name(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("终端名称不能为空".into());
    }
    if trimmed.chars().count() > 24 {
        return Err("终端名称不能超过 24 个字符".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("终端名称包含不支持的控制字符".into());
    }
    Ok(trimmed.into())
}

fn windows_component_is_valid(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
        && !component.ends_with('.')
        && !component.ends_with(' ')
}

fn normalize_project_components(input: &str, windows_rules: bool) -> Result<Vec<String>, String> {
    let mut components = Vec::new();
    for component in input.split(|character| character == '\\' || character == '/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            if components.pop().is_none() {
                return Err("项目路径不能越过根目录".into());
            }
            continue;
        }
        if component.chars().any(char::is_control) {
            return Err("项目路径包含不支持的控制字符".into());
        }
        if windows_rules && !windows_component_is_valid(component) {
            return Err("项目路径包含 Windows 不支持的字符".into());
        }
        components.push(component.to_string());
    }
    Ok(components)
}

fn parse_windows_drive_path(input: &str) -> Option<Result<ResolvedProjectFolder, String>> {
    let mut characters = input.chars();
    let drive = characters.next()?;
    if characters.next() != Some(':') {
        return None;
    }
    if !drive.is_ascii_alphabetic() || !matches!(characters.next(), Some('\\' | '/')) {
        return Some(Err(
            "Windows 项目路径必须是盘符绝对路径，例如 C:\\workspace\\project".into(),
        ));
    }

    let drive = drive.to_ascii_uppercase();
    let components = match normalize_project_components(characters.as_str(), true) {
        Ok(components) => components,
        Err(error) => return Some(Err(error)),
    };
    let path = if components.is_empty() {
        format!("{drive}:\\")
    } else {
        format!("{drive}:\\{}", components.join("\\"))
    };
    let name = components
        .last()
        .cloned()
        .unwrap_or_else(|| format!("{drive} 盘"));
    let drive_lower = drive.to_ascii_lowercase();
    let wsl_path = if components.is_empty() {
        format!("/mnt/{drive_lower}")
    } else {
        format!("/mnt/{drive_lower}/{}", components.join("/"))
    };

    Some(Ok(ResolvedProjectFolder {
        location: ProjectFolderLocation {
            name,
            path: path.clone(),
        },
        wsl_path,
        wsl_distribution: None,
        windows_path: Some(path),
        source: ProjectFolderSource::WindowsDrive,
    }))
}

fn parse_windows_unc_path(input: &str) -> Result<ResolvedProjectFolder, String> {
    let components: Vec<&str> = input
        .trim_start_matches(|character| character == '\\' || character == '/')
        .split(|character| character == '\\' || character == '/')
        .filter(|component| !component.is_empty())
        .collect();
    if components.len() < 2 {
        return Err("UNC 项目路径必须包含服务器和共享名称".into());
    }

    let server = components[0];
    let share = components[1];
    let is_wsl_unc =
        server.eq_ignore_ascii_case("wsl.localhost") || server.eq_ignore_ascii_case("wsl$");
    if is_wsl_unc {
        if !windows_component_is_valid(share) {
            return Err("WSL 发行版名称无效".into());
        }
        let linux_components = normalize_project_components(&components[2..].join("/"), false)?;
        let server = if server.eq_ignore_ascii_case("wsl.localhost") {
            "wsl.localhost"
        } else {
            "wsl$"
        };
        let mut path = format!(r"\\{server}\{share}");
        if !linux_components.is_empty() {
            path.push('\\');
            path.push_str(&linux_components.join("\\"));
        }
        let wsl_path = if linux_components.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", linux_components.join("/"))
        };
        let name = linux_components
            .last()
            .cloned()
            .unwrap_or_else(|| share.to_string());
        return Ok(ResolvedProjectFolder {
            location: ProjectFolderLocation {
                name,
                path: path.clone(),
            },
            wsl_path,
            wsl_distribution: Some(share.to_string()),
            windows_path: Some(path),
            source: ProjectFolderSource::WslUnc,
        });
    }

    if !windows_component_is_valid(server) || !windows_component_is_valid(share) {
        return Err("UNC 项目路径的服务器或共享名称无效".into());
    }
    let path_components = normalize_project_components(&components[2..].join("/"), true)?;
    let mut path = format!(r"\\{server}\{share}");
    if !path_components.is_empty() {
        path.push('\\');
        path.push_str(&path_components.join("\\"));
    }
    let name = path_components
        .last()
        .cloned()
        .unwrap_or_else(|| share.to_string());
    Ok(ResolvedProjectFolder {
        location: ProjectFolderLocation {
            name,
            path: path.clone(),
        },
        wsl_path: path.clone(),
        wsl_distribution: None,
        windows_path: Some(path),
        source: ProjectFolderSource::WindowsUnc,
    })
}

fn parse_wsl_path(input: &str) -> Result<ResolvedProjectFolder, String> {
    let components = normalize_project_components(input, false)?;
    let path = if components.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", components.join("/"))
    };
    let name = components
        .last()
        .cloned()
        .unwrap_or_else(|| "/".to_string());
    Ok(ResolvedProjectFolder {
        location: ProjectFolderLocation {
            name,
            path: path.clone(),
        },
        wsl_path: path,
        wsl_distribution: None,
        windows_path: None,
        source: ProjectFolderSource::Wsl,
    })
}

fn wsl_home_relative_path(input: &str) -> Option<Result<Vec<String>, String>> {
    let trimmed = input.trim();
    if matches!(trimmed, "~" | "/~") {
        return Some(Ok(Vec::new()));
    }
    if let Some(relative) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix(r"~\"))
        .or_else(|| trimmed.strip_prefix("/~/"))
    {
        return Some(normalize_project_components(relative, false));
    }
    None
}

fn validated_project_folder_input(input: &str) -> Result<&str, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("项目路径不能为空".into());
    }
    if trimmed.chars().count() > 1024 {
        return Err("项目路径不能超过 1024 个字符".into());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("项目路径包含不支持的控制字符".into());
    }
    Ok(trimmed)
}

fn parse_project_folder_path_with_wsl_home<F>(
    input: &str,
    resolve_wsl_home: F,
) -> Result<ResolvedProjectFolder, String>
where
    F: FnOnce() -> Result<String, String>,
{
    let input = validated_project_folder_input(input)?;
    if let Some(relative_components) = wsl_home_relative_path(input) {
        let relative_components = relative_components?;
        let home = resolve_wsl_home()?;
        if !home.starts_with('/') {
            return Err("WSL 返回的用户主目录不是绝对路径".into());
        }
        let home = parse_project_folder_path(&home)?;
        let path = if relative_components.is_empty() {
            home.wsl_path
        } else if home.wsl_path == "/" {
            format!("/{}", relative_components.join("/"))
        } else {
            format!("{}/{}", home.wsl_path, relative_components.join("/"))
        };
        return parse_project_folder_path(&path);
    }
    parse_project_folder_path(input)
}

fn parse_project_folder_path(input: &str) -> Result<ResolvedProjectFolder, String> {
    let trimmed = validated_project_folder_input(input)?;
    if trimmed.starts_with('~') {
        return Err("WSL 用户主目录路径仅支持 ~ 或 ~/...".into());
    }
    if let Some(result) = parse_windows_drive_path(trimmed) {
        return result;
    }
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return parse_windows_unc_path(trimmed);
    }
    parse_wsl_path(trimmed)
}

fn project_shell_target_from_cache(
    wsl_path: &str,
    wsl_distribution: Option<&str>,
) -> Result<ProjectShellTarget, String> {
    if wsl_path.trim() != wsl_path
        || wsl_path.chars().count() > 1024
        || wsl_path.chars().any(char::is_control)
        || !wsl_path.starts_with('/')
        || legacy_wsl_home_cache_path(wsl_path)
    {
        return Err("项目的 WSL 路径缓存无效，请重新添加该项目".into());
    }
    let normalized = parse_wsl_path(wsl_path)?;
    if normalized.wsl_path != wsl_path {
        return Err("项目的 WSL 路径缓存无效，请重新添加该项目".into());
    }

    let wsl_distribution = wsl_distribution
        .map(|distribution| {
            if distribution.trim() != distribution
                || distribution.chars().count() > 128
                || distribution
                    .chars()
                    .any(|character| matches!(character, '/' | '\\'))
                || !windows_component_is_valid(distribution)
            {
                return Err("项目的 WSL 发行版缓存无效，请重新添加该项目".to_string());
            }
            Ok(distribution.to_string())
        })
        .transpose()?;

    Ok(ProjectShellTarget {
        wsl_path: wsl_path.to_string(),
        wsl_distribution,
    })
}

fn project_shell_target(resolved: &ResolvedProjectFolder) -> ProjectShellTarget {
    ProjectShellTarget {
        wsl_path: resolved.wsl_path.clone(),
        wsl_distribution: resolved.wsl_distribution.clone(),
    }
}

fn project_folder_resolution(resolved: ResolvedProjectFolder) -> ProjectFolderResolution {
    ProjectFolderResolution {
        name: resolved.location.name,
        path: resolved.location.path,
        wsl_path: resolved.wsl_path,
        wsl_distribution: resolved.wsl_distribution,
    }
}

fn onecommander_candidate_paths(
    configured_executable: Option<&Path>,
    program_files_roots: &[PathBuf],
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut push_candidate = |candidate: PathBuf| {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    };

    if let Some(executable) = configured_executable {
        push_candidate(executable.to_path_buf());
    }
    for root in program_files_roots {
        push_candidate(root.join("OneCommander").join("OneCommander.exe"));
        push_candidate(root.join("OneCommander V3").join("OneCommander.exe"));
    }
    if let Some(root) = local_app_data {
        push_candidate(root.join("OneCommander").join("OneCommander.exe"));
        push_candidate(
            root.join("Programs")
                .join("OneCommander")
                .join("OneCommander.exe"),
        );
        push_candidate(
            root.join("Microsoft")
                .join("WindowsApps")
                .join("OneCommander.exe"),
        );
    }

    // Keep PATH as the final fallback for portable and app-alias installs.
    push_candidate(PathBuf::from("OneCommander.exe"));
    candidates
}

fn onecommander_command(executable: &Path, project_path: &str) -> Command {
    let mut command = Command::new(executable);
    command.arg(project_path);
    command
}

fn onecommander_project_path<F>(
    path: &str,
    wsl_distribution: Option<&str>,
    convert_wsl_path: F,
) -> Result<String, String>
where
    F: FnOnce(&str, Option<&str>) -> Result<String, String>,
{
    let resolved = parse_project_folder_path(path)?;
    if let Some(windows_path) = resolved.windows_path {
        return Ok(windows_path);
    }

    let target = project_shell_target_from_cache(&resolved.wsl_path, wsl_distribution)?;
    let converted = convert_wsl_path(&target.wsl_path, target.wsl_distribution.as_deref())?;
    let converted = parse_project_folder_path(&converted)?;
    converted
        .windows_path
        .ok_or_else(|| "WSL 返回的项目路径不是 Windows 资源管理器可访问的绝对路径".to_string())
}

#[cfg(target_os = "windows")]
fn installed_onecommander_candidates() -> Vec<PathBuf> {
    let configured = std::env::var_os("ONECOMMANDER_EXE").map(PathBuf::from);
    let program_files_roots: Vec<PathBuf> = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    onecommander_candidate_paths(
        configured.as_deref(),
        &program_files_roots,
        local_app_data.as_deref(),
    )
}

#[cfg(target_os = "windows")]
fn launch_onecommander(project_path: &str) -> Result<(), String> {
    let mut launch_errors = Vec::new();
    for executable in installed_onecommander_candidates() {
        let is_path_fallback = executable == Path::new("OneCommander.exe");
        if !is_path_fallback && !executable.is_file() {
            continue;
        }
        match onecommander_command(&executable, project_path).spawn() {
            Ok(_) => return Ok(()),
            Err(error) if is_path_fallback && error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => launch_errors.push(format!("{}：{error}", executable.display())),
        }
    }

    if launch_errors.is_empty() {
        Err("未找到 OneCommander，请确认已在 Windows 中安装 OneCommander".into())
    } else {
        Err(format!(
            "无法启动 OneCommander：{}",
            launch_errors.join("；")
        ))
    }
}

#[cfg(target_os = "windows")]
fn wsl_command(distribution: Option<&str>) -> Command {
    let mut command = Command::new("wsl.exe");
    if let Some(distribution) = distribution {
        command.args(["--distribution", distribution]);
    }
    command
}

#[cfg(target_os = "windows")]
fn wsl_command_text(mut command: Command) -> Result<String, String> {
    let output = command
        .output()
        .map_err(|error| format!("无法启动 WSL：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "WSL 无法访问该项目文件夹".into()
        } else {
            format!("WSL 无法访问该项目文件夹：{detail}")
        });
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("WSL 未返回项目路径".into());
    }
    Ok(text)
}

#[cfg(target_os = "windows")]
fn windows_path_to_wsl(path: &str) -> Result<String, String> {
    let mut command = wsl_command(None);
    command.args(["--cd", path, "--exec", "pwd"]);
    wsl_command_text(command)
}

#[cfg(target_os = "windows")]
fn current_wsl_home_directory() -> Result<String, String> {
    let mut command = wsl_command(None);
    command.args(["--exec", "/bin/sh", "-lc", r#"printf '%s\n' "$HOME""#]);
    wsl_command_text(command).map_err(|error| format!("无法解析 WSL 用户主目录：{error}"))
}

#[cfg(not(target_os = "windows"))]
fn current_wsl_home_directory() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "无法解析当前用户主目录：未设置 HOME".into())
}

fn parse_project_folder_for_current_platform(input: &str) -> Result<ResolvedProjectFolder, String> {
    parse_project_folder_path_with_wsl_home(input, current_wsl_home_directory)
}

fn legacy_wsl_home_cache_path(path: &str) -> bool {
    path == "/~" || path.starts_with("/~/")
}

#[cfg(target_os = "windows")]
fn wsl_path_to_windows(path: &str, distribution: Option<&str>) -> Result<String, String> {
    let mut command = wsl_command(distribution);
    command.args(["--cd", path, "--exec", "wslpath", "-w", "."]);
    wsl_command_text(command)
}

fn resolve_project_folder_path(input: &str) -> Result<ResolvedProjectFolder, String> {
    let mut resolved = parse_project_folder_for_current_platform(input)?;

    #[cfg(target_os = "windows")]
    {
        if let Some(windows_path) = resolved.windows_path.as_deref() {
            if Path::new(windows_path).is_dir() {
                if resolved.source == ProjectFolderSource::WslUnc {
                    return Ok(resolved);
                }
                resolved.wsl_path = windows_path_to_wsl(windows_path).map_err(|error| {
                    format!("Windows 可以访问该文件夹，但当前 WSL 无法将其作为工作目录：{error}")
                })?;
                return Ok(resolved);
            }

            if matches!(
                resolved.source,
                ProjectFolderSource::WindowsDrive | ProjectFolderSource::WslUnc
            ) {
                if let Ok(explorer_path) =
                    wsl_path_to_windows(&resolved.wsl_path, resolved.wsl_distribution.as_deref())
                {
                    let original_wsl_path = resolved.wsl_path.clone();
                    let mut fallback = parse_project_folder_path(&explorer_path)?;
                    fallback.wsl_path = original_wsl_path;
                    return Ok(fallback);
                }
            }
            return Err(format!("项目文件夹不存在或无法访问：{windows_path}"));
        }

        let explorer_path = wsl_path_to_windows(&resolved.wsl_path, None)?;
        let original_wsl_path = resolved.wsl_path.clone();
        let mut fallback = parse_project_folder_path(&explorer_path)?;
        fallback.wsl_path = original_wsl_path;
        return Ok(fallback);
    }

    #[cfg(not(target_os = "windows"))]
    {
        if Path::new(&resolved.wsl_path).is_dir() {
            Ok(resolved)
        } else {
            Err(format!(
                "项目文件夹不存在或无法访问：{}",
                resolved.location.path
            ))
        }
    }
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

fn terminal_help_text() -> &'static str {
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
fn run_platform_terminal_command(
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
fn run_platform_terminal_command(
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
fn terminal_command_timed_out(_exit_code: Option<i32>) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
fn terminal_command_timed_out(exit_code: Option<i32>) -> bool {
    exit_code == Some(124)
}

fn run_terminal_command(command: &str, cwd: &Path) -> (String, Option<i32>, bool) {
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

#[cfg(target_os = "windows")]
fn pty_shell_candidates() -> Vec<(&'static str, CommandBuilder)> {
    vec![("WSL", CommandBuilder::new("wsl.exe"))]
}

#[cfg(not(target_os = "windows"))]
fn pty_shell_candidates() -> Vec<(&'static str, CommandBuilder)> {
    vec![("系统默认 shell", CommandBuilder::new_default_prog())]
}

fn configure_pty_command(
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
fn configure_wslg_input_backend() {
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

/** 终端图片文件名清洗：仅保留字母数字与 . _ -，去掉首尾点，防路径注入 */
fn sanitize_terminal_image_name(file_name: &str) -> String {
    let clean: String = file_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    let clean = clean.trim_matches('.');
    if clean.is_empty() {
        "qq-img.png".to_string()
    } else {
        clean.to_string()
    }
}

fn is_terminal_image_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

/** 校验前端传入的图片路径：绝对路径、无控制字符、无 .. 、图片扩展名 */
fn validated_terminal_image_path(path: &str) -> Result<&str, String> {
    let absolute = path.starts_with('/')
        || path.starts_with('\\')
        || (path.len() >= 2
            && path.as_bytes()[1] == b':'
            && path.as_bytes()[0].is_ascii_alphabetic());
    if !absolute || path.len() > 1024 || path.chars().any(|c| c.is_control()) {
        return Err(format!("图片路径不合法：{path}"));
    }
    if path.split(['/', '\\']).any(|component| component == "..") {
        return Err(format!("图片路径不合法：{path}"));
    }
    if !is_terminal_image_path(path) {
        return Err("只支持 png/jpg/jpeg/gif/webp/bmp 图片".into());
    }
    Ok(path)
}

/** WSL POSIX 路径映射到 Windows UNC（默认发行版 Ubuntu），Windows 路径原样返回 */
#[cfg(target_os = "windows")]
fn resolve_terminal_image_path(path: &str) -> Result<std::path::PathBuf, String> {
    if path.starts_with('\\')
        || (path.len() >= 2
            && path.as_bytes()[1] == b':'
            && path.as_bytes()[0].is_ascii_alphabetic())
    {
        return Ok(std::path::PathBuf::from(path));
    }
    if path.starts_with('/') {
        return Ok(std::path::PathBuf::from(format!(
            r"\\wsl.localhost\Ubuntu{}",
            path.replace('/', "\\")
        )));
    }
    Err(format!("不支持的图片路径：{path}"))
}

#[cfg(not(target_os = "windows"))]
fn resolve_terminal_image_path(path: &str) -> Result<std::path::PathBuf, String> {
    if path.starts_with('/') {
        Ok(std::path::PathBuf::from(path))
    } else {
        Err(format!("不支持的图片路径：{path}"))
    }
}

fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.len() > 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e {
        "image/png"
    } else if bytes.len() > 2 && bytes[0] == 0xff && bytes[1] == 0xd8 {
        "image/jpeg"
    } else if bytes.len() > 3 && bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 {
        "image/gif"
    } else if bytes.len() > 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[8] == 0x57 {
        "image/webp"
    } else {
        "image/png"
    }
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let bytes = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let triple = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 读取终端图片文件（/tmp/... 映射到 \\wsl.localhost），返回 data: URL 供前端悬浮预览。
#[tauri::command(async)]
fn read_terminal_image(path: String) -> Result<String, String> {
    let path = validated_terminal_image_path(&path)?;
    let host_path = resolve_terminal_image_path(path)?;
    let bytes = std::fs::read(&host_path).map_err(|e| format!("读取图片失败：{e}"))?;
    if bytes.is_empty() {
        return Err("图片文件为空".into());
    }
    Ok(format!(
        "data:{};base64,{}",
        sniff_image_mime(&bytes),
        base64_encode(&bytes)
    ))
}

fn export_terminal_image_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return std::path::PathBuf::from(profile)
            .join("Pictures")
            .join("qq_codex");
    }
    #[cfg(not(target_os = "windows"))]
    if let Ok(home) = std::env::var("HOME") {
        return std::path::PathBuf::from(home)
            .join("Pictures")
            .join("qq_codex");
    }
    std::env::temp_dir().join("qq_codex")
}

/// 保存终端图片到宿主图片文件夹（Windows：图片\qq_codex），同名自动追加序号，返回保存路径。
#[tauri::command(async)]
fn export_terminal_image(path: String) -> Result<String, String> {
    let path = validated_terminal_image_path(&path)?;
    let host_path = resolve_terminal_image_path(path)?;
    let bytes = std::fs::read(&host_path).map_err(|e| format!("读取图片失败：{e}"))?;
    if bytes.is_empty() {
        return Err("图片文件为空".into());
    }
    let name = sanitize_terminal_image_name(
        std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("qq-img.png"),
    );
    let source = std::path::Path::new(&name);
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("qq-img");
    let extension = source.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let target_dir = export_terminal_image_dir();
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建保存目录失败：{e}"))?;
    let mut target = target_dir.join(format!("{stem}.{extension}"));
    let mut counter = 1;
    while target.exists() {
        target = target_dir.join(format!("{stem}-{counter}.{extension}"));
        counter += 1;
    }
    std::fs::write(&target, &bytes).map_err(|e| format!("写入图片失败：{e}"))?;
    Ok(target.to_string_lossy().replace('\\', "/"))
}

/// 终端图片落盘：把 OSC 1337 截获的图片字节写入 WSL /tmp，返回 WSL 绝对路径。
/// 前端把该路径写入终端流，悬浮路径即可预览。
#[tauri::command(async)]
fn save_terminal_image(bytes: Vec<u8>, file_name: String) -> Result<String, String> {
    use std::io::Write;

    let file_name = sanitize_terminal_image_name(&file_name);

    #[cfg(target_os = "windows")]
    let (host_root, stream_path) = {
        // 写入默认发行版 /tmp（通过 \\wsl.localhost UNC 路径；不存在时退回系统临时目录）
        let root = r"\\wsl.localhost\Ubuntu\tmp".to_string();
        (root, format!("/tmp/{file_name}"))
    };
    #[cfg(not(target_os = "windows"))]
    let (host_root, stream_path) = {
        let root = "/tmp".to_string();
        (root, format!("/tmp/{file_name}"))
    };

    let target_dir = std::path::Path::new(&host_root);
    if target_dir.is_dir() {
        let target = target_dir.join(&file_name);
        let mut file =
            std::fs::File::create(&target).map_err(|e| format!("无法创建图片文件：{e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("写入图片失败：{e}"))?;
        return Ok(stream_path);
    }

    // 兜底：WSL 路径不可用时写入系统临时目录，返回宿主路径
    let fallback_dir = std::env::temp_dir();
    let target = fallback_dir.join(&file_name);
    let mut file = std::fs::File::create(&target).map_err(|e| format!("无法创建图片文件：{e}"))?;
    file.write_all(&bytes)
        .map_err(|e| format!("写入图片失败：{e}"))?;
    Ok(target.to_string_lossy().replace('\\', "/"))
}

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
fn create_terminal_contact(state: State<'_, ManagedChatState>) -> Result<Contact, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    Ok(store.create_terminal_contact())
}

#[tauri::command]
fn rename_terminal_contact(
    contact_id: String,
    display_name: String,
    state: State<'_, ManagedChatState>,
) -> Result<Contact, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.rename_terminal_contact(&contact_id, &display_name)
}

#[tauri::command]
fn execute_terminal(
    command: String,
    state: State<'_, ManagedChatState>,
) -> Result<TerminalExecution, String> {
    let mut store = state.lock().map_err(|_| "终端状态暂时不可用".to_string())?;
    store.execute_terminal(&command)
}

#[tauri::command]
fn parse_project_folder(path: String) -> Result<ProjectFolderResolution, String> {
    parse_project_folder_for_current_platform(&path).map(project_folder_resolution)
}

const PROJECT_STORE_FILE_NAME: &str = "project-folders.json";
const PROJECT_STORE_POLL_INTERVAL_MS: u64 = 1_500;
const PROJECT_STORE_CHANGED_EVENT: &str = "project-store-changed";

fn project_store_file_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法定位可执行文件：{error}"))?;
    let directory = exe
        .parent()
        .ok_or_else(|| "无法定位可执行文件所在目录".to_string())?;
    Ok(directory.join(PROJECT_STORE_FILE_NAME))
}

fn project_store_signature(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

#[tauri::command]
fn project_store_path() -> Result<String, String> {
    project_store_file_path().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_project_store() -> Result<Option<ProjectStoreFile>, String> {
    let path = project_store_file_path()?;
    if !path.is_file() {
        return Ok(None);
    }
    let content =
        std::fs::read_to_string(&path).map_err(|error| format!("无法读取项目数据文件：{error}"))?;
    let store = serde_json::from_str::<ProjectStoreFile>(&content)
        .map_err(|error| format!("项目数据文件格式无效：{error}"))?;
    Ok(Some(store))
}

#[tauri::command]
fn write_project_store(store: ProjectStoreFile) -> Result<(), String> {
    let path = project_store_file_path()?;
    let mut json = serde_json::to_string_pretty(&store)
        .map_err(|error| format!("无法序列化项目数据：{error}"))?;
    json.push('\n');
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, json).map_err(|error| format!("无法写入项目数据文件：{error}"))?;
    std::fs::rename(&temp_path, &path).map_err(|error| format!("无法更新项目数据文件：{error}"))?;
    Ok(())
}

#[tauri::command(async)]
fn open_project_store_file() -> Result<(), String> {
    let path = project_store_file_path()?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd")
            .args(["/C", "start", "", &path.to_string_lossy()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("无法打开项目数据文件：{error}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|error| format!("无法打开项目数据文件：{error}"))?;
        Ok(())
    }
}

fn spawn_project_store_watcher(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut last_signature: Option<Option<(u64, Option<SystemTime>)>> = None;
        loop {
            thread::sleep(Duration::from_millis(PROJECT_STORE_POLL_INTERVAL_MS));
            let signature = project_store_file_path()
                .ok()
                .and_then(|path| project_store_signature(&path));
            let changed = last_signature.is_some_and(|previous| previous != signature);
            last_signature = Some(signature);
            if changed {
                if let Err(error) = app.emit(PROJECT_STORE_CHANGED_EVENT, ()) {
                    eprintln!("无法广播项目数据文件变更：{error}");
                }
            }
        }
    });
}

#[tauri::command(async)]
fn open_project_folder_in_onecommander(
    path: String,
    wsl_distribution: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let project_path =
            onecommander_project_path(&path, wsl_distribution.as_deref(), wsl_path_to_windows)?;
        return launch_onecommander(&project_path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, wsl_distribution);
        Err("只能在 Windows 版应用中使用 OneCommander 打开项目文件夹".into())
    }
}

/// Open a persistent login shell and stream every byte it writes to xterm.js.
/// `Response` keeps the payload binary, which matters for split UTF-8 sequences
/// and for terminal protocols such as mouse reporting.
#[tauri::command(async)]
fn pty_open(
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
    #[cfg(target_os = "linux")]
    configure_wslg_input_backend();

    tauri::Builder::default()
        .setup(|app| {
            spawn_project_store_watcher(app.handle().clone());

            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{InputMethodContextExt, WebViewExt};

                // Wry 0.55 disables WebKitGTK preedit by default. Re-enable it
                // so Fcitx/IBus can deliver proper DOM composition events and
                // render an in-place candidate string in input/textarea fields.
                if let Some(main_webview) = app.get_webview_window("main") {
                    main_webview.with_webview(|platform_webview| {
                        if let Some(input_context) = platform_webview.inner().input_method_context()
                        {
                            input_context.set_enable_preedit(true);
                        }
                    })?;
                }
            }

            Ok(())
        })
        .manage(Mutex::new(ChatStore::demo()))
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            get_conversation,
            send_message,
            generate_reply,
            create_terminal_contact,
            rename_terminal_contact,
            execute_terminal,
            parse_project_folder,
            open_project_folder_in_onecommander,
            project_store_path,
            read_project_store,
            write_project_store,
            open_project_store_file,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            save_terminal_image,
            read_terminal_image,
            export_terminal_image,
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
    fn terminal_contacts_are_independent_and_numbered() {
        let mut store = ChatStore::demo();
        let second = store.create_terminal_contact();
        let third = store.create_terminal_contact();

        assert_eq!(second.id, "terminal-2");
        assert_eq!(second.display_name, "WSL 终端 2");
        assert_eq!(third.id, "terminal-3");
        assert_eq!(third.group, "工具");
        assert_eq!(store.active_contact_id, third.id);
        assert!(store.conversation(&second.id).unwrap().is_empty());
        assert_eq!(store.snapshot().contacts.len(), 8);

        let renamed = store
            .rename_terminal_contact(&second.id, "  项目终端  ")
            .unwrap();
        assert_eq!(renamed.display_name, "项目终端");
        assert_eq!(store.contact(&second.id).unwrap().display_name, "项目终端");
        assert!(store.rename_terminal_contact("ache", "错误名称").is_err());
        assert!(store.rename_terminal_contact(&third.id, "   ").is_err());
        assert!(store
            .rename_terminal_contact(&third.id, &"终".repeat(25))
            .is_err());
    }

    #[test]
    fn project_folder_paths_are_normalized_for_windows_and_wsl() {
        let drive =
            parse_project_folder_path(r#"  d:/Workspace//中文 项目/.\packages\..\app  "#).unwrap();

        assert_eq!(drive.location.name, "app");
        assert_eq!(drive.location.path, r#"D:\Workspace\中文 项目\app"#);
        assert_eq!(drive.wsl_path, "/mnt/d/Workspace/中文 项目/app");
        assert_eq!(drive.source, ProjectFolderSource::WindowsDrive);

        let root = parse_project_folder_path(r#"c:\"#).unwrap();
        assert_eq!(root.location.name, "C 盘");
        assert_eq!(root.location.path, r#"C:\"#);
        assert_eq!(root.wsl_path, "/mnt/c");

        let unc = parse_project_folder_path(
            r#"\\wsl.localhost\Ubuntu\home\developer\project\CNV_polidy_identify"#,
        )
        .unwrap();
        assert_eq!(unc.location.name, "CNV_polidy_identify");
        assert_eq!(
            unc.location.path,
            r#"\\wsl.localhost\Ubuntu\home\developer\project\CNV_polidy_identify"#
        );
        assert_eq!(unc.wsl_path, "/home/developer/project/CNV_polidy_identify");
        assert_eq!(unc.wsl_distribution.as_deref(), Some("Ubuntu"));
        assert_eq!(unc.source, ProjectFolderSource::WslUnc);

        let legacy_unc =
            parse_project_folder_path(r#"\\wsl$\Ubuntu\home\developer\project"#).unwrap();
        assert_eq!(
            legacy_unc.location.path,
            r#"\\wsl$\Ubuntu\home\developer\project"#
        );
        assert_eq!(legacy_unc.wsl_path, "/home/developer/project");

        for input in [
            r#"home\developer\project\CNV_polidy_identify"#,
            "home/developer/project/CNV_polidy_identify",
            "/home/developer/project/CNV_polidy_identify",
        ] {
            let fallback = parse_project_folder_path(input).unwrap();
            assert_eq!(
                fallback.location.path,
                "/home/developer/project/CNV_polidy_identify"
            );
            assert_eq!(fallback.wsl_path, fallback.location.path);
            assert_eq!(fallback.source, ProjectFolderSource::Wsl);
        }
    }

    #[test]
    fn wsl_home_paths_are_resolved_before_they_are_cached() {
        let resolved =
            parse_project_folder_path_with_wsl_home(r#"  ~/project/win_edge/./download  "#, || {
                Ok("/home/developer".into())
            })
            .unwrap();

        assert_eq!(resolved.location.name, "download");
        assert_eq!(
            resolved.location.path,
            "/home/developer/project/win_edge/download"
        );
        assert_eq!(resolved.wsl_path, resolved.location.path);
        assert_eq!(resolved.source, ProjectFolderSource::Wsl);

        let home =
            parse_project_folder_path_with_wsl_home("~", || Ok("/home/中文 用户".into())).unwrap();
        assert_eq!(home.location.path, "/home/中文 用户");
        assert_eq!(home.location.name, "中文 用户");

        let legacy =
            parse_project_folder_path_with_wsl_home("/~/project/win_edge/download", || {
                Ok("/home/developer".into())
            })
            .unwrap();
        assert_eq!(legacy.wsl_path, "/home/developer/project/win_edge/download");

        assert!(parse_project_folder_path("~/project").is_err());
        assert!(parse_project_folder_path_with_wsl_home("~/../etc", || {
            panic!("an invalid relative path must not invoke WSL")
        })
        .is_err());
        assert!(
            parse_project_folder_path_with_wsl_home("~other/project", || {
                panic!("unsupported home syntax must not invoke WSL")
            })
            .is_err()
        );
    }

    #[test]
    fn project_folder_paths_reject_ambiguous_or_unsafe_input() {
        for invalid in [
            "",
            r#"C:workspace"#,
            r#"1:\workspace"#,
            r#"D:\..\workspace"#,
            r#"D:\bad?name"#,
            r#"\\server"#,
            r#"\\server\share\..\workspace"#,
            "/../../home/developer",
            "D:\\bad\nname",
        ] {
            assert!(
                parse_project_folder_path(invalid).is_err(),
                "unexpectedly accepted: {invalid:?}"
            );
        }
        assert!(parse_project_folder_path(&"a".repeat(1025)).is_err());
    }

    #[test]
    fn adding_a_project_only_parses_the_path() {
        let unc = parse_project_folder(
            r#"\\wsl.localhost\Ubuntu\definitely-missing\project"#.to_string(),
        )
        .unwrap();
        assert_eq!(
            unc.path,
            r#"\\wsl.localhost\Ubuntu\definitely-missing\project"#
        );
        assert_eq!(unc.wsl_path, "/definitely-missing/project");
        assert_eq!(unc.wsl_distribution.as_deref(), Some("Ubuntu"));

        let drive = parse_project_folder(r#"Z:\definitely-missing\project"#.to_string()).unwrap();
        assert_eq!(drive.path, r#"Z:\definitely-missing\project"#);
        assert_eq!(drive.wsl_path, "/mnt/z/definitely-missing/project");
    }

    #[test]
    fn onecommander_candidates_cover_machine_user_and_path_installs() {
        let configured = PathBuf::from(r"D:\Tools\OneCommander\OneCommander.exe");
        let program_files = PathBuf::from(r"C:\Program Files");
        let local_app_data = PathBuf::from(r"C:\Users\tester\AppData\Local");
        let candidates = onecommander_candidate_paths(
            Some(&configured),
            &[program_files.clone(), program_files.clone()],
            Some(&local_app_data),
        );

        assert_eq!(candidates[0], configured);
        assert!(candidates.contains(&program_files.join("OneCommander").join("OneCommander.exe")));
        assert!(candidates.contains(
            &local_app_data
                .join("Programs")
                .join("OneCommander")
                .join("OneCommander.exe")
        ));
        assert_eq!(candidates.last().unwrap(), Path::new("OneCommander.exe"));
        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| {
                    **candidate == program_files.join("OneCommander").join("OneCommander.exe")
                })
                .count(),
            1
        );
    }

    #[test]
    fn onecommander_receives_the_project_path_as_one_argument() {
        let executable = Path::new(r"C:\Program Files\OneCommander\OneCommander.exe");
        let project_path = r"\\wsl.localhost\Ubuntu\home\developer\中文 项目";
        let command = onecommander_command(executable, project_path);
        let arguments: Vec<_> = command.get_args().collect();

        assert_eq!(command.get_program(), executable.as_os_str());
        assert_eq!(arguments.len(), 1);
        assert_eq!(arguments[0], project_path);
    }

    #[test]
    fn onecommander_project_paths_use_windows_paths_and_convert_wsl_paths() {
        let windows_path =
            onecommander_project_path(r"D:\Workspace\中文 项目", None, |_, _| {
                panic!("Windows paths must not invoke WSL")
            })
            .unwrap();
        assert_eq!(windows_path, r"D:\Workspace\中文 项目");

        let wsl_path = onecommander_project_path(
            r"home\developer\project\中文 项目",
            Some("Ubuntu"),
            |path, distribution| {
                assert_eq!(path, "/home/developer/project/中文 项目");
                assert_eq!(distribution, Some("Ubuntu"));
                Ok(r"\\wsl.localhost\Ubuntu\home\developer\project\中文 项目".to_string())
            },
        )
        .unwrap();
        assert_eq!(
            wsl_path,
            r"\\wsl.localhost\Ubuntu\home\developer\project\中文 项目"
        );

        assert!(
            onecommander_project_path("/home/developer", Some("Ubuntu?"), |_, _| {
                panic!("an invalid distribution must not be passed to WSL")
            })
            .is_err()
        );
        assert!(onecommander_project_path("/home/developer", None, |_, _| {
            Ok("/still/a/wsl/path".to_string())
        })
        .is_err());
    }

    #[test]
    fn project_shell_cache_only_accepts_canonical_launch_targets() {
        let target =
            project_shell_target_from_cache("/home/developer/中文 项目", Some("Ubuntu-24.04"))
                .unwrap();
        assert_eq!(target.wsl_path, "/home/developer/中文 项目");
        assert_eq!(target.wsl_distribution.as_deref(), Some("Ubuntu-24.04"));
        assert!(project_shell_target_from_cache("/", None).is_ok());
        assert!(project_shell_target_from_cache("/~/project/win_edge/download", None).is_err());

        for invalid_path in [
            "home/developer/project",
            "/home/../etc",
            "/home/./project",
            "/home//project",
            "/home/project/",
            "/home\\project",
            "/home/\nproject",
        ] {
            assert!(
                project_shell_target_from_cache(invalid_path, None).is_err(),
                "unexpectedly accepted cached path: {invalid_path:?}"
            );
        }
        assert!(project_shell_target_from_cache(&format!("/{}", "a".repeat(1024)), None).is_err());

        for invalid_distribution in [
            "",
            " Ubuntu",
            "Ubuntu ",
            "Ubuntu/bad",
            "Ubuntu\\bad",
            "Ubuntu?",
        ] {
            assert!(
                project_shell_target_from_cache("/home/developer", Some(invalid_distribution))
                    .is_err(),
                "unexpectedly accepted cached distribution: {invalid_distribution:?}"
            );
        }
    }

    #[test]
    fn terminal_help_matches_the_platform_shell() {
        let help = terminal_help_text();

        #[cfg(target_os = "windows")]
        {
            assert!(help.contains("WSL"));
            assert!(help.contains("pwd"));
            assert!(!help.contains("20 秒"));
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert!(help.contains("pwd"));
            assert!(help.contains("20 秒"));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_project_folder_expands_the_default_wsl_home() {
        let home = current_wsl_home_directory().unwrap();
        let resolved =
            parse_project_folder_for_current_platform("~/project/win_edge/download").unwrap();

        assert_eq!(
            resolved.wsl_path,
            format!("{}/project/win_edge/download", home.trim_end_matches('/'))
        );
        assert!(!resolved.wsl_path.contains('~'));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_wsl_terminal_command_preserves_utf8_output() {
        let (text, exit_code, success) =
            run_terminal_command("printf '中文输出正常\\n'", &terminal_working_directory());

        assert!(success, "WSL command failed: {text}");
        assert_eq!(exit_code, Some(0));
        assert!(text.contains("中文输出正常"), "unexpected output: {text}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_pty_uses_the_unc_distribution_and_passes_cwd_as_one_argument() {
        let mut candidates = pty_shell_candidates();

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].0, "WSL");
        assert_eq!(candidates[0].1.get_argv()[0].to_string_lossy(), "wsl.exe");

        let target =
            project_shell_target_from_cache("/home/developer/中文 项目", Some("Ubuntu")).unwrap();
        configure_pty_command(&mut candidates[0].1, Some(&target));
        let arguments = candidates[0].1.get_argv();
        assert_eq!(arguments[1].to_string_lossy(), "--distribution");
        assert_eq!(arguments[2].to_string_lossy(), "Ubuntu");
        assert_eq!(arguments[3].to_string_lossy(), "--cd");
        assert_eq!(arguments[4].to_string_lossy(), "/home/developer/中文 项目");
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

    #[test]
    fn project_store_roundtrips_through_json() {
        let store = ProjectStoreFile {
            directories: vec![ProjectDirectoryRecord {
                id: "dir-1".into(),
                name: "项目文件夹".into(),
            }],
            folders: vec![ProjectFolderRecord {
                id: "p-1".into(),
                directory_id: "dir-1".into(),
                name: "demo".into(),
                path: "\\\\wsl.localhost\\Ubuntu\\home\\beluga\\demo".into(),
                wsl_path: Some("/home/beluga/demo".into()),
                wsl_distribution: Some("Ubuntu".into()),
            }],
        };
        let json = serde_json::to_string(&store).unwrap();
        assert!(json.contains("\"directoryId\""));
        assert!(json.contains("\"wslPath\""));
        assert!(json.contains("\"wslDistribution\""));
        let parsed: ProjectStoreFile = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, store);
    }

    #[test]
    fn project_store_tolerates_missing_optional_fields() {
        let parsed: ProjectStoreFile = serde_json::from_str(
            r#"{"directories":[{"id":"d","name":"目录"}],"folders":[{"id":"f","directoryId":"d","name":"p","path":"C:\\work"}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.folders.len(), 1);
        assert_eq!(parsed.folders[0].wsl_path, None);
        assert_eq!(parsed.folders[0].wsl_distribution, None);
        let serialized = serde_json::to_string(&parsed).unwrap();
        assert!(!serialized.contains("wslPath"));
        assert!(!serialized.contains("wslDistribution"));
        let empty: ProjectStoreFile = serde_json::from_str("{}").unwrap();
        assert!(empty.directories.is_empty());
        assert!(empty.folders.is_empty());
    }
}
