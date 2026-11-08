use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CLIENT_ID: &str = "4022ad0f-edb9-49f3-b45c-cd6c47372c4f";
const REDIRECT_URI: &str = "http://127.0.0.1:47322/callback";
const AUTH_PORT: u16 = 47322;
const SCOPES: &str = "offline_access Files.ReadWrite User.Read";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const SIMPLE_UPLOAD_LIMIT: u64 = 4 * 1024 * 1024;
const UPLOAD_CHUNK: usize = 320 * 1024 * 10;

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
        return Err("OneDrive 正在处理另一个请求".into());
    }
    Ok(BusyGuard)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveStatus {
    pub connected: bool,
    pub enabled: bool,
    pub account: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OneDriveSyncReport {
    pub account: String,
    pub folder: String,
    pub uploaded: u32,
    pub downloaded: u32,
    pub skipped: u32,
    pub unsaved_skipped: bool,
}

#[derive(Serialize, Deserialize)]
struct StoredToken {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    account: String,
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
    id: String,
    rel: String,
    size: u64,
    modified: i64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

#[derive(Deserialize)]
struct GraphItem {
    id: String,
    name: String,
    size: Option<u64>,
    #[serde(rename = "lastModifiedDateTime")]
    modified: Option<String>,
    file: Option<serde_json::Value>,
    folder: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct GraphList {
    value: Vec<GraphItem>,
    #[serde(rename = "@odata.nextLink")]
    next: Option<String>,
}

#[derive(Deserialize)]
struct UploadSession {
    #[serde(rename = "uploadUrl")]
    upload_url: String,
}

enum SyncAction {
    Upload,
    Download,
    Skip,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| err.to_string())
}

fn token_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join("onedrive.json"))
}

fn load_token(app: &AppHandle) -> Result<Option<StoredToken>, String> {
    let path = token_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&raw).map(Some).map_err(|err| err.to_string())
}

