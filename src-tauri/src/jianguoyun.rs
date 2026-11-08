use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const BASE: &str = "https://dav.jianguoyun.com/dav";
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

static BUSY: AtomicBool = AtomicBool::new(false);

struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

fn try_busy() -> Result<BusyGuard, String> {
    if BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("坚果云正在处理另一个请求".into());
    }
    Ok(BusyGuard)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NutstoreStatus {
    pub connected: bool,
    pub enabled: bool,
    pub account: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NutstoreSyncReport {
    pub account: String,
    pub folder: String,
    pub uploaded: u32,
    pub downloaded: u32,
    pub skipped: u32,
    pub unsaved_skipped: bool,
}

#[derive(Serialize, Deserialize)]
struct StoredAccount {
    account: String,
    password: String,
    #[serde(default)]
    enabled: bool,
}

struct LocalFile {
    rel: String,
    path: PathBuf,
    size: u64,
    modified: i64,
}

struct RemoteFile {
    rel: String,
    size: u64,
    modified: i64,
}

#[derive(Default)]
struct DavEntry {
    href: String,
    size: Option<u64>,
    modified: Option<i64>,
    is_dir: bool,
}

enum SyncAction {
    Upload,
    Download,
    Skip,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|err| err.to_string())
}

fn token_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("jianguoyun.json"))
}

fn load_account(app: &AppHandle) -> Result<Option<StoredAccount>, String> {
    let path = token_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&raw).map(Some).map_err(|err| err.to_string())
}

fn save_account(app: &AppHandle, account: &StoredAccount) -> Result<(), String> {
    let path = token_path(app)?;
    let raw = serde_json::to_string(account).map_err(|err| err.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|err| err.to_string())?;
    file.write_all(raw.as_bytes()).map_err(|err| err.to_string())?;
    Ok(())
}

