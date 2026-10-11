use std::fs;
use std::io::Write;
use std::net::TcpListener as StdTcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::commands::{
    initial_file_content, new_file_name, read_tree_relative, safe_entry_name,
};

const PORT: u16 = 47321;
const DISCOVERY_PORT: u16 = 47322;
const ORIGIN_DESKTOP: &str = "desktop";
const ORIGIN_FOLLOWER: &str = "follower";
const ORIGIN_REMOTE: &str = "remote";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    pub id: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub origin: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInfo {
    pub port: u16,
    pub token: String,
    pub host: String,
    pub page_url: String,
    pub clients: usize,
    pub sharing: bool,
    pub workspace_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct SeenPeer {
    host: String,
    port: u16,
    token: String,
    name: String,
    seen: Instant,
}

struct Inner {
    root: Mutex<Option<PathBuf>>,
    token: String,
    port: u16,
    error: Mutex<Option<String>>,
    clients: Arc<AtomicUsize>,
    tx: broadcast::Sender<SyncEvent>,
    app: AppHandle,
    sharing: AtomicBool,
    peers: Mutex<Vec<SeenPeer>>,
    follow_gen: AtomicU64,
    follow_target: Mutex<Option<String>>,
    seq: AtomicU64,
    log: Mutex<Vec<SyncEvent>>,
    last_remote: Mutex<Option<Instant>>,
}

pub struct SyncHub {
    inner: Arc<Inner>,
}

#[derive(Clone)]
struct HubHandle(Arc<Inner>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiBody<T: Serialize> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    root: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathQuery {
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBody {
    path: String,
    content: String,
    origin: Option<String>,
    encoding: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    dir_path: String,
    name: String,
    origin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteBody {
    path: String,
    origin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameBody {
    path: String,
    name: String,
    origin: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageBody {
    md_path: String,
    mime_type: String,
    data_base64: String,
}

fn ok_body<T: Serialize>(data: T) -> ApiBody<T> {
    ApiBody {
        ok: true,
        data: Some(data),
        error: None,
    }
}

fn err_body<T: Serialize>(error: impl ToString) -> ApiBody<T> {
    ApiBody {
        ok: false,
        data: None,
        error: Some(error.to_string()),
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("random");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn load_token(app: &AppHandle) -> String {
    let Some(dir) = app.path().app_config_dir().ok() else {
        return random_token();
    };
    let path = dir.join("sync-token");
    if let Ok(existing) = fs::read_to_string(&path) {
        let token = existing.trim().to_string();
        if token.len() >= 16 && token.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return token;
        }
    }
    let token = random_token();
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(path, &token);
    token
}

fn lan_host() -> String {
    if let Ok(socket) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip().to_string();
                if ip != "0.0.0.0" {
                    return ip;
                }
            }
        }
    }
    "127.0.0.1".into()
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn origin_of(origin: &Option<String>) -> String {
    origin
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 80)
        .unwrap_or("phone")
        .to_string()
}

impl Inner {
    fn root(&self) -> Result<PathBuf, String> {
        self.root
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "桌面端尚未打开文件夹".to_string())
    }

    fn workspace_name(&self) -> Option<String> {
        self.root.lock().unwrap().as_ref().and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
    }

    fn to_rel(&self, path: &str) -> String {
        let path_buf = PathBuf::from(path);
        if let Some(root) = self.root.lock().unwrap().clone() {
            if let Ok(stripped) = path_buf.strip_prefix(&root) {
                let rel = stripped.to_string_lossy().replace('\\', "/");
                if !rel.is_empty() {
                    return rel;
                }
            }
        }
        path.replace('\\', "/")
    }

    fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        let root = self.root()?;
        let root_canon = root.canonicalize().map_err(|err| err.to_string())?;
        let mut relative = PathBuf::new();
        let trimmed = rel.trim().trim_start_matches(['/', '\\']);
        if trimmed.is_empty() || trimmed == "." {
            return Ok(root_canon);
        }
        for segment in trimmed.split(['/', '\\']) {
            if segment.is_empty() || segment == "." {
                continue;
            }
            if segment == ".." {
                return Err("路径不合法".into());
            }
            relative.push(segment);
        }
        let full = root_canon.join(&relative);
        if full.exists() {
            let canon = full.canonicalize().map_err(|err| err.to_string())?;
            if !canon.starts_with(&root_canon) {
                return Err("路径超出工作区".into());
            }
            return Ok(canon);
        }
        if let Some(parent) = full.parent() {
            if parent.exists() {
                let parent_canon = parent.canonicalize().map_err(|err| err.to_string())?;
                if !parent_canon.starts_with(&root_canon) {
                    return Err("路径超出工作区".into());
                }
            }
        }
        Ok(full)
    }

    fn connected(&self) -> usize {
        let sse = self.clients.load(Ordering::SeqCst);
        let recent = self
            .last_remote
            .lock()
            .unwrap()
            .is_some_and(|seen| seen.elapsed() < Duration::from_secs(30));
        sse + usize::from(recent)
    }

    fn note_remote(&self) {
        *self.last_remote.lock().unwrap() = Some(Instant::now());
    }

    fn publish(&self, kind: &str, path: Option<String>, from: Option<String>, origin: &str) {
        let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let event = SyncEvent {
            id,
            kind: kind.to_string(),
            path,
            from,
            name: self.workspace_name(),
            origin: origin.to_string(),
        };
        {
            let mut log = self.log.lock().unwrap();
            log.push(event.clone());
            if log.len() > 200 {
                let extra = log.len() - 200;
                log.drain(0..extra);
            }
        }
        let _ = self.tx.send(event.clone());
        let _ = self.app.emit("sync:event", &event);
    }

    fn events_after(&self, since: u64) -> Vec<SyncEvent> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.id > since)
            .cloned()
            .collect()
    }

    fn stop_follower(&self) {
        self.follow_gen.fetch_add(1, Ordering::SeqCst);
        *self.follow_target.lock().unwrap() = None;
    }
}

