//! 便签数据：按联系人分键的纯文本便签，便携存于 exe 同目录 notes.json
//! （与 project-folders.json 同级；拷贝 exe + json 即可带走全部便签）。

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

const NOTES_FILE_NAME: &str = "notes.json";

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum NotesValue {
    Map(HashMap<String, String>),
    Invalid,
}

fn notes_file_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法定位可执行文件：{error}"))?;
    let directory = exe
        .parent()
        .ok_or_else(|| "无法定位可执行文件所在目录".to_string())?;
    Ok(directory.join(NOTES_FILE_NAME))
}

/// 读取全部便签（联系人 id → 便签文本）。文件缺失/损坏返回空表（静默降级）。
#[tauri::command]
pub(crate) fn read_notes() -> Result<HashMap<String, String>, String> {
    let path = notes_file_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(format!("无法读取便签文件：{error}")),
    };
    match serde_json::from_str::<NotesValue>(&text) {
        Ok(NotesValue::Map(map)) => Ok(map),
        _ => Ok(HashMap::new()),
    }
}

/// 全量写回便签（原子替换：先写 .tmp 再 rename，断电不产生半截文件）。
#[tauri::command]
pub(crate) fn write_notes(notes: HashMap<String, String>) -> Result<(), String> {
    let path = notes_file_path()?;
    let mut json = serde_json::to_string_pretty(&notes)
        .map_err(|error| format!("无法序列化便签数据：{error}"))?;
    json.push('\n');
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, json).map_err(|error| format!("无法写入便签文件：{error}"))?;
    std::fs::rename(&temp_path, &path).map_err(|error| format!("无法更新便签文件：{error}"))?;
    Ok(())
}