fn save_token(app: &AppHandle, token: &StoredToken) -> Result<(), String> {
    let path = token_path(app)?;
    let raw = serde_json::to_string(token).map_err(|err| err.to_string())?;
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

fn clear_token(app: &AppHandle) -> Result<(), String> {
    let path = token_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn encode_seg(value: &str) -> String {
    encode_bytes(value, false)
}

fn encode_item_id(value: &str) -> String {
    encode_bytes(value, true)
}

fn encode_bytes(value: &str, keep_bang: bool) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b'!' if keep_bang => out.push('!'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn form_pair(key: &str, value: &str) -> String {
    format!("{}={}", encode_seg(key), encode_seg(value))
}

fn decode_component(value: &str) -> String {
    let value = value.replace('+', " ");
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

fn query_param(path: &str, key: &str) -> Option<String> {
    let query = path.split_once('?')?.1.split(' ').next().unwrap_or("");
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if decode_component(name) == key {
            return Some(decode_component(value));
        }
    }
    None
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

fn parse_rfc3339(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.len() < 19 {
        return None;
    }
    let year: i32 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    let hour: u32 = value.get(11..13)?.parse().ok()?;
    let minute: u32 = value.get(14..16)?.parse().ok()?;
    let second: u32 = value.get(17..19)?.parse().ok()?;
    let mut rest = value.get(19..)?;
    if let Some(stripped) = rest.strip_prefix('.') {
        let digits = stripped
            .find(|ch: char| !ch.is_ascii_digit())
            .unwrap_or(stripped.len());
        rest = stripped.get(digits..)?;
    }
    let days = days_from_civil(year, month, day)?;
    let mut secs = days * 86400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64;
    if rest == "Z" || rest.eq_ignore_ascii_case("z") || rest.is_empty() {
        return Some(secs);
    }
    let sign = *rest.as_bytes().first()?;
    if sign != b'+' && sign != b'-' {
        return None;
    }
    let offset_hour: i64 = rest.get(1..3)?.parse().ok()?;
    let offset_minute: i64 = rest.get(4..6)?.parse().ok()?;
    let offset = offset_hour * 3600 + offset_minute * 60;
    if sign == b'+' {
        secs -= offset;
    } else {
        secs += offset;
    }
    Some(secs)
}

fn error_text(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value["error_description"]
                .as_str()
                .or_else(|| value["error"]["message"].as_str())
                .or_else(|| value["error"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(240).collect())
}

fn service_read_only(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("servicereadonly") || lower.contains("temporarily read-only")
}

fn transient_status(status: u16) -> bool {
    matches!(status, 408 | 423 | 429 | 500 | 502 | 503 | 504 | 507)
}

fn retry_after_ms(response: &reqwest::Response, fallback: u64) -> u64 {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| seconds.saturating_mul(1000))
        .unwrap_or(fallback)
        .clamp(500, 20_000)
}

fn permission_denied(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("invalid_scope")
        || body.contains("AADSTS650053")
        || body.contains("AADSTS70011")
        || lower.contains("files.readwrite")
        || lower.contains("accessdenied")
}

fn friendly_auth_error(body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    if permission_denied(body) {
        return "登录被拒绝。请到 Entra 的这个应用里打开「API 权限」，添加 Microsoft Graph 的委托权限 Files.ReadWrite，保存后再连接一次。".into();
    }
    if body.contains("AADSTS50011") || lower.contains("redirect uri") {
        return "重定向地址不匹配。请在应用的「身份验证」里把重定向 URI 设为 http://127.0.0.1:47322/callback，平台选公共客户端。".into();
    }
    if lower.contains("access_denied") {
        return "已取消 OneDrive 登录".into();
    }
    if lower.contains("invalid_grant") {
        return "OneDrive 登录已失效，请重新连接".into();
    }
    let description = error_text(body);
    if description.trim().is_empty() {
        "OneDrive 登录失败".into()
    } else {
        format!("OneDrive 登录失败：{description}")
    }
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

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|err| err.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn graph_error(status: u16, body: &str) -> String {
    if status == 401 {
        return "OneDrive 登录已失效，请重新连接".into();
    }
    if status == 403 || permission_denied(body) {
        return "OneDrive 拒绝访问。请到 Entra 的这个应用里打开「API 权限」，添加 Microsoft Graph 的委托权限 Files.ReadWrite，然后重新连接。".into();
    }
    if service_read_only(body) {
        return "OneDrive 暂时不能写入。请用浏览器打开 onedrive.live.com，确认这个账号能上传文件；如果电脑上开着 OneDrive，先暂停同步再试。".into();
    }
    let description = error_text(body);
    if description.trim().is_empty() {
        format!("OneDrive 请求失败（{status}）")
    } else {
        format!("OneDrive 请求失败：{description}")
    }
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    graph_error(status, &body)
}

async fn exchange_token(form: String) -> Result<TokenResponse, String> {
    let client = http_client()?;
    let response = client
        .post("https://login.microsoftonline.com/common/oauth2/v2.0/token")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(form)
        .send()
        .await
        .map_err(|err| format!("无法连接微软登录服务：{err}"))?;
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(friendly_auth_error(&body));
    }
    response
        .json()
        .await
        .map_err(|err| format!("登录响应无法解析：{err}"))
}

async fn account_name(client: &reqwest::Client, access_token: &str) -> Result<String, String> {
    let response = client
        .get(format!("{GRAPH}/me?$select=displayName,userPrincipalName"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let value: serde_json::Value = response.json().await.map_err(|err| err.to_string())?;
    let name = value["displayName"]
        .as_str()
        .filter(|name| !name.is_empty())
        .or_else(|| value["userPrincipalName"].as_str())
        .unwrap_or("OneDrive")
        .to_string();
    Ok(name)
}

async fn ensure_token(app: &AppHandle) -> Result<StoredToken, String> {
    let mut token = load_token(app)?.ok_or_else(|| "请先连接 OneDrive".to_string())?;
    if token.expires_at > now_secs() + 60 {
        return Ok(token);
    }
    let form = [
        form_pair("client_id", CLIENT_ID),
        form_pair("grant_type", "refresh_token"),
        form_pair("refresh_token", &token.refresh_token),
        form_pair("scope", SCOPES),
    ]
    .join("&");
    let refreshed = match exchange_token(form).await {
        Ok(value) => value,
        Err(err) => {
            if err.contains("失效") || err.to_ascii_lowercase().contains("invalid_grant") {
                let _ = clear_token(app);
            }
            return Err(err);
        }
    };
    token.access_token = refreshed.access_token;
    if let Some(refresh) = refreshed.refresh_token {
        token.refresh_token = refresh;
    }
    token.expires_at = now_secs() + refreshed.expires_in;
    if token.account.is_empty() {
        let client = http_client()?;
        token.account = account_name(&client, &token.access_token).await.unwrap_or_default();
    }
    save_token(app, &token)?;
    Ok(token)
}

async fn read_login_request(stream: &mut TcpStream) -> Result<String, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if bytes.len() > 16_384 {
            return Err("登录回调无效".into());
        }
        let read = tokio::time::timeout(Duration::from_secs(8), stream.read(&mut chunk))
            .await
            .map_err(|_| "登录回调中断".to_string())?
            .map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let line = text.lines().next().unwrap_or("");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    if method != "GET" {
        return Ok(String::new());
    }
    Ok(path.to_string())
}

fn login_page(ok: bool) -> &'static str {
    if ok {
        "<!doctype html><meta charset=\"utf-8\"><title>TigerMark</title><body style=\"font-family:sans-serif;padding:48px\"><p>已登录 OneDrive，可以回到 TigerMark。</p>"
    } else {
        "<!doctype html><meta charset=\"utf-8\"><title>TigerMark</title><body style=\"font-family:sans-serif;padding:48px\"><p>登录没有完成，请回到 TigerMark 再试一次。</p>"
    }
}

async fn write_login_page(stream: &mut TcpStream, ok: bool) {
    let body = login_page(ok);
    let payload = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        if ok { "200 OK" } else { "400 Bad Request" },
        body.len()
    );
    let _ = stream.write_all(payload.as_bytes()).await;
}

async fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("登录超时，请重新连接".into());
        }
        let (mut stream, _) = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| "登录超时，请重新连接".to_string())?
            .map_err(|err| err.to_string())?;
        let path = read_login_request(&mut stream).await.unwrap_or_default();
        if !path.starts_with("/callback") {
            write_login_page(&mut stream, false).await;
            continue;
        }
        if let Some(error) = query_param(&path, "error") {
            write_login_page(&mut stream, false).await;
            let description = query_param(&path, "error_description").unwrap_or(error);
            return Err(friendly_auth_error(&description));
        }
        let state = query_param(&path, "state").unwrap_or_default();
        let code = query_param(&path, "code").unwrap_or_default();
        if state != expected_state || code.is_empty() {
            write_login_page(&mut stream, false).await;
            return Err("登录回调无效，请重新连接".into());
        }
        write_login_page(&mut stream, true).await;
        return Ok(code);
    }
}