fn clear_account(app: &AppHandle) -> Result<(), String> {
    let path = token_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn status_from(account: Option<StoredAccount>) -> NutstoreStatus {
    match account {
        Some(account) if !account.account.is_empty() && !account.password.is_empty() => {
            NutstoreStatus {
                connected: true,
                enabled: account.enabled,
                account: account.account,
            }
        }
        _ => NutstoreStatus {
            connected: false,
            enabled: false,
            account: String::new(),
        },
    }
}

fn encode_seg(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode_percent(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn decode_xml_text(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn collection_url(path: &str) -> String {
    if path.is_empty() {
        format!("{BASE}/")
    } else {
        format!(
            "{BASE}/{}/",
            path.split('/').map(encode_seg).collect::<Vec<_>>().join("/")
        )
    }
}

fn file_url(path: &str) -> String {
    format!(
        "{BASE}/{}",
        path.split('/').map(encode_seg).collect::<Vec<_>>().join("/")
    )
}

fn remote_folder_name(root: &Path) -> String {
    let raw = root
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "notes".into());
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '"' | '*' | ':' | '<' | '>' | '?' | '\\' | '|' => '_',
            _ => ch,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(|ch: char| ch == '.' || ch == ' ');
    if cleaned.is_empty() {
        "notes".into()
    } else {
        cleaned.to_string()
    }
}

fn should_skip_name(name: &str) -> bool {
    name.starts_with('.')
        || name == "node_modules"
        || name.eq_ignore_ascii_case("thumbs.db")
        || name.eq_ignore_ascii_case("desktop.ini")
}

fn decide(local: Option<(i64, u64)>, remote: Option<(i64, u64)>) -> SyncAction {
    match (local, remote) {
        (Some(_), None) => SyncAction::Upload,
        (None, Some(_)) => SyncAction::Download,
        (Some((local_time, local_size)), Some((remote_time, remote_size))) => {
            if local_size == remote_size && (local_time - remote_time).abs() <= 2 {
                SyncAction::Skip
            } else if local_time > remote_time {
                SyncAction::Upload
            } else if remote_time > local_time {
                SyncAction::Download
            } else if local_size != remote_size {
                SyncAction::Upload
            } else {
                SyncAction::Skip
            }
        }
        (None, None) => SyncAction::Skip,
    }
}

fn days_from_civil(mut year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    year -= i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u32;
    let day_of_year = (153 * (month + if month > 2 { 0 } else { 12 } - 3) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some((era as i64) * 146097 + day_of_era as i64 - 719468)
}

fn month_index(name: &str) -> Option<u32> {
    Some(match name {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    })
}

fn parse_http_date(value: &str) -> Option<i64> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let day: u32 = parts[1].parse().ok()?;
    let month = month_index(parts[2])?;
    let year: i32 = parts[3].parse().ok()?;
    let time: Vec<&str> = parts[4].split(':').collect();
    if time.len() != 3 {
        return None;
    }
    let hour: u32 = time[0].parse().ok()?;
    let minute: u32 = time[1].parse().ok()?;
    let second: u32 = time[2].parse().ok()?;
    let days = days_from_civil(year, month, day)?;
    Some(days * 86400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64)
}

fn parse_multistatus(xml: &str) -> Vec<DavEntry> {
    let mut entries = Vec::new();
    let mut current: Option<DavEntry> = None;
    let mut field = String::new();
    let mut text = String::new();
    let mut index = 0;
    let bytes = xml.as_bytes();
    while index < bytes.len() {
        if bytes[index] != b'<' {
            let rest = &xml[index..];
            let next = rest.find('<').unwrap_or(rest.len());
            text.push_str(&rest[..next]);
            index += next;
            continue;
        }
        if !text.trim().is_empty() {
            let value = decode_xml_text(text.trim());
            if let Some(entry) = current.as_mut() {
                match field.as_str() {
                    "href" => entry.href = value,
                    "getcontentlength" => entry.size = value.parse().ok(),
                    "getlastmodified" => entry.modified = parse_http_date(&value),
                    _ => {}
                }
            }
        }
        text.clear();
        let end = xml[index + 1..]
            .find('>')
            .map(|offset| index + 1 + offset)
            .unwrap_or(xml.len().saturating_sub(1));
        let raw = xml[index + 1..end].trim();
        let closing = raw.starts_with('/');
        let self_close = raw.ends_with('/');
        let name_token = raw
            .trim_start_matches('/')
            .trim_end_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("");
        let name = name_token
            .rsplit([':', '}'])
            .next()
            .unwrap_or(name_token)
            .to_ascii_lowercase();
        if name == "response" && !closing {
            if let Some(entry) = current.take() {
                if !entry.href.is_empty() {
                    entries.push(entry);
                }
            }
            current = Some(DavEntry::default());
            field.clear();
        } else if name == "response" && closing {
            if let Some(entry) = current.take() {
                if !entry.href.is_empty() {
                    entries.push(entry);
                }
            }
            field.clear();
        } else if name == "collection" {
            if let Some(entry) = current.as_mut() {
                entry.is_dir = true;
            }
        } else if !closing && !self_close {
            field = name;
        } else if closing {
            field.clear();
        }
        index = end + 1;
    }
    entries
}

fn href_path(href: &str) -> String {
    let href = href.split('?').next().unwrap_or(href);
    let path = if let Some(index) = href.find("/dav/") {
        &href[index + 5..]
    } else {
        href.trim_start_matches('/')
    };
    decode_percent(path).trim_matches('/').to_string()
}

fn webdav_error(status: u16, body: &str) -> String {
    if status == 401 || status == 403 {
        return "账号或应用密码不正确。请到坚果云的「第三方应用管理」生成应用密码，不要用登录密码。".into();
    }
    let lower = body.to_ascii_lowercase();
    if status == 429 || lower.contains("访问频率") || lower.contains("too many") {
        return "坚果云请求太频繁，请过半小时再同步。".into();
    }
    if body.trim().is_empty() {
        format!("坚果云请求失败（{status}）")
    } else {
        let snippet: String = body.chars().filter(|ch| !ch.is_control()).take(160).collect();
        format!("坚果云请求失败（{status}）：{snippet}")
    }
}

async fn propfind_url(
    client: &reqwest::Client,
    account: &str,
    password: &str,
    url: &str,
    depth: &str,
) -> Result<Vec<DavEntry>, String> {
    let response = client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").map_err(|err| err.to_string())?,
            url,
        )
        .basic_auth(account, Some(password))
        .header("depth", depth)
        .header("content-type", "application/xml; charset=utf-8")
        .body(
            r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>"#,
        )
        .send()
        .await
        .map_err(|err| format!("无法连接坚果云：{err}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if status == 404 {
        return Ok(Vec::new());
    }
    if !(200..300).contains(&status) {
        return Err(webdav_error(status, &body));
    }
    Ok(parse_multistatus(&body))
}

async fn mkcol(
    client: &reqwest::Client,
    account: &str,
    password: &str,
    path: &str,
) -> Result<(), String> {
    let response = client
        .request(
            reqwest::Method::from_bytes(b"MKCOL").map_err(|err| err.to_string())?,
            collection_url(path),
        )
        .basic_auth(account, Some(password))
        .send()
        .await
        .map_err(|err| format!("无法连接坚果云：{err}"))?;
    let status = response.status().as_u16();
    if matches!(status, 200 | 201 | 204 | 301 | 405) {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    Err(webdav_error(status, &body))
}

fn same_path(left: &str, right: &str) -> bool {
    left.replace('\\', "/").trim_end_matches('/') == right.replace('\\', "/").trim_end_matches('/')
}

fn touch(path: &Path, secs: i64) {
    if secs <= 0 {
        return;
    }
    let Ok(file) = File::options().write(true).open(path) else {
        return;
    };
    let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs(secs as u64));
}

fn safe_relative(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.contains('\\')
        || rel.split('/').any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("远程路径不安全".into());
    }
    Ok(PathBuf::from(rel))
}

fn collect_local(dir: &Path, rel: &str, out: &mut Vec<LocalFile>, depth: u8) -> Result<(), String> {
    if depth > 16 {
        return Err("文件夹层级超过 16 层，这次没有继续同步。".into());
    }
    if out.len() > 5000 {
        return Err("文件超过 5000 个，这次没有继续同步。".into());
    }
    let entries = fs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if should_skip_name(&name) {
            continue;
        }
        let path = entry.path();
        let kind = entry.file_type().map_err(|err| err.to_string())?;
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{}", entry.file_name().to_string_lossy())
        };
        if kind.is_dir() {
            collect_local(&path, &child_rel, out, depth + 1)?;
        } else if kind.is_file() {
            let meta = entry.metadata().map_err(|err| err.to_string())?;
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_secs() as i64)
                .unwrap_or(0);
            out.push(LocalFile {
                rel: child_rel,
                path,
                size: meta.len(),
                modified,
            });
        }
    }
    Ok(())
}

