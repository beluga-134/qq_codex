//! 对外序列化数据类型（联系人/消息快照、项目文件夹、PTY 结果）与全局常量。

use serde::{Deserialize, Serialize};



pub(crate) const SELF_ID: &str = "me";

pub(crate) const TERMINAL_ID: &str = "terminal";

pub(crate) const MAX_MESSAGE_CHARS: usize = 2_000;

pub(crate) const MAX_TERMINAL_OUTPUT_CHARS: usize = 12_000;

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