fn collect_local(dir: &Path, rel: &str, out: &mut Vec<LocalFile>, depth: u8) -> Result<(), String> {
    if depth > 16 {
        return Ok(());
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

async fn list_children(
    client: &reqwest::Client,
    token: &str,
    folder_id: &str,
    prefix: &str,
    out: &mut Vec<RemoteFile>,
    depth: u8,
) -> Result<(), String> {
    if depth > 16 || out.len() > 5000 {
        return Ok(());
    }
    let mut url = format!(
        "{GRAPH}/me/drive/items/{}/children?$top=200&$select=id,name,size,lastModifiedDateTime,file,folder",
        encode_seg(folder_id)
    );
    for _ in 0..50 {
        let response = client
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        let page: GraphList = response.json().await.map_err(|err| err.to_string())?;
        let mut folders = Vec::new();
        for item in page.value {
            if should_skip_name(&item.name) {
                continue;
            }
            let rel = if prefix.is_empty() {
                item.name.clone()
            } else {
                format!("{prefix}/{}", item.name)
            };
            if item.folder.is_some() {
                folders.push((item.id, rel));
            } else if item.file.is_some() {
                let modified = item.modified.as_deref().and_then(parse_rfc3339).unwrap_or(0);
                if item.size.unwrap_or(0) > MAX_FILE_BYTES {
                    continue;
                }
                out.push(RemoteFile {
                    id: item.id,
                    rel,
                    size: item.size.unwrap_or(0),
                    modified,
                });
            }
        }
        for (id, rel) in folders {
            Box::pin(list_children(client, token, &id, &rel, out, depth + 1)).await?;
        }
        match page.next {
            Some(next) => url = next,
            None => break,
        }
    }
    Ok(())
}

async fn list_remote(
    client: &reqwest::Client,
    token: &str,
    folder: &str,
) -> Result<Vec<RemoteFile>, String> {
    let url = format!(
        "{GRAPH}/me/drive/root:/TigerMark/{}?$select=id,name,folder",
        encode_seg(folder)
    );
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if response.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let item: GraphItem = response.json().await.map_err(|err| err.to_string())?;
    let mut files = Vec::new();
    list_children(client, token, &item.id, "", &mut files, 0).await?;
    Ok(files)
}

fn directory_prefixes<I, S>(rel_paths: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut dirs = std::collections::BTreeSet::new();
    for rel in rel_paths {
        let mut acc = String::new();
        let mut parts = rel.as_ref().split('/').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                break;
            }
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            dirs.insert(acc.clone());
        }
    }
    dirs.into_iter().collect()
}

