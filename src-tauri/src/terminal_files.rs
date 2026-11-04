//! 终端文件/图片命令：OSC1337 图片落盘、悬浮预览读取、保存、系统默认程序打开任意文件。



use std::io::Write;

pub(crate) fn sanitize_terminal_image_name(file_name: &str) -> String {
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

pub(crate) fn is_terminal_image_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

/** 校验前端传入的文件路径：绝对路径、无控制字符、无 .. （不限扩展名，任意文件） */

pub(crate) fn validated_terminal_file_path(path: &str) -> Result<&str, String> {
    let absolute = path.starts_with('/')
        || path.starts_with('\\')
        || (path.len() >= 2
            && path.as_bytes()[1] == b':'
            && path.as_bytes()[0].is_ascii_alphabetic());
    if !absolute || path.len() > 1024 || path.chars().any(|c| c.is_control()) {
        return Err(format!("文件路径不合法：{path}"));
    }
    if path.split(['/', '\\']).any(|component| component == "..") {
        return Err(format!("文件路径不合法：{path}"));
    }
    Ok(path)
}

/** 校验前端传入的图片路径：绝对路径、无控制字符、无 .. 、图片扩展名 */

pub(crate) fn validated_terminal_image_path(path: &str) -> Result<&str, String> {
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

/** WSL POSIX 路径映射到 Windows UNC（默认发行版 Ubuntu），Windows 路径原样返回；
 * 名字带 image 但逻辑通用，任意终端文件路径均可复用 */

#[cfg(target_os = "windows")]
pub(crate) fn resolve_terminal_image_path(path: &str) -> Result<std::path::PathBuf, String> {
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
pub(crate) fn resolve_terminal_image_path(path: &str) -> Result<std::path::PathBuf, String> {
    if path.starts_with('/') {
        Ok(std::path::PathBuf::from(path))
    } else {
        Err(format!("不支持的图片路径：{path}"))
    }
}

pub(crate) fn sniff_image_mime(bytes: &[u8]) -> &'static str {
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

pub(crate) fn base64_encode(data: &[u8]) -> String {
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

/// 用系统默认程序打开终端里输出的任意文件路径（WSL 路径自动映射到 UNC；
/// explorer 退出码恒非零，spawn 成功即视为已派发）。
#[tauri::command(async)]
pub(crate) fn open_terminal_file(path: String) -> Result<String, String> {
    let clean = validated_terminal_file_path(&path)?;
    let host_path = resolve_terminal_image_path(clean)?;
    if !host_path.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    #[cfg(target_os = "windows")]
    {
        // open-with.json 的 openFileWith 节优先：按扩展名指定打开器；未配置走系统默认
        match crate::projects::open_file_with_configured_opener(&host_path.to_string_lossy()) {
            Ok(true) => return Ok(host_path.to_string_lossy().replace('\\', "/")),
            Err(error) => return Err(error),
            Ok(false) => {}
        }
        let spawn = std::process::Command::new("explorer.exe").arg(&host_path).spawn();
        spawn.map_err(|e| format!("打开失败：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let spawn = std::process::Command::new("xdg-open").arg(&host_path).spawn();
        spawn.map_err(|e| format!("打开失败：{e}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    let spawn = std::process::Command::new("xdg-open").arg(&host_path).spawn();
    Ok(host_path.to_string_lossy().replace('\\', "/"))
}

/// 读取终端图片文件（/tmp/... 映射到 \\wsl.localhost），返回 data: URL 供前端悬浮预览。
#[tauri::command(async)]
pub(crate) fn read_terminal_image(path: String) -> Result<String, String> {
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

/// 悬浮预览缓存失效判定用：返回终端图片文件的修改时间与大小（不读文件内容）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalImageStat {
    mtime_ms: i64,
    size: u64,
}

#[tauri::command(async)]
pub(crate) fn stat_terminal_image(path: String) -> Result<TerminalImageStat, String> {
    let path = validated_terminal_image_path(&path)?;
    let host_path = resolve_terminal_image_path(path)?;
    let meta =
        std::fs::metadata(&host_path).map_err(|e| format!("读取图片信息失败：{e}"))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(0))
        .unwrap_or(0);
    Ok(TerminalImageStat { mtime_ms, size: meta.len() })
}

pub(crate) fn export_terminal_image_dir() -> std::path::PathBuf {
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
pub(crate) fn export_terminal_image(path: String) -> Result<String, String> {
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
pub(crate) fn save_terminal_image(bytes: Vec<u8>, file_name: String) -> Result<String, String> {
    
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
