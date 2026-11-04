//! 项目文件夹路径解析（Windows 盘符/UNC/WSL）、打开器（open-with.json/OneCommander）、便携 project-folders.json 存取与变更监听。

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::Emitter;
use crate::types::*;


#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedProjectFolder {
    pub(crate) location: ProjectFolderLocation,
    pub(crate) wsl_path: String,
    pub(crate) wsl_distribution: Option<String>,
    pub(crate) windows_path: Option<String>,
    pub(crate) source: ProjectFolderSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProjectFolderSource {
    WindowsDrive,
    WindowsUnc,
    WslUnc,
    Wsl,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProjectShellTarget {
    pub(crate) wsl_path: String,
    pub(crate) wsl_distribution: Option<String>,
}

pub(crate) fn windows_component_is_valid(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        })
        && !component.ends_with('.')
        && !component.ends_with(' ')
}

pub(crate) fn normalize_project_components(input: &str, windows_rules: bool) -> Result<Vec<String>, String> {
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

pub(crate) fn parse_windows_drive_path(input: &str) -> Option<Result<ResolvedProjectFolder, String>> {
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

pub(crate) fn parse_windows_unc_path(input: &str) -> Result<ResolvedProjectFolder, String> {
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

pub(crate) fn parse_wsl_path(input: &str) -> Result<ResolvedProjectFolder, String> {
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

pub(crate) fn wsl_home_relative_path(input: &str) -> Option<Result<Vec<String>, String>> {
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

pub(crate) fn validated_project_folder_input(input: &str) -> Result<&str, String> {
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

pub(crate) fn parse_project_folder_path_with_wsl_home<F>(
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

pub(crate) fn parse_project_folder_path(input: &str) -> Result<ResolvedProjectFolder, String> {
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

pub(crate) fn project_shell_target_from_cache(
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

pub(crate) fn project_shell_target(resolved: &ResolvedProjectFolder) -> ProjectShellTarget {
    ProjectShellTarget {
        wsl_path: resolved.wsl_path.clone(),
        wsl_distribution: resolved.wsl_distribution.clone(),
    }
}

pub(crate) fn project_folder_resolution(resolved: ResolvedProjectFolder) -> ProjectFolderResolution {
    ProjectFolderResolution {
        name: resolved.location.name,
        path: resolved.location.path,
        wsl_path: resolved.wsl_path,
        wsl_distribution: resolved.wsl_distribution,
    }
}

// ============================================================
// 文件夹打开器配置（open-with.json，exe 同目录，便携迁移）
// ============================================================

pub(crate) const FOLDER_OPENER_CONFIG_FILE: &str = "open-with.json";

/// `open-with.json` 的 `openFolderWith` 节；文件缺失/损坏/缺节时静默回落 OneCommander
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderOpener {
    /// 打开器 exe 路径；相对路径相对本 exe 所在目录解析（便携迁移）
    exe: String,
    /// 参数模板，`{path}` 占位符替换为项目 Windows 路径；缺省为 ["{path}"]
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderOpenerConfig {
    #[serde(default)]
    open_folder_with: Option<FolderOpener>,
    /// 终端点击文件路径的指定打开器：键为小写扩展名（如 ".md"）或 "default"，
    /// 值与 openFolderWith 同构；未命中/未配置回落系统默认关联程序
    #[serde(default)]
    open_file_with: Option<std::collections::HashMap<String, FolderOpener>>,
}

pub(crate) fn folder_opener_config_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent().map(|dir| dir.join(FOLDER_OPENER_CONFIG_FILE))
}

/// 读 exe 同目录 open-with.json；任何失败（缺文件/坏 JSON/缺节）都返回 None → 走 OneCommander
pub(crate) fn load_folder_opener() -> Option<FolderOpener> {
    let path = folder_opener_config_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let config: FolderOpenerConfig = serde_json::from_str(raw.trim_start_matches('\u{FEFF}')).ok()?;
    config.open_folder_with
}

/// 按文件扩展名找 openFileWith 配置的打开器：先精确匹配 ".md" 等小写扩展名键，
/// 无则查 "default" 键；都没有返回 None（调用方回落系统默认关联程序）。
fn load_file_opener(extension: &str) -> Option<FolderOpener> {
    let path = folder_opener_config_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let config: FolderOpenerConfig = serde_json::from_str(raw.trim_start_matches('\u{FEFF}')).ok()?;
    let table = config.open_file_with?;
    if !extension.is_empty() {
        if let Some(opener) = table.get(&extension.to_ascii_lowercase()) {
            return Some(opener.clone());
        }
    }
    table.get("default").cloned()
}

/// 用 openFileWith 配置打开终端文件；返回 Ok(false)=无配置（调用方走系统默认），
/// Err=配置存在但启动失败（用户显式写的配置，失败必须报错可见）。
#[cfg(target_os = "windows")]
pub(crate) fn open_file_with_configured_opener(host_path: &str) -> Result<bool, String> {
    let extension = std::path::Path::new(host_path)
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    match load_file_opener(&extension) {
        Some(opener) => {
            launch_folder_opener(&opener, host_path)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 用配置的打开器启动项目文件夹；配置是用户显式写的，失败必须报错可见
#[cfg(target_os = "windows")]
pub(crate) fn launch_folder_opener(opener: &FolderOpener, project_path: &str) -> Result<(), String> {
    let base = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    let exe_path = Path::new(&opener.exe);
    let resolved = if exe_path.is_absolute() {
        exe_path.to_path_buf()
    } else {
        match base {
            Some(dir) => dir.join(exe_path),
            None => exe_path.to_path_buf(),
        }
    };
    if !resolved.is_file() {
        return Err(format!(
            "open-with.json 配置的打开器不存在：{}（解析为 {}）",
            opener.exe,
            resolved.display()
        ));
    }
    let args: Vec<String> = if opener.args.is_empty() {
        vec![project_path.to_string()]
    } else {
        opener
            .args
            .iter()
            .map(|arg| arg.replace("{path}", project_path))
            .collect()
    };
    let mut command = Command::new(&resolved);
    command.args(&args);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动 {}：{error}", resolved.display()))
}

pub(crate) fn onecommander_candidate_paths(
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

pub(crate) fn onecommander_command(executable: &Path, project_path: &str) -> Command {
    let mut command = Command::new(executable);
    command.arg(project_path);
    command
}

pub(crate) fn onecommander_project_path<F>(
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
pub(crate) fn installed_onecommander_candidates() -> Vec<PathBuf> {
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
pub(crate) fn launch_onecommander(project_path: &str) -> Result<(), String> {
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
pub(crate) fn wsl_command(distribution: Option<&str>) -> Command {
    let mut command = Command::new("wsl.exe");
    if let Some(distribution) = distribution {
        command.args(["--distribution", distribution]);
    }
    command
}

#[cfg(target_os = "windows")]
pub(crate) fn wsl_command_text(mut command: Command) -> Result<String, String> {
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
pub(crate) fn windows_path_to_wsl(path: &str) -> Result<String, String> {
    let mut command = wsl_command(None);
    command.args(["--cd", path, "--exec", "pwd"]);
    wsl_command_text(command)
}

#[cfg(target_os = "windows")]
pub(crate) fn current_wsl_home_directory() -> Result<String, String> {
    let mut command = wsl_command(None);
    command.args(["--exec", "/bin/sh", "-lc", r#"printf '%s\n' "$HOME""#]);
    wsl_command_text(command).map_err(|error| format!("无法解析 WSL 用户主目录：{error}"))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn current_wsl_home_directory() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "无法解析当前用户主目录：未设置 HOME".into())
}

pub(crate) fn parse_project_folder_for_current_platform(input: &str) -> Result<ResolvedProjectFolder, String> {
    parse_project_folder_path_with_wsl_home(input, current_wsl_home_directory)
}

pub(crate) fn legacy_wsl_home_cache_path(path: &str) -> bool {
    path == "/~" || path.starts_with("/~/")
}

#[cfg(target_os = "windows")]
pub(crate) fn wsl_path_to_windows(path: &str, distribution: Option<&str>) -> Result<String, String> {
    let mut command = wsl_command(distribution);
    command.args(["--cd", path, "--exec", "wslpath", "-w", "."]);
    wsl_command_text(command)
}

pub(crate) fn resolve_project_folder_path(input: &str) -> Result<ResolvedProjectFolder, String> {
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

#[tauri::command]
pub(crate) fn parse_project_folder(path: String) -> Result<ProjectFolderResolution, String> {
    parse_project_folder_for_current_platform(&path).map(project_folder_resolution)
}

pub(crate) const PROJECT_STORE_FILE_NAME: &str = "project-folders.json";

pub(crate) const PROJECT_STORE_POLL_INTERVAL_MS: u64 = 1_500;

pub(crate) const PROJECT_STORE_CHANGED_EVENT: &str = "project-store-changed";

pub(crate) fn project_store_file_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法定位可执行文件：{error}"))?;
    let directory = exe
        .parent()
        .ok_or_else(|| "无法定位可执行文件所在目录".to_string())?;
    Ok(directory.join(PROJECT_STORE_FILE_NAME))
}

pub(crate) fn project_store_signature(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

#[tauri::command]
pub(crate) fn project_store_path() -> Result<String, String> {
    project_store_file_path().map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub(crate) fn read_project_store() -> Result<Option<ProjectStoreFile>, String> {
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
pub(crate) fn write_project_store(store: ProjectStoreFile) -> Result<(), String> {
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
pub(crate) fn open_project_store_file() -> Result<(), String> {
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

pub(crate) fn spawn_project_store_watcher(app: tauri::AppHandle) {
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
pub(crate) fn open_project_folder_in_onecommander(
    path: String,
    wsl_distribution: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let project_path =
            onecommander_project_path(&path, wsl_distribution.as_deref(), wsl_path_to_windows)?;
        // open-with.json 配置的打开器优先（exe 同目录便携配置）；未配置时回落 OneCommander
        if let Some(opener) = load_folder_opener() {
            return launch_folder_opener(&opener, &project_path);
        }
        return launch_onecommander(&project_path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, wsl_distribution);
        Err("只能在 Windows 版应用中使用 OneCommander 打开项目文件夹".into())
    }
}
