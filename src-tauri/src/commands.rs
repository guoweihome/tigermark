use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, Theme, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub const SITE_URL: &str = "https://www.pytiger.com/";

const MARKDOWN_EXTS: &[&str] = &[".md", ".markdown", ".mdown", ".mkd", ".txt"];
const HIDDEN_DIRS: &[&str] = &["assets", "node_modules", ".git"];

pub struct CloseState {
    pub allow_close: AtomicBool,
}

impl Default for CloseState {
    fn default() -> Self {
        Self {
            allow_close: AtomicBool::new(false),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResult<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    name: String,
    path: String,
    is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileNode>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    absolute_path: String,
    relative_path: String,
}

fn ok<T: Serialize>(data: T) -> ApiResult<T> {
    ApiResult {
        ok: true,
        data: Some(data),
        error: None,
    }
}

fn fail<T: Serialize>(error: impl ToString) -> ApiResult<T> {
    ApiResult {
        ok: false,
        data: None,
        error: Some(error.to_string()),
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn is_hidden_dir(name: &str) -> bool {
    HIDDEN_DIRS
        .iter()
        .any(|dir| name.eq_ignore_ascii_case(dir))
}

fn is_markdown_file(name: &str) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default();
    if ext.is_empty() {
        return name.to_ascii_lowercase().ends_with(".md");
    }
    MARKDOWN_EXTS.contains(&ext.as_str())
}

fn read_directory_tree(dir_path: &Path, depth: u8) -> Result<Vec<FileNode>, String> {
    if depth > 8 {
        return Ok(Vec::new());
    }

    let mut nodes = Vec::new();
    let entries = fs::read_dir(dir_path).map_err(|err| err.to_string())?;

    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        let full_path = entry.path();
        if file_type.is_dir() {
            if is_hidden_dir(&name) {
                continue;
            }
            let children = read_directory_tree(&full_path, depth + 1)?;
            nodes.push(FileNode {
                name,
                path: path_string(&full_path),
                is_directory: true,
                children: Some(children),
            });
        } else if is_markdown_file(&name) {
            nodes.push(FileNode {
                name,
                path: path_string(&full_path),
                is_directory: false,
                children: None,
            });
        }
    }

    nodes.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(nodes)
}

fn mime_to_ext(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/svg+xml" => ".svg",
        _ => ".png",
    }
}

fn paste_image_name(mime_type: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let rand = now.subsec_nanos() % 36u32.pow(4);
    format!(
        "paste-{}-{:04x}{}",
        secs,
        rand,
        mime_to_ext(mime_type)
    )
}

#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "macos") {
        "darwin".into()
    } else if cfg!(target_os = "windows") {
        "win32".into()
    } else {
        "linux".into()
    }
}