async fn ensure_child_folder(
    client: &reqwest::Client,
    token: &str,
    parent_id: Option<&str>,
    name: &str,
) -> Result<String, String> {
    let url = match parent_id {
        Some(id) => format!(
            "{GRAPH}/me/drive/items/{}/children",
            encode_item_id(id)
        ),
        None => format!("{GRAPH}/me/drive/root/children"),
    };
    let mut delay = 1000u64;
    for attempt in 0..5 {
        let response = client
            .post(&url)
            .bearer_auth(token)
            .json(&serde_json::json!({
                "name": name,
                "folder": {}
            }))
            .send()
            .await
            .map_err(|err| err.to_string())?;
        if response.status().is_success() {
            let item: GraphItem = response.json().await.map_err(|err| err.to_string())?;
            return Ok(item.id);
        }
        let status = response.status().as_u16();
        let wait = retry_after_ms(&response, delay);
        let body = response.text().await.unwrap_or_default();
        if status == 409 || body.to_ascii_lowercase().contains("namealreadyexists") {
            return lookup_child(client, token, parent_id, name).await;
        }
        if service_read_only(&body) {
            if let Ok(id) = lookup_child(client, token, parent_id, name).await {
                return Ok(id);
            }
        }
        if attempt < 4 && (transient_status(status) || service_read_only(&body)) {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            delay = (delay * 2).min(20_000);
            continue;
        }
        return Err(graph_error(status, &body));
    }
    Err("OneDrive 暂时不能写入。请用浏览器打开 onedrive.live.com，确认这个账号能上传文件；如果电脑上开着 OneDrive，先暂停同步再试。".into())
}

async fn lookup_child(
    client: &reqwest::Client,
    token: &str,
    parent_id: Option<&str>,
    name: &str,
) -> Result<String, String> {
    let url = match parent_id {
        Some(id) => format!(
            "{GRAPH}/me/drive/items/{}:/{}:",
            encode_item_id(id),
            encode_seg(name)
        ),
        None => format!("{GRAPH}/me/drive/root:/{}:", encode_seg(name)),
    };
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let item: GraphItem = response.json().await.map_err(|err| err.to_string())?;
    if item.folder.is_none() {
        return Err(format!("OneDrive 上的「{name}」不是文件夹，无法继续同步"));
    }
    Ok(item.id)
}