async fn list_remote(
    client: &reqwest::Client,
    account: &str,
    password: &str,
    root: &str,
    prefix: &str,
    out: &mut Vec<RemoteFile>,
    depth: u8,
) -> Result<(), String> {
    if depth > 16 {
        return Err("文件夹层级超过 16 层，这次没有继续同步。".into());
    }
    if out.len() > 5000 {
        return Err("文件超过 5000 个，这次没有继续同步。".into());
    }
    let path = if prefix.is_empty() {
        root.to_string()
    } else {
        format!("{root}/{prefix}")
    };
    let entries = propfind_url(client, account, password, &collection_url(&path), "1").await?;
    if entries.len() >= 750 {
        return Err(format!(
            "「{path}」里的条目达到坚果云单次 750 个的上限，这次没有继续同步，避免漏掉文件后又重复上传。"
        ));
    }
    for entry in entries {
        let full = href_path(&entry.href);
        if full == path || full.is_empty() {
            continue;
        }
        let Some(rel) = full.strip_prefix(&format!("{root}/")) else {
            continue;
        };
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if should_skip_name(name) {
            continue;
        }
        if entry.is_dir {
            Box::pin(list_remote(
                client, account, password, root, rel, out, depth + 1,
            ))
            .await?;
        } else if entry.size.unwrap_or(0) <= MAX_FILE_BYTES {
            out.push(RemoteFile {
                rel: rel.to_string(),
                size: entry.size.unwrap_or(0),
                modified: entry.modified.unwrap_or(0),
            });
        }
    }
    Ok(())
}

