//! 聊天状态核心 ChatStore：演示会话、消息收发、模拟回复、联系人/在线状态命令。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use crate::terminal_exec::*;
use crate::types::*;


#[derive(Debug)]
pub(crate) struct ChatStore {
    pub(crate) current_user: Contact,
    pub(crate) contacts: Vec<Contact>,
    pub(crate) messages: Vec<Message>,
    pub(crate) active_contact_id: String,
    pub(crate) next_message_id: u64,
}

impl ChatStore {
    pub(crate) fn demo() -> Self {
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

    pub(crate) fn snapshot(&self) -> AppSnapshot {
        AppSnapshot {
            current_user: self.current_user.clone(),
            contacts: self.contacts.clone(),
            messages: self.messages.clone(),
            active_contact_id: self.active_contact_id.clone(),
        }
    }

    pub(crate) fn conversation(&self, contact_id: &str) -> Result<Vec<Message>, String> {
        self.contact(contact_id)?;
        Ok(self
            .messages
            .iter()
            .filter(|message| message.contact_id == contact_id)
            .cloned()
            .collect())
    }

    pub(crate) fn create_terminal_contact(&mut self) -> Contact {
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

    pub(crate) fn rename_terminal_contact(
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

    pub(crate) fn send_message(&mut self, contact_id: &str, text: &str) -> Result<Message, String> {
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

    pub(crate) fn execute_terminal(&mut self, input: &str) -> Result<TerminalExecution, String> {
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

    pub(crate) fn generate_reply(&mut self, contact_id: &str) -> Result<Message, String> {
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

    pub(crate) fn mark_read(&mut self, contact_id: &str) -> Result<Contact, String> {
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

    pub(crate) fn set_presence(&mut self, presence: &str) -> Result<Contact, String> {
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

    pub(crate) fn contact(&self, contact_id: &str) -> Result<&Contact, String> {
        self.contacts
            .iter()
            .find(|contact| contact.id == contact_id)
            .ok_or_else(|| format!("找不到联系人：{contact_id}"))
    }

    pub(crate) fn take_message_id(&mut self) -> u64 {
        let id = self.next_message_id;
        self.next_message_id = self.next_message_id.saturating_add(1);
        id
    }

    pub(crate) fn refresh_contact_summary(&mut self, contact_id: &str) {
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

pub(crate) fn demo_message(
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

pub(crate) fn normalize_message(input: &str) -> Result<String, String> {
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

pub(crate) fn is_terminal_contact_id(contact_id: &str) -> bool {
    contact_id == TERMINAL_ID
        || contact_id
            .strip_prefix("terminal-")
            .map(|suffix| {
                !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
            })
            .unwrap_or(false)
}

pub(crate) fn normalize_terminal_name(input: &str) -> Result<String, String> {
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

pub(crate) fn contextual_reply(contact: &Contact, context: &str) -> String {
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

pub(crate) fn contains_any(text: &str, candidates: &[&str]) -> bool {
    candidates.iter().any(|candidate| text.contains(candidate))
}

pub(crate) fn stable_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

pub(crate) type ManagedChatState = Mutex<ChatStore>;

/** 终端图片文件名清洗：仅保留字母数字与 . _ -，去掉首尾点，防路径注入 */

#[tauri::command]
pub(crate) fn bootstrap(state: State<'_, ManagedChatState>) -> Result<AppSnapshot, String> {
    let store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    Ok(store.snapshot())
}

#[tauri::command]
pub(crate) fn get_conversation(
    contact_id: String,
    state: State<'_, ManagedChatState>,
) -> Result<Vec<Message>, String> {
    let store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.conversation(&contact_id)
}

#[tauri::command]
pub(crate) fn send_message(
    contact_id: String,
    text: String,
    state: State<'_, ManagedChatState>,
) -> Result<Message, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.send_message(&contact_id, &text)
}

#[tauri::command]
pub(crate) fn generate_reply(
    contact_id: String,
    state: State<'_, ManagedChatState>,
) -> Result<Message, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.generate_reply(&contact_id)
}

#[tauri::command]
pub(crate) fn create_terminal_contact(state: State<'_, ManagedChatState>) -> Result<Contact, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    Ok(store.create_terminal_contact())
}

#[tauri::command]
pub(crate) fn rename_terminal_contact(
    contact_id: String,
    display_name: String,
    state: State<'_, ManagedChatState>,
) -> Result<Contact, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.rename_terminal_contact(&contact_id, &display_name)
}

#[tauri::command]
pub(crate) fn execute_terminal(
    command: String,
    state: State<'_, ManagedChatState>,
) -> Result<TerminalExecution, String> {
    let mut store = state.lock().map_err(|_| "终端状态暂时不可用".to_string())?;
    store.execute_terminal(&command)
}

#[tauri::command]
pub(crate) fn mark_read(contact_id: String, state: State<'_, ManagedChatState>) -> Result<Contact, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.mark_read(&contact_id)
}

#[tauri::command]
pub(crate) fn set_presence(presence: String, state: State<'_, ManagedChatState>) -> Result<Contact, String> {
    let mut store = state.lock().map_err(|_| "聊天状态暂时不可用".to_string())?;
    store.set_presence(&presence)
}