async fn ensure_remote_dirs(
    client: &reqwest::Client,
    token: &str,
    folder_name: &str,
    relative_dirs: &[String],
) -> Result<HashMap<String, String>, String> {
    let tiger = ensure_child_folder(client, token, None, "TigerMark").await?;
    let mut ids = HashMap::new();
    let workspace = ensure_child_folder(client, token, Some(&tiger), folder_name).await?;
    ids.insert(String::new(), workspace);
    for dir in relative_dirs {
        let (parent_rel, name) = match dir.rfind('/') {
            Some(index) => (&dir[..index], &dir[index + 1..]),
            None => ("", dir.as_str()),
        };
        let parent_id = ids
            .get(parent_rel)
            .cloned()
            .ok_or_else(|| format!("缺少上级目录 {parent_rel}"))?;
        let id = ensure_child_folder(client, token, Some(&parent_id), name).await?;
        ids.insert(dir.clone(), id);
    }
    Ok(ids)
}

async fn upload_file(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    file_name: &str,
    bytes: Vec<u8>,
) -> Result<i64, String> {
    if bytes.is_empty() || bytes.len() as u64 <= SIMPLE_UPLOAD_LIMIT {
        match upload_simple(client, token, parent_id, file_name, bytes.clone()).await {
            Ok(modified) => return Ok(modified),
            Err(err) if bytes.is_empty() || !err.contains("暂时不能写入") => return Err(err),
            Err(_) => {}
        }
    }
    let mut delay = 1000u64;
    let mut last_error = String::new();
    for attempt in 0..5 {
        match upload_large(client, token, parent_id, file_name, &bytes).await {
            Ok(modified) => return Ok(modified),
            Err(err) => {
                let retry = err.contains("暂时不能写入");
                last_error = err;
                if attempt == 4 || !retry {
                    return Err(last_error);
                }
                tokio::time::sleep(Duration::from_millis(delay)).await;
                delay = (delay * 2).min(20_000);
            }
        }
    }
    Err(last_error)
}

async fn upload_simple(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    file_name: &str,
    bytes: Vec<u8>,
) -> Result<i64, String> {
    let url = format!(
        "{GRAPH}/me/drive/items/{}:/{}:/content",
        encode_item_id(parent_id),
        encode_seg(file_name)
    );
    let mut delay = 1000u64;
    for attempt in 0..4 {
        let response = client
            .put(&url)
            .bearer_auth(token)
            .header("content-type", "application/octet-stream")
            .body(bytes.clone())
            .send()
            .await
            .map_err(|err| err.to_string())?;
        if response.status().is_success() {
            let item: GraphItem = response.json().await.map_err(|err| err.to_string())?;
            return Ok(item.modified.as_deref().and_then(parse_rfc3339).unwrap_or(0));
        }
        let status = response.status().as_u16();
        let wait = retry_after_ms(&response, delay);
        let body = response.text().await.unwrap_or_default();
        if attempt < 3 && (transient_status(status) || service_read_only(&body)) {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            delay = (delay * 2).min(20_000);
            continue;
        }
        return Err(graph_error(status, &body));
    }
    Err("OneDrive 暂时不能写入。请用浏览器打开 onedrive.live.com，确认这个账号能上传文件；如果电脑上开着 OneDrive，先暂停同步再试。".into())
}

async fn upload_large(
    client: &reqwest::Client,
    token: &str,
    parent_id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<i64, String> {
    let response = client
        .post(format!(
            "{GRAPH}/me/drive/items/{}:/{}:/createUploadSession",
            encode_item_id(parent_id),
            encode_seg(file_name)
        ))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "item": { "@microsoft.graph.conflictBehavior": "replace" }
        }))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let session: UploadSession = response.json().await.map_err(|err| err.to_string())?;
    let total = bytes.len();
    let mut start = 0;
    let mut modified = 0;
    while start < total {
        let end = (start + UPLOAD_CHUNK).min(total);
        let response = client
            .put(&session.upload_url)
            .header("content-length", (end - start).to_string())
            .header(
                "content-range",
                format!("bytes {start}-{}/{total}", end - 1),
            )
            .body(bytes[start..end].to_vec())
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let status = response.status().as_u16();
        if status == 200 || status == 201 {
            let item: GraphItem = response.json().await.map_err(|err| err.to_string())?;
            modified = item.modified.as_deref().and_then(parse_rfc3339).unwrap_or(0);
        } else if status != 202 {
            return Err(response_error(response).await);
        }
        start = end;
    }
    Ok(modified)
}