async fn upload_file(
    client: &reqwest::Client,
    account: &str,
    password: &str,
    remote_path: &str,
    bytes: Vec<u8>,
) -> Result<i64, String> {
    let response = client
        .put(file_url(remote_path))
        .basic_auth(account, Some(password))
        .header("content-type", "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|err| format!("无法连接坚果云：{err}"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(webdav_error(status, &body));
    }
    let listed = propfind_url(client, account, password, &file_url(remote_path), "0").await?;
    Ok(listed
        .into_iter()
        .find(|entry| href_path(&entry.href) == remote_path)
        .and_then(|entry| entry.modified)
        .unwrap_or(0))
}

async fn download_file(
    client: &reqwest::Client,
    account: &str,
    password: &str,
    remote_path: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(file_url(remote_path))
        .basic_auth(account, Some(password))
        .send()
        .await
        .map_err(|err| format!("无法连接坚果云：{err}"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let body = response.text().await.unwrap_or_default();
        return Err(webdav_error(status, &body));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn jianguoyun_status(app: AppHandle) -> Result<NutstoreStatus, String> {
    Ok(status_from(load_account(&app)?))
}

#[tauri::command]
pub async fn jianguoyun_connect(
    app: AppHandle,
    account: String,
    password: String,
) -> Result<NutstoreStatus, String> {
    let _busy = try_busy()?;
    let account = account.trim().to_string();
    let password = password.trim().to_string();
    if account.is_empty() || password.is_empty() {
        return Err("请填写坚果云账号和应用密码".into());
    }
    let client = http_client()?;
    propfind_url(&client, &account, &password, &collection_url(""), "0").await?;
    let stored = StoredAccount {
        account: account.clone(),
        password,
        enabled: false,
    };
    save_account(&app, &stored)?;
    Ok(NutstoreStatus {
        connected: true,
        enabled: false,
        account,
    })
}

#[tauri::command]
pub fn jianguoyun_logout(app: AppHandle) -> Result<(), String> {
    clear_account(&app)
}

#[tauri::command]
pub fn jianguoyun_set_enabled(app: AppHandle, enabled: bool) -> Result<NutstoreStatus, String> {
    let mut account = load_account(&app)?.ok_or_else(|| "请先连接坚果云".to_string())?;
    if account.password.is_empty() {
        return Err("请先连接坚果云".into());
    }
    account.enabled = enabled;
    save_account(&app, &account)?;
    Ok(status_from(Some(account)))
}

#[tauri::command]
pub async fn jianguoyun_sync(
    app: AppHandle,
    root_path: String,
    skip_path: Option<String>,
) -> Result<NutstoreSyncReport, String> {
    let _busy = try_busy()?;
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("请先打开一个文件夹".into());
    }
    let stored = load_account(&app)?.ok_or_else(|| "请先连接坚果云".to_string())?;
    if !stored.enabled {
        return Err("坚果云同步尚未开启".into());
    }
    let folder_name = remote_folder_name(&root);
    let remote_root = format!("TigerMark/{folder_name}");
    let client = http_client()?;
    let mut local_files = Vec::new();
    collect_local(&root, "", &mut local_files, 0)?;
    let mut directories = std::collections::BTreeSet::new();
    directories.insert("TigerMark".into());
    directories.insert(remote_root.clone());
    for file in &local_files {
        if let Some((parent, _)) = file.rel.rsplit_once('/') {
            let mut prefix = remote_root.clone();
            for part in parent.split('/') {
                prefix.push('/');
                prefix.push_str(part);
                directories.insert(prefix.clone());
            }
        }
    }
    for directory in &directories {
        mkcol(&client, &stored.account, &stored.password, directory).await?;
    }
    let mut remote_files = Vec::new();
    list_remote(
        &client,
        &stored.account,
        &stored.password,
        &remote_root,
        "",
        &mut remote_files,
        0,
    )
    .await?;
    let mut local_map = HashMap::new();
    for file in local_files {
        local_map.insert(file.rel.clone(), file);
    }
    let mut remote_map = HashMap::new();
    for file in remote_files {
        remote_map.insert(file.rel.clone(), file);
    }
    let mut names: Vec<String> = local_map.keys().cloned().collect();
    for name in remote_map.keys() {
        if !local_map.contains_key(name) {
            names.push(name.clone());
        }
    }
    names.sort();

    let mut uploaded = 0;
    let mut downloaded = 0;
    let mut skipped = 0;
    let mut unsaved_skipped = false;
    for name in names {
        let local = local_map.remove(&name);
        let remote = remote_map.remove(&name);
        if let Some(local_file) = local.as_ref() {
            if skip_path
                .as_deref()
                .is_some_and(|path| same_path(&local_file.path.to_string_lossy(), path))
            {
                unsaved_skipped = true;
                skipped += 1;
                continue;
            }
        }
        match decide(
            local.as_ref().map(|file| (file.modified, file.size)),
            remote.as_ref().map(|file| (file.modified, file.size)),
        ) {
            SyncAction::Skip => skipped += 1,
            SyncAction::Upload => {
                let local_file = local.ok_or_else(|| "本地文件缺失".to_string())?;
                let bytes = fs::read(&local_file.path).map_err(|err| err.to_string())?;
                let remote_path = format!("{remote_root}/{}", local_file.rel);
                let modified = upload_file(
                    &client,
                    &stored.account,
                    &stored.password,
                    &remote_path,
                    bytes,
                )
                .await?;
                touch(&local_file.path, modified);
                uploaded += 1;
            }
            SyncAction::Download => {
                let remote_file = remote.ok_or_else(|| "远程文件缺失".to_string())?;
                let relative = safe_relative(&remote_file.rel)?;
                let path = root.join(relative);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                }
                let bytes = download_file(
                    &client,
                    &stored.account,
                    &stored.password,
                    &format!("{remote_root}/{}", remote_file.rel),
                )
                .await?;
                fs::write(&path, bytes).map_err(|err| err.to_string())?;
                touch(&path, remote_file.modified);
                downloaded += 1;
            }
        }
    }

    Ok(NutstoreSyncReport {
        account: stored.account,
        folder: remote_root,
        uploaded,
        downloaded,
        skipped,
        unsaved_skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::{href_path, parse_http_date, parse_multistatus};

    #[test]
    fn http_date_is_unix() {
        assert_eq!(
            parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"),
            Some(0)
        );
    }

    #[test]
    fn multistatus_reads_file_and_folder() {
        let xml = r#"<?xml version="1.0"?>
            <D:multistatus xmlns:D="DAV:">
              <D:response>
                <D:href>/dav/TigerMark/notes/</D:href>
                <D:propstat><D:prop>
                  <D:resourcetype><D:collection/></D:resourcetype>
                </D:prop></D:propstat>
              </D:response>
              <D:response>
                <D:href>/dav/TigerMark/notes/a%20b.md</D:href>
                <D:propstat><D:prop>
                  <D:getcontentlength>12</D:getcontentlength>
                  <D:getlastmodified>Thu, 01 Jan 1970 00:00:05 GMT</D:getlastmodified>
                  <D:resourcetype/>
                </D:prop></D:propstat>
              </D:response>
            </D:multistatus>"#;
        let entries = parse_multistatus(xml);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].is_dir);
        assert_eq!(href_path(&entries[1].href), "TigerMark/notes/a b.md");
        assert_eq!(entries[1].size, Some(12));
        assert_eq!(entries[1].modified, Some(5));
        assert!(!entries[1].is_dir);
    }
}