#[tauri::command]
pub async fn dialog_open_directory(app: AppHandle) -> ApiResult<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择工作目录")
            .blocking_pick_folder()
    })
    .await;

    match picked {
        Ok(Some(folder)) => match folder.into_path() {
            Ok(path) => ok(Some(path_string(&path))),
            Err(err) => fail(err),
        },
        Ok(None) => ok(None),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub async fn fs_read_directory(dir_path: String) -> ApiResult<Vec<FileNode>> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        read_directory_tree(Path::new(&dir_path), 0)
    })
    .await;
    match result {
        Ok(Ok(tree)) => ok(tree),
        Ok(Err(err)) => fail(err),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub async fn fs_read_file(file_path: String) -> ApiResult<String> {
    let result = tauri::async_runtime::spawn_blocking(move || fs::read_to_string(file_path)).await;
    match result {
        Ok(Ok(content)) => ok(content),
        Ok(Err(err)) => fail(err),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub async fn fs_write_file(file_path: String, content: String) -> ApiResult<()> {
    let result = tauri::async_runtime::spawn_blocking(move || fs::write(file_path, content)).await;
    match result {
        Ok(Ok(())) => ok(()),
        Ok(Err(err)) => fail(err),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub async fn fs_create_file(dir_path: String, name: String) -> ApiResult<String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let file_name = if name.to_ascii_lowercase().ends_with(".md") {
            name
        } else {
            format!("{name}.md")
        };
        let file_path = Path::new(&dir_path).join(&file_name);
        let stem = file_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("untitled");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)?;
        write!(file, "# {stem}\n\n")?;
        Ok::<_, std::io::Error>(path_string(&file_path))
    })
    .await;
    match result {
        Ok(Ok(path)) => ok(path),
        Ok(Err(err)) => fail(err),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub async fn fs_create_directory(dir_path: String, name: String) -> ApiResult<String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let new_path = Path::new(&dir_path).join(name);
        fs::create_dir(&new_path)?;
        Ok::<_, std::io::Error>(path_string(&new_path))
    })
    .await;
    match result {
        Ok(Ok(path)) => ok(path),
        Ok(Err(err)) => fail(err),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub async fn fs_delete_path(target_path: String) -> ApiResult<()> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(target_path);
        let meta = fs::metadata(&path)?;
        if meta.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        }
    })
    .await;
    match result {
        Ok(Ok(())) => ok(()),
        Ok(Err(err)) => fail(err),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub async fn fs_rename_path(old_path: String, new_name: String) -> ApiResult<String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let old = PathBuf::from(old_path);
        let parent = old.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
        let new_path = parent.join(new_name);
        fs::rename(&old, &new_path)?;
        Ok::<_, std::io::Error>(path_string(&new_path))
    })
    .await;
    match result {
        Ok(Ok(path)) => ok(path),
        Ok(Err(err)) => fail(err),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub async fn fs_save_image(
    md_file_path: String,
    bytes: Vec<u8>,
    mime_type: String,
) -> ApiResult<SavedImage> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let md_path = PathBuf::from(md_file_path);
        let assets_dir = md_path
            .parent()
            .map(|parent| parent.join("assets"))
            .unwrap_or_else(|| PathBuf::from("assets"));
        fs::create_dir_all(&assets_dir)?;
        let file_name = paste_image_name(&mime_type);
        let absolute_path = assets_dir.join(&file_name);
        fs::write(&absolute_path, bytes)?;
        Ok::<_, std::io::Error>(SavedImage {
            absolute_path: path_string(&absolute_path),
            relative_path: format!("assets/{file_name}"),
        })
    })
    .await;
    match result {
        Ok(Ok(saved)) => ok(saved),
        Ok(Err(err)) => fail(err),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub fn shell_show_item_in_folder(app: AppHandle, target_path: String) -> ApiResult<()> {
    if !Path::new(&target_path).exists() {
        return fail("路径不存在");
    }
    match app.opener().reveal_item_in_dir(&target_path) {
        Ok(()) => ok(()),
        Err(err) => fail(err),
    }
}

#[tauri::command]
pub fn theme_set(window: WebviewWindow, theme: String) {
    let next = match theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    let _ = window.set_theme(next);
}

#[tauri::command]
pub fn window_close_allow(app: AppHandle, window: WebviewWindow) {
    app.state::<CloseState>()
        .allow_close
        .store(true, Ordering::SeqCst);
    let _ = window.close();
}

#[tauri::command]
pub fn window_close_deny(app: AppHandle) {
    app.state::<CloseState>()
        .allow_close
        .store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn window_hide(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

pub fn show_about(app: &AppHandle) {
    let version = app.package_info().version.to_string();
    let handle = app.clone();
    app.dialog()
        .message(format!("版本 {version}\n官网 {SITE_URL}"))
        .title("关于 TigerMark")
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            "打开官网".into(),
            "关闭".into(),
        ))
        .show(move |open_site| {
            if open_site {
                let _ = handle.opener().open_url(SITE_URL, None::<&str>);
            }
        });
}

pub fn open_website(app: &AppHandle) {
    let _ = app.opener().open_url(SITE_URL, None::<&str>);
}