async fn download_file(client: &reqwest::Client, token: &str, item_id: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(format!(
            "{GRAPH}/me/drive/items/{}/content",
            encode_seg(item_id)
        ))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|err| err.to_string())
}

fn same_path(left: &str, right: &str) -> bool {
    left.replace('\\', "/").trim_end_matches('/') == right.replace('\\', "/").trim_end_matches('/')
}

fn status_from(token: Option<StoredToken>) -> OneDriveStatus {
    match token {
        Some(token) if !token.refresh_token.is_empty() => OneDriveStatus {
            connected: true,
            enabled: token.enabled,
            account: token.account,
        },
        _ => OneDriveStatus {
            connected: false,
            enabled: false,
            account: String::new(),
        },
    }
}

#[tauri::command]
pub fn onedrive_status(app: AppHandle) -> Result<OneDriveStatus, String> {
    Ok(status_from(load_token(&app)?))
}

#[tauri::command]
pub async fn onedrive_login(app: AppHandle) -> Result<OneDriveStatus, String> {
    let _busy = try_busy()?;
    let verifier = random_token()?;
    let state = random_token()?;
    let challenge = code_challenge(&verifier);
    let listener = TcpListener::bind(("127.0.0.1", AUTH_PORT))
        .await
        .map_err(|_| "登录端口 47322 被占用，请关掉占用它的程序后重试".to_string())?;
    let url = format!(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?{}",
        [
            form_pair("client_id", CLIENT_ID),
            form_pair("response_type", "code"),
            form_pair("redirect_uri", REDIRECT_URI),
            form_pair("response_mode", "query"),
            form_pair("scope", SCOPES),
            form_pair("state", &state),
            form_pair("code_challenge", &challenge),
            form_pair("code_challenge_method", "S256"),
            form_pair("prompt", "select_account"),
        ]
        .join("&")
    );
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("无法打开浏览器：{err}"))?;
    let code = wait_for_code(listener, &state).await?;
    let form = [
        form_pair("client_id", CLIENT_ID),
        form_pair("grant_type", "authorization_code"),
        form_pair("code", &code),
        form_pair("redirect_uri", REDIRECT_URI),
        form_pair("code_verifier", &verifier),
        form_pair("scope", SCOPES),
    ]
    .join("&");
    let issued = exchange_token(form).await?;
    let client = http_client()?;
    let account = account_name(&client, &issued.access_token).await?;
    let stored = StoredToken {
        access_token: issued.access_token,
        refresh_token: issued.refresh_token.unwrap_or_default(),
        expires_at: now_secs() + issued.expires_in,
        account: account.clone(),
        enabled: false,
    };
    if stored.refresh_token.is_empty() {
        return Err("微软没有返回刷新令牌。请确认登录范围包含 offline_access 后重新连接。".into());
    }
    save_token(&app, &stored)?;
    Ok(OneDriveStatus {
        connected: true,
        enabled: false,
        account,
    })
}

#[tauri::command]
pub fn onedrive_set_enabled(app: AppHandle, enabled: bool) -> Result<OneDriveStatus, String> {
    let mut token = load_token(&app)?.ok_or_else(|| "请先连接 OneDrive".to_string())?;
    if token.refresh_token.is_empty() {
        return Err("请先连接 OneDrive".into());
    }
    token.enabled = enabled;
    save_token(&app, &token)?;
    Ok(status_from(Some(token)))
}

#[tauri::command]
pub fn onedrive_logout(app: AppHandle) -> Result<(), String> {
    clear_token(&app)
}