impl SyncHub {
    pub fn info(&self) -> SyncInfo {
        let host = lan_host();
        let token = self.inner.token.clone();
        let port = self.inner.port;
        let page_url = if cfg!(debug_assertions) {
            format!("http://{host}:1420/?token={token}")
        } else if port == 0 {
            String::new()
        } else {
            format!("http://{host}:{port}/?token={token}")
        };
        SyncInfo {
            port,
            token,
            host,
            page_url,
            clients: self.inner.connected(),
            sharing: self.inner.sharing.load(Ordering::SeqCst),
            workspace_open: self.inner.root.lock().unwrap().is_some(),
            error: self.inner.error.lock().unwrap().clone(),
        }
    }

    pub fn set_root(&self, path: Option<String>) {
        let next = path.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(PathBuf::from(trimmed))
            }
        });
        *self.inner.root.lock().unwrap() = next;
        self.inner.publish("workspace", None, None, ORIGIN_DESKTOP);
    }

    pub fn set_sharing(&self, enabled: bool) {
        self.inner.sharing.store(enabled, Ordering::SeqCst);
        if enabled {
            self.inner.stop_follower();
        }
    }
}

pub fn notify(app: &AppHandle, kind: &str, path: Option<&str>, origin: &str) {
    let Some(hub) = app.try_state::<SyncHub>() else {
        return;
    };
    let rel = path.map(|value| hub.inner.to_rel(value));
    hub.inner.publish(kind, rel, None, origin);
}

pub fn notify_rename(app: &AppHandle, from: &str, to: &str) {
    let Some(hub) = app.try_state::<SyncHub>() else {
        return;
    };
    hub.inner.publish(
        "rename",
        Some(hub.inner.to_rel(to)),
        Some(hub.inner.to_rel(from)),
        ORIGIN_DESKTOP,
    );
}

pub fn start(app: AppHandle) -> SyncHub {
    let (tx, _) = broadcast::channel(64);
    let token = load_token(&app);
    let clients = Arc::new(AtomicUsize::new(0));
    let (listener, port, error) = match bind_sync_port() {
        Ok((listener, port)) => (Some(listener), port, None),
        Err(err) => (None, 0, Some(err)),
    };
    let inner = Arc::new(Inner {
        root: Mutex::new(None),
        token,
        port,
        error: Mutex::new(error),
        clients: clients.clone(),
        tx,
        app,
        sharing: AtomicBool::new(false),
        peers: Mutex::new(Vec::new()),
        follow_gen: AtomicU64::new(0),
        follow_target: Mutex::new(None),
        seq: AtomicU64::new(0),
        log: Mutex::new(Vec::new()),
        last_remote: Mutex::new(None),
    });
    if let Some(std_listener) = listener {
        let handle = HubHandle(inner.clone());
        tauri::async_runtime::spawn(async move {
            if let Err(err) = serve(std_listener, handle).await {
                eprintln!("局域网同步服务退出: {err}");
            }
        });
    }
    let discovery = HubHandle(inner.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(err) = discovery_loop(discovery).await {
            eprintln!("局域网发现退出: {err}");
        }
    });
    SyncHub { inner }
}

fn bind_sync_port() -> Result<(StdTcpListener, u16), String> {
    match StdTcpListener::bind(("0.0.0.0", PORT)) {
        Ok(listener) => {
            listener.set_nonblocking(true).map_err(|err| err.to_string())?;
            Ok((listener, PORT))
        }
        Err(err) => Err(format!("无法监听 {PORT} 端口（{err}）。请确认没有另一个 TigerMark 正在占用它")),
    }
}

async fn serve(std_listener: StdTcpListener, hub: HubHandle) -> Result<(), String> {
    let listener = TcpListener::from_std(std_listener).map_err(|err| err.to_string())?;
    let router = Router::new()
        .route("/api/workspace", get(workspace))
        .route("/api/tree", get(tree))
        .route("/api/file", get(read_file).put(write_file))
        .route("/api/create-file", post(create_file))
        .route("/api/create-folder", post(create_folder))
        .route("/api/delete", post(delete_path))
        .route("/api/rename", post(rename_path))
        .route("/api/image", post(save_image))
        .route("/api/raw", get(raw_file))
        .route("/api/events", get(events))
        .route("/api/bundle", get(bundle))
        .route("/api/wait", get(wait_events))
        .fallback(frontend)
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(hub.clone(), authorize))
        .with_state(hub);
    axum::serve(listener, router)
        .await
        .map_err(|err| err.to_string())
}