#[tauri::command]
pub async fn onedrive_sync(
    app: AppHandle,
    root_path: String,
    skip_path: Option<String>,
) -> Result<OneDriveSyncReport, String> {
    let _busy = try_busy()?;
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err("请先打开一个文件夹".into());
    }
    let token = ensure_token(&app).await?;
    if !token.enabled {
        return Err("OneDrive 同步尚未开启".into());
    }
    let folder_name = remote_folder_name(&root);
    let remote_root = format!("TigerMark/{folder_name}");
    let client = http_client()?;
    let mut local_files = Vec::new();
    collect_local(&root, "", &mut local_files, 0)?;
    let remote_files = list_remote(&client, &token.access_token, &folder_name).await?;
    let mut local_map: HashMap<String, LocalFile> = HashMap::new();
    for file in local_files {
        local_map.insert(file.rel.clone(), file);
    }
    let mut remote_map: HashMap<String, RemoteFile> = HashMap::new();
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
    let folder_ids = ensure_remote_dirs(
        &client,
        &token.access_token,
        &folder_name,
        &directory_prefixes(local_map.keys()),
    )
    .await?;

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
        let action = decide(
            local.as_ref().map(|file| (file.modified, file.size)),
            remote.as_ref().map(|file| (file.modified, file.size)),
        );
        match action {
            SyncAction::Skip => skipped += 1,
            SyncAction::Upload => {
                let local_file = local.ok_or_else(|| "本地文件缺失".to_string())?;
                let bytes = fs::read(&local_file.path).map_err(|err| err.to_string())?;
                let (parent_rel, file_name) = match local_file.rel.rfind('/') {
                    Some(index) => (&local_file.rel[..index], &local_file.rel[index + 1..]),
                    None => ("", local_file.rel.as_str()),
                };
                let parent_id = folder_ids
                    .get(parent_rel)
                    .ok_or_else(|| format!("缺少上级目录 {parent_rel}"))?;
                let modified =
                    upload_file(&client, &token.access_token, parent_id, file_name, bytes).await?;
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
                let bytes = download_file(&client, &token.access_token, &remote_file.id).await?;
                fs::write(&path, bytes).map_err(|err| err.to_string())?;
                touch(&path, remote_file.modified);
                downloaded += 1;
            }
        }
    }

    Ok(OneDriveSyncReport {
        account: token.account,
        folder: remote_root,
        uploaded,
        downloaded,
        skipped,
        unsaved_skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        days_from_civil, decide, directory_prefixes, parse_rfc3339, remote_folder_name, SyncAction,
    };
    use std::path::Path;

    #[test]
    fn epoch_is_zero() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
    }

    #[test]
    fn offset_is_applied() {
        assert_eq!(parse_rfc3339("1970-01-01T08:00:00+08:00"), Some(0));
        assert_eq!(days_from_civil(1970, 1, 1), Some(0));
    }

    #[test]
    fn newer_side_wins_and_equal_files_skip() {
        assert!(matches!(decide(Some((20, 4)), Some((10, 4))), SyncAction::Upload));
        assert!(matches!(decide(Some((10, 4)), Some((20, 4))), SyncAction::Download));
        assert!(matches!(decide(Some((10, 4)), Some((11, 4))), SyncAction::Skip));
        assert!(matches!(decide(Some((10, 4)), None), SyncAction::Upload));
        assert!(matches!(decide(None, Some((10, 4))), SyncAction::Download));
    }

    #[test]
    fn prefixes_skip_the_file_name() {
        assert_eq!(
            directory_prefixes(["a.md", "notes/a.md", "notes/sub/b.md"]),
            vec!["notes".to_string(), "notes/sub".to_string()]
        );
    }

    #[test]
    fn folder_name_strips_onedrive_punctuation() {
        assert_eq!(remote_folder_name(Path::new("/notes/a:b")), "a_b");
        assert_eq!(remote_folder_name(Path::new("/notes/done.")), "done");
    }
}