async fn authorize(
    State(hub): State<HubHandle>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if !request.uri().path().starts_with("/api") {
        return Ok(next.run(request).await);
    }
    if authorized(&request, &hub.0.token) {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn authorized(request: &Request<Body>, token: &str) -> bool {
    if let Some(value) = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    {
        if constant_time_eq(value.trim(), token) {
            return true;
        }
    }
    if let Some(cookie) = request
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
    {
        for part in cookie.split(';') {
            let part = part.trim();
            if let Some(value) = part.strip_prefix("tm_sync=") {
                if constant_time_eq(value.trim(), token) {
                    return true;
                }
            }
        }
    }
    if let Some(query) = request.uri().query() {
        for pair in query.split('&') {
            let mut parts = pair.splitn(2, '=');
            if parts.next() == Some("token") {
                if constant_time_eq(parts.next().unwrap_or("").trim(), token) {
                    return true;
                }
            }
        }
    }
    false
}

async fn workspace(State(hub): State<HubHandle>) -> Json<ApiBody<WorkspaceInfo>> {
    match hub.0.root() {
        Ok(path) => {
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| "工作区".into());
            Json(ok_body(WorkspaceInfo {
                root: ".".into(),
                name,
            }))
        }
        Err(err) => Json(err_body(err)),
    }
}

async fn tree(State(hub): State<HubHandle>) -> Json<ApiBody<Vec<crate::commands::FileNode>>> {
    let root = match hub.0.root() {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let result = tauri::async_runtime::spawn_blocking(move || read_tree_relative(&root)).await;
    match result {
        Ok(Ok(nodes)) => Json(ok_body(nodes)),
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn read_file(
    State(hub): State<HubHandle>,
    Query(query): Query<PathQuery>,
) -> Json<ApiBody<String>> {
    let rel = query.path.unwrap_or_default();
    let path = match hub.0.resolve(&rel) {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        fs::read_to_string(path).map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(Ok(content)) => Json(ok_body(content)),
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn write_file(
    State(hub): State<HubHandle>,
    Json(body): Json<WriteBody>,
) -> Json<ApiBody<()>> {
    let origin = origin_of(&body.origin);
    let rel = body.path.clone();
    let path = match hub.0.resolve(&rel) {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let content = match decode_payload(&body.content, body.encoding.as_deref()) {
        Ok(bytes) => bytes,
        Err(err) => return Json(err_body(err)),
    };
    let created = !path.exists();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::write(path, content).map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(Ok(())) => {
            let rel = hub.0.to_rel(&rel);
            if created {
                hub.0.publish("tree", Some(rel), None, &origin);
            } else {
                hub.0.publish("write", Some(rel), None, &origin);
            }
            Json(ok_body(()))
        }
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn create_file(
    State(hub): State<HubHandle>,
    Json(body): Json<CreateBody>,
) -> Json<ApiBody<String>> {
    let origin = origin_of(&body.origin);
    let dir_path = body.dir_path.clone();
    let name = body.name.clone();
    let dir = match hub.0.resolve(&dir_path) {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let file_name = new_file_name(&name)?;
        let file_path = dir.join(&file_name);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
            .map_err(|err| err.to_string())?;
        write!(file, "{}", initial_file_content(&file_name)).map_err(|err| err.to_string())?;
        Ok::<_, String>(file_name)
    })
    .await;
    match result {
        Ok(Ok(file_name)) => {
            let rel = join_rel(&dir_path, &file_name);
            hub.0.publish("tree", Some(rel.clone()), None, &origin);
            Json(ok_body(rel))
        }
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn create_folder(
    State(hub): State<HubHandle>,
    Json(body): Json<CreateBody>,
) -> Json<ApiBody<String>> {
    let origin = origin_of(&body.origin);
    let dir = match hub.0.resolve(&body.dir_path) {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let folder_name = match safe_entry_name(&body.name) {
        Ok(name) => name.to_string(),
        Err(err) => return Json(err_body(err)),
    };
    let target = dir.join(&folder_name);
    let result = tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir(&target).map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(Ok(())) => {
            let rel = join_rel(&body.dir_path, &folder_name);
            hub.0.publish("tree", Some(rel.clone()), None, &origin);
            Json(ok_body(rel))
        }
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn delete_path(
    State(hub): State<HubHandle>,
    Json(body): Json<DeleteBody>,
) -> Json<ApiBody<()>> {
    let origin = origin_of(&body.origin);
    let rel = body.path.clone();
    let path = match hub.0.resolve(&rel) {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let root = match hub.0.root() {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    if path == root {
        return Json(err_body("不能删除工作区根目录"));
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|err| err.to_string())?;
        if meta.is_dir() {
            fs::remove_dir_all(&path).map_err(|err| err.to_string())
        } else {
            fs::remove_file(&path).map_err(|err| err.to_string())
        }
    })
    .await;
    match result {
        Ok(Ok(())) => {
            hub.0
                .publish("delete", Some(hub.0.to_rel(&rel)), None, &origin);
            Json(ok_body(()))
        }
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn rename_path(
    State(hub): State<HubHandle>,
    Json(body): Json<RenameBody>,
) -> Json<ApiBody<String>> {
    let origin = origin_of(&body.origin);
    let from_rel = body.path.clone();
    let old = match hub.0.resolve(&from_rel) {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let new_name = match safe_entry_name(&body.name) {
        Ok(name) => name.to_string(),
        Err(err) => return Json(err_body(err)),
    };
    let parent = old.parent().map(Path::to_path_buf).unwrap_or_else(|| old.clone());
    let target = parent.join(&new_name);
    let result = tauri::async_runtime::spawn_blocking(move || {
        fs::rename(&old, &target).map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(Ok(())) => {
            let parent_rel = parent_rel(&from_rel);
            let rel = join_rel(&parent_rel, &new_name);
            hub.0.publish(
                "rename",
                Some(rel.clone()),
                Some(from_rel.replace('\\', "/")),
                &origin,
            );
            Json(ok_body(rel))
        }
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn save_image(
    State(hub): State<HubHandle>,
    Json(body): Json<ImageBody>,
) -> Json<ApiBody<String>> {
    let md = match hub.0.resolve(&body.md_path) {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(body.data_base64.trim()) {
        Ok(bytes) => bytes,
        Err(err) => return Json(err_body(err)),
    };
    let mime = body.mime_type.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let assets = md
            .parent()
            .map(|parent| parent.join("assets"))
            .unwrap_or_else(|| PathBuf::from("assets"));
        fs::create_dir_all(&assets).map_err(|err| err.to_string())?;
        let file_name = crate::commands::image_file_name(&mime);
        let absolute = assets.join(&file_name);
        fs::write(&absolute, bytes).map_err(|err| err.to_string())?;
        Ok::<_, String>(format!("assets/{file_name}"))
    })
    .await;
    match result {
        Ok(Ok(relative)) => Json(ok_body(relative)),
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn raw_file(
    State(hub): State<HubHandle>,
    Query(query): Query<PathQuery>,
) -> Response {
    let rel = query.path.unwrap_or_default();
    let path = match hub.0.resolve(&rel) {
        Ok(path) => path,
        Err(err) => {
            return (StatusCode::BAD_REQUEST, err).into_response();
        }
    };
    match fs::read(&path) {
        Ok(bytes) => {
            let mime = mime_of(path.to_string_lossy().as_ref());
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(err) => (StatusCode::NOT_FOUND, err.to_string()).into_response(),
    }
}

async fn events(
    State(hub): State<HubHandle>,
) -> Sse<impl futures_core::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let clients = hub.0.clients.clone();
    let mut rx = hub.0.tx.subscribe();
    let stream = async_stream::stream! {
        clients.fetch_add(1, Ordering::SeqCst);
        let _guard = ClientGuard(clients.clone());
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Ok(message) = Event::default().json_data(&event) {
                        yield Ok(message);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

struct ClientGuard(Arc<AtomicUsize>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn frontend(request: Request<Body>) -> Response {
    #[cfg(debug_assertions)]
    {
        let _ = request;
        (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            "<!doctype html><meta charset=\"utf-8\"><title>TigerMark</title><p>开发模式下，请用桌面端「同步」里显示的地址打开（端口 1420）。</p>",
        )
            .into_response()
    }
    #[cfg(not(debug_assertions))]
    {
        serve_dist(request.uri().path())
    }
}

#[cfg(not(debug_assertions))]
fn serve_dist(path: &str) -> Response {
    use include_dir::{include_dir, Dir};
    static DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if let Some(file) = DIST.get_file(rel) {
        return file_response(rel, file.contents());
    }
    if !rel.contains('.') {
        if let Some(file) = DIST.get_file("index.html") {
            return file_response("index.html", file.contents());
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

#[cfg(not(debug_assertions))]
fn file_response(path: &str, bytes: &[u8]) -> Response {
    (
        [(header::CONTENT_TYPE, mime_of(path))],
        bytes.to_vec(),
    )
        .into_response()
}

fn mime_of(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

fn join_rel(dir: &str, name: &str) -> String {
    let dir = dir.trim().trim_matches(['/', '\\']);
    if dir.is_empty() || dir == "." {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn parent_rel(path: &str) -> String {
    let path = path.replace('\\', "/");
    match path.rfind('/') {
        Some(index) => path[..index].to_string(),
        None => ".".into(),
    }
}

fn decode_payload(content: &str, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    if encoding == Some("base64") {
        base64::engine::general_purpose::STANDARD
            .decode(content.trim())
            .map_err(|err| err.to_string())
    } else {
        Ok(content.as_bytes().to_vec())
    }
}

fn is_note_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".board.json")
        || lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdown")
        || lower.ends_with(".mkd")
        || lower.ends_with(".txt")
}

fn is_asset_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".svg")
}

fn push_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim().trim_start_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed == "." {
        return Err("路径不合法".into());
    }
    let mut full = root.to_path_buf();
    for segment in trimmed.split(['/', '\\']) {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("路径不合法".into());
        }
        full.push(segment);
    }
    Ok(full)
}

fn relative_to_root(root: &Path, path: &Path) -> Result<String, String> {
    let stripped = path.strip_prefix(root).map_err(|_| "路径超出工作区".to_string())?;
    let rel = stripped.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        return Err("不能同步根目录".into());
    }
    Ok(rel)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleFile {
    path: String,
    encoding: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    name: String,
    seq: u64,
    files: Vec<BundleFile>,
}

#[derive(Deserialize)]
struct BundleFileIn {
    path: String,
    encoding: String,
    content: String,
}

#[derive(Deserialize)]
struct BundleIn {
    name: String,
    seq: u64,
    files: Vec<BundleFileIn>,
}

#[derive(Deserialize)]
struct WaitQuery {
    since: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct WaitBody {
    seq: u64,
    events: Vec<SyncEvent>,
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}

fn collect_bundle(dir: &Path, rel: &str, depth: u8, files: &mut Vec<BundleFile>) -> Result<(), String> {
    if depth > 8 {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") {
            continue;
        }
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if file_type.is_dir() {
            if name.eq_ignore_ascii_case("assets") {
                collect_assets(&entry.path(), &child_rel, files)?;
            } else {
                collect_bundle(&entry.path(), &child_rel, depth + 1, files)?;
            }
            continue;
        }
        if is_note_file(&name) {
            let text = fs::read_to_string(entry.path()).map_err(|err| err.to_string())?;
            files.push(BundleFile {
                path: child_rel,
                encoding: "utf8".into(),
                content: text,
            });
        }
    }
    Ok(())
}

fn collect_assets(dir: &Path, rel: &str, files: &mut Vec<BundleFile>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !is_asset_file(&name) {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|err| err.to_string())?;
        files.push(BundleFile {
            path: format!("{rel}/{name}"),
            encoding: "base64".into(),
            content: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    Ok(())
}

async fn bundle(State(hub): State<HubHandle>) -> Json<ApiBody<Bundle>> {
    hub.0.note_remote();
    let root = match hub.0.root() {
        Ok(path) => path,
        Err(err) => return Json(err_body(err)),
    };
    let name = hub.0.workspace_name().unwrap_or_else(|| "工作区".into());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        collect_bundle(&root, "", 0, &mut files)?;
        Ok::<_, String>(files)
    })
    .await;
    match result {
        Ok(Ok(files)) => {
            let encoded: usize = files.iter().map(|file| file.content.len()).sum();
            if encoded > 24 * 1024 * 1024 {
                return Json(err_body("工作区太大，暂时无法一次同步"));
            }
            Json(ok_body(Bundle {
                name,
                seq: hub.0.seq.load(Ordering::SeqCst),
                files,
            }))
        }
        Ok(Err(err)) => Json(err_body(err)),
        Err(err) => Json(err_body(err)),
    }
}

async fn wait_events(
    State(hub): State<HubHandle>,
    Query(query): Query<WaitQuery>,
) -> Json<ApiBody<WaitBody>> {
    hub.0.note_remote();
    let since = query.since.unwrap_or(0);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let events = hub.0.events_after(since);
        if !events.is_empty() || Instant::now() >= deadline {
            return Json(ok_body(WaitBody {
                seq: hub.0.seq.load(Ordering::SeqCst),
                events,
            }));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[derive(Serialize, Deserialize)]
struct Announce {
    v: u8,
    port: u16,
    token: String,
    name: String,
}

async fn discovery_loop(hub: HubHandle) -> Result<(), String> {
    let std_socket = std::net::UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT))
        .map_err(|err| format!("无法监听发现端口 {DISCOVERY_PORT}（{err}）"))?;
    std_socket.set_broadcast(true).map_err(|err| err.to_string())?;
    std_socket.set_nonblocking(true).map_err(|err| err.to_string())?;
    let socket = tokio::net::UdpSocket::from_std(std_socket).map_err(|err| err.to_string())?;
    let mut buf = [0u8; 1024];
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if hub.0.sharing.load(Ordering::SeqCst) {
                    let _ = send_announce(&socket, &hub).await;
                }
            }
            received = socket.recv_from(&mut buf) => {
                let Ok((size, addr)) = received else { continue };
                remember_announce(&hub, &buf[..size], &addr);
            }
        }
    }
}

async fn send_announce(socket: &tokio::net::UdpSocket, hub: &HubHandle) -> Result<(), String> {
    let announce = Announce {
        v: 1,
        port: hub.0.port,
        token: hub.0.token.clone(),
        name: hub.0.workspace_name().unwrap_or_else(|| "TigerMark".into()),
    };
    let packet = serde_json::to_vec(&announce).map_err(|err| err.to_string())?;
    socket
        .send_to(&packet, ("255.255.255.255", DISCOVERY_PORT))
        .await
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn remember_announce(hub: &HubHandle, packet: &[u8], addr: &std::net::SocketAddr) {
    let Ok(announce) = serde_json::from_slice::<Announce>(packet) else {
        return;
    };
    if announce.v != 1 || announce.port == 0 || announce.token == hub.0.token {
        return;
    }
    if announce.token.len() < 16 || announce.token.len() > 80 {
        return;
    }
    let host = match addr.ip() {
        std::net::IpAddr::V4(ip) => ip.to_string(),
        std::net::IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => return,
        },
    };
    let name = announce.name.chars().take(80).collect::<String>();
    let mut peers = hub.0.peers.lock().unwrap();
    if let Some(existing) = peers.iter_mut().find(|peer| peer.token == announce.token) {
        existing.host = host;
        existing.port = announce.port;
        existing.name = name;
        existing.seen = Instant::now();
        return;
    }
    peers.push(SeenPeer {
        host,
        port: announce.port,
        token: announce.token,
        name,
        seen: Instant::now(),
    });
    if peers.len() > 16 {
        peers.remove(0);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPeer {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowReport {
    pub following: bool,
    pub pulled: bool,
    pub files: u32,
    pub name: String,
}

fn current_peers(hub: &SyncHub) -> Vec<DiscoveredPeer> {
    let mut peers = hub.inner.peers.lock().unwrap();
    peers.retain(|peer| peer.seen.elapsed() < Duration::from_secs(4));
    peers
        .iter()
        .filter(|peer| peer.token != hub.inner.token)
        .map(|peer| DiscoveredPeer {
            host: peer.host.clone(),
            port: peer.port,
            token: peer.token.clone(),
            name: peer.name.clone(),
        })
        .collect()
}

async fn http_exchange(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect((host, port))
            .await
            .map_err(|err| format!("无法连接 {host}:{port}（{err}）"))?;
        let _ = stream.set_nodelay(true);
        let mut request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\nAccept: application/json\r\n"
        );
        if let Some(payload) = &body {
            request.push_str("Content-Type: application/json\r\n");
            request.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        request.push_str("\r\n");
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|err| err.to_string())?;
        if let Some(payload) = &body {
            stream.write_all(payload).await.map_err(|err| err.to_string())?;
        }
        read_http_body(&mut stream).await
    };
    match tokio::time::timeout(timeout, exchange).await {
        Ok(result) => result,
        Err(_) => Err("连接超时".into()),
    }
}

async fn read_http_body(stream: &mut tokio::net::TcpStream) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let header_end = loop {
        let size = stream.read(&mut tmp).await.map_err(|err| err.to_string())?;
        if size == 0 {
            return Err("连接中断".into());
        }
        buf.extend_from_slice(&tmp[..size]);
        if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 64 * 1024 {
            return Err("响应头过大".into());
        }
    };
    let header = std::str::from_utf8(&buf[..header_end]).map_err(|err| err.to_string())?;
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    if status == 401 {
        return Err("同步口令无效".into());
    }
    if status != 200 {
        return Err(format!("同步请求失败（{status}）"));
    }
    let length = header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    });
    let mut body = buf[header_end + 4..].to_vec();
    if let Some(length) = length {
        if length > 32 * 1024 * 1024 {
            return Err("同步内容过大".into());
        }
        while body.len() < length {
            let size = stream.read(&mut tmp).await.map_err(|err| err.to_string())?;
            if size == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..size]);
        }
        body.truncate(length);
    } else {
        loop {
            let size = stream.read(&mut tmp).await.map_err(|err| err.to_string())?;
            if size == 0 {
                break;
            }
            body.extend_from_slice(&tmp[..size]);
            if body.len() > 32 * 1024 * 1024 {
                return Err("同步内容过大".into());
            }
        }
    }
    Ok(body)
}

fn write_synced_file(root: &Path, path: &str, encoding: &str, content: &str) -> Result<(), String> {
    let dest = push_rel(root, path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let bytes = decode_payload(content, Some(encoding))?;
    fs::write(dest, bytes).map_err(|err| err.to_string())
}

async fn pull_bundle(hub: &HubHandle, host: &str, port: u16, token: &str) -> Result<(String, u64, u32), String> {
    let bytes = http_exchange(
        host,
        port,
        "GET",
        "/api/bundle",
        token,
        None,
        Duration::from_secs(60),
    )
    .await?;
    let envelope: ApiEnvelope<BundleIn> = serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;
    if !envelope.ok {
        return Err(envelope.error.unwrap_or_else(|| "读取对方笔记失败".into()));
    }
    let bundle = envelope.data.ok_or_else(|| "读取对方笔记失败".to_string())?;
    let root = hub.0.ensure_root()?;
    let name = bundle.name.clone();
    let seq = bundle.seq;
    let count = bundle.files.len() as u32;
    let result = tauri::async_runtime::spawn_blocking(move || {
        for file in &bundle.files {
            write_synced_file(&root, &file.path, &file.encoding, &file.content)?;
        }
        Ok::<_, String>(())
    })
    .await;
    match result {
        Ok(Ok(())) => Ok((name, seq, count)),
        Ok(Err(err)) => Err(err),
        Err(err) => Err(err.to_string()),
    }
}

impl Inner {
    fn ensure_root(&self) -> Result<PathBuf, String> {
        if let Some(path) = self.root.lock().unwrap().clone() {
            return Ok(path);
        }
        #[cfg(not(desktop))]
        {
            let path = crate::commands::mobile_workspace(&self.app)?;
            *self.root.lock().unwrap() = Some(path.clone());
            return Ok(path);
        }
        #[cfg(desktop)]
        {
            Err("请先打开文件夹，再接收另一台设备的笔记".into())
        }
    }
}

async fn apply_remote_event(
    hub: &HubHandle,
    host: &str,
    port: u16,
    token: &str,
    event: &SyncEvent,
) -> Result<(), String> {
    let root = hub.0.root()?;
    match event.kind.as_str() {
        "write" | "tree" => {
            let Some(rel) = event.path.clone() else {
                return Ok(());
            };
            if is_asset_file(&rel) {
                let raw_path = format!("/api/raw?path={}", urlencoding_min(&rel));
                let bytes = http_exchange(host, port, "GET", &raw_path, token, None, Duration::from_secs(20)).await?;
                let root_for_write = root.clone();
                let rel_for_write = rel.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let dest = push_rel(&root_for_write, &rel_for_write)?;
                    if let Some(parent) = dest.parent() {
                        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                    }
                    fs::write(dest, bytes).map_err(|err| err.to_string())
                })
                .await
                .map_err(|err| err.to_string())??;
                hub.0.publish(
                    if event.kind == "tree" { "tree" } else { "write" },
                    Some(rel),
                    None,
                    ORIGIN_REMOTE,
                );
                return Ok(());
            }
            let path = format!("/api/file?path={}", urlencoding_min(&rel));
            let bytes = http_exchange(host, port, "GET", &path, token, None, Duration::from_secs(20)).await;
            match bytes {
                Ok(body) => {
                    let envelope: ApiEnvelope<String> =
                        serde_json::from_slice(&body).map_err(|err| err.to_string())?;
                    if let Some(content) = envelope.data {
                        let root_for_write = root.clone();
                        let rel_for_write = rel.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            write_synced_file(&root_for_write, &rel_for_write, "utf8", &content)
                        })
                        .await
                        .map_err(|err| err.to_string())??;
                        hub.0.publish(
                            if event.kind == "tree" { "tree" } else { "write" },
                            Some(rel),
                            None,
                            ORIGIN_REMOTE,
                        );
                    } else {
                        let dest = push_rel(&root, &rel)?;
                        let _ = fs::create_dir_all(&dest);
                        hub.0.publish("tree", Some(rel), None, ORIGIN_REMOTE);
                    }
                }
                Err(_) => {
                    let dest = push_rel(&root, &rel)?;
                    let _ = fs::create_dir_all(&dest);
                    hub.0.publish("tree", Some(rel), None, ORIGIN_REMOTE);
                }
            }
        }
        "delete" => {
            let Some(rel) = event.path.clone() else {
                return Ok(());
            };
            let dest = push_rel(&root, &rel)?;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if dest.is_dir() {
                    fs::remove_dir_all(&dest)
                } else {
                    fs::remove_file(&dest)
                }
            })
            .await;
            hub.0.publish("delete", Some(rel), None, ORIGIN_REMOTE);
        }
        "rename" => {
            let (Some(to), Some(from)) = (event.path.clone(), event.from.clone()) else {
                return Ok(());
            };
            let source = push_rel(&root, &from)?;
            let dest = push_rel(&root, &to)?;
            let _ = tauri::async_runtime::spawn_blocking(move || fs::rename(source, dest)).await;
            hub.0
                .publish("rename", Some(to), Some(from), ORIGIN_REMOTE);
        }
        "workspace" => {
            let _ = pull_bundle(hub, host, port, token).await?;
            hub.0.publish("reload", None, None, ORIGIN_REMOTE);
        }
        _ => {}
    }
    Ok(())
}

fn urlencoding_min(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn follow_key(host: &str, port: u16, token: &str) -> String {
    format!("{host}|{port}|{token}")
}

fn parse_follow_key(key: &str) -> Option<(String, u16, String)> {
    let mut parts = key.splitn(3, '|');
    let host = parts.next()?.to_string();
    let port = parts.next()?.parse().ok()?;
    let token = parts.next()?.to_string();
    if host.is_empty() || token.is_empty() {
        return None;
    }
    Some((host, port, token))
}

pub fn mirror_write(app: &AppHandle, path: &str) {
    mirror(app, MirrorOp::Write(path.to_string()));
}

pub fn mirror_delete(app: &AppHandle, path: &str) {
    mirror(app, MirrorOp::Delete(path.to_string()));
}

pub fn mirror_mkdir(app: &AppHandle, path: &str) {
    mirror(app, MirrorOp::Mkdir(path.to_string()));
}

pub fn mirror_rename(app: &AppHandle, from: &str, to: &str) {
    mirror(
        app,
        MirrorOp::Rename {
            from: from.to_string(),
            to: to.to_string(),
        },
    );
}

enum MirrorOp {
    Write(String),
    Delete(String),
    Mkdir(String),
    Rename { from: String, to: String },
}

fn mirror(app: &AppHandle, op: MirrorOp) {
    let Some(hub) = app.try_state::<SyncHub>() else {
        return;
    };
    if hub.inner.sharing.load(Ordering::SeqCst) {
        return;
    }
    let Some(key) = hub.inner.follow_target.lock().unwrap().clone() else {
        return;
    };
    let Some(root) = hub.inner.root.lock().unwrap().clone() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Err(err) = push_mirror(&key, &root, op).await {
            eprintln!("同步回传失败: {err}");
        }
    });
}

async fn push_mirror(key: &str, root: &Path, op: MirrorOp) -> Result<(), String> {
    let (host, port, token) = parse_follow_key(key).ok_or_else(|| "同步目标无效".to_string())?;
    let (method, path, body) = match op {
        MirrorOp::Write(absolute) => {
            let rel = relative_to_root(root, Path::new(&absolute))?;
            let bytes = fs::read(&absolute).map_err(|err| err.to_string())?;
            let payload = if is_asset_file(&rel) {
                serde_json::json!({
                    "path": rel,
                    "content": base64::engine::general_purpose::STANDARD.encode(bytes),
                    "encoding": "base64",
                    "origin": ORIGIN_FOLLOWER,
                })
            } else {
                let text = String::from_utf8(bytes).map_err(|err| err.to_string())?;
                serde_json::json!({
                    "path": rel,
                    "content": text,
                    "origin": ORIGIN_FOLLOWER,
                })
            };
            ("PUT", "/api/file".to_string(), payload.to_string().into_bytes())
        }
        MirrorOp::Delete(absolute) => {
            let rel = relative_to_root(root, Path::new(&absolute))?;
            let payload = serde_json::json!({ "path": rel, "origin": ORIGIN_FOLLOWER });
            ("POST", "/api/delete".to_string(), payload.to_string().into_bytes())
        }
        MirrorOp::Mkdir(absolute) => {
            let rel = relative_to_root(root, Path::new(&absolute))?;
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let parent = match rel.rfind('/') {
                Some(index) => rel[..index].to_string(),
                None => ".".into(),
            };
            let payload = serde_json::json!({
                "dirPath": parent,
                "name": name,
                "origin": ORIGIN_FOLLOWER,
            });
            (
                "POST",
                "/api/create-folder".to_string(),
                payload.to_string().into_bytes(),
            )
        }
        MirrorOp::Rename { from, to } => {
            let rel = relative_to_root(root, Path::new(&from))?;
            let name = Path::new(&to)
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .ok_or_else(|| "名称不合法".to_string())?;
            let payload = serde_json::json!({
                "path": rel,
                "name": name,
                "origin": ORIGIN_FOLLOWER,
            });
            ("POST", "/api/rename".to_string(), payload.to_string().into_bytes())
        }
    };
    let bytes = http_exchange(
        &host,
        port,
        method,
        &path,
        &token,
        Some(body),
        Duration::from_secs(20),
    )
    .await?;
    let envelope: ApiEnvelope<serde_json::Value> =
        serde_json::from_slice(&bytes).map_err(|err| err.to_string())?;
    if envelope.ok {
        Ok(())
    } else {
        Err(envelope.error.unwrap_or_else(|| "回传失败".into()))
    }
}

#[tauri::command]
pub fn sync_info(hub: tauri::State<'_, SyncHub>) -> SyncInfo {
    hub.info()
}

#[tauri::command]
pub fn sync_set_workspace(hub: tauri::State<'_, SyncHub>, path: Option<String>) {
    hub.set_root(path);
}

#[tauri::command]
pub fn sync_set_sharing(hub: tauri::State<'_, SyncHub>, enabled: bool) {
    hub.set_sharing(enabled);
}

#[tauri::command]
pub fn sync_discover(hub: tauri::State<'_, SyncHub>) -> Vec<DiscoveredPeer> {
    current_peers(&hub)
}

#[tauri::command]
pub async fn sync_follow(
    hub: tauri::State<'_, SyncHub>,
    host: String,
    port: u16,
    token: String,
) -> Result<FollowReport, String> {
    if hub.inner.sharing.load(Ordering::SeqCst) {
        return Err("本机正在对外同步。要接收对方的笔记，请先停止同步。".into());
    }
    let host = host.trim().to_string();
    if host.is_empty() || port == 0 || token.len() < 16 {
        return Err("同步地址无效".into());
    }
    hub.inner.ensure_root()?;
    let key = follow_key(&host, port, &token);
    if hub.inner.follow_target.lock().unwrap().as_deref() == Some(key.as_str()) {
        return Ok(FollowReport {
            following: true,
            pulled: false,
            files: 0,
            name: String::new(),
        });
    }
    let generation = hub.inner.follow_gen.fetch_add(1, Ordering::SeqCst) + 1;
    *hub.inner.follow_target.lock().unwrap() = Some(key);
    let pulled = pull_bundle(&HubHandle(hub.inner.clone()), &host, port, &token).await;
    if hub.inner.follow_gen.load(Ordering::SeqCst) != generation {
        return Err("同步已取消".into());
    }
    let (name, seq, files) = match pulled {
        Ok(value) => value,
        Err(err) => {
            hub.inner.stop_follower();
            return Err(err);
        }
    };
    hub.inner.publish("reload", None, None, ORIGIN_REMOTE);
    let task_hub = HubHandle(hub.inner.clone());
    tauri::async_runtime::spawn(async move {
        follow_after_pull(task_hub, host, port, token, generation, seq).await;
    });
    Ok(FollowReport {
        following: true,
        pulled: true,
        files,
        name,
    })
}

async fn follow_after_pull(
    hub: HubHandle,
    host: String,
    port: u16,
    token: String,
    generation: u64,
    mut since: u64,
) {
    loop {
        if hub.0.follow_gen.load(Ordering::SeqCst) != generation || hub.0.sharing.load(Ordering::SeqCst)
        {
            break;
        }
        match http_exchange(
            &host,
            port,
            "GET",
            &format!("/api/wait?since={since}"),
            &token,
            None,
            Duration::from_secs(25),
        )
        .await
        {
            Ok(bytes) => {
                let Ok(envelope) = serde_json::from_slice::<ApiEnvelope<WaitBody>>(&bytes) else {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                };
                let Some(body) = envelope.data else {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                };
                for event in body.events {
                    if hub.0.follow_gen.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    since = since.max(event.id);
                    if event.origin == ORIGIN_FOLLOWER {
                        continue;
                    }
                    if let Err(err) = apply_remote_event(&hub, &host, port, &token, &event).await {
                        eprintln!("应用同步变更失败: {err}");
                    }
                }
                since = since.max(body.seq);
            }
            Err(err) => {
                eprintln!("同步连接中断: {err}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::push_rel;
    use std::path::Path;

    #[test]
    fn push_rel_rejects_parent_segments() {
        let root = Path::new("/tmp/tigermark-workspace");
        assert!(push_rel(root, "../secret").is_err());
        assert!(push_rel(root, "notes/../../secret").is_err());
        assert!(push_rel(root, "").is_err());
        assert_eq!(
            push_rel(root, "notes/a.md").unwrap(),
            root.join("notes").join("a.md")
        );
        assert_eq!(
            push_rel(root, "白板.board.json").unwrap(),
            root.join("白板.board.json")
        );
    }
}
