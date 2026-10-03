use std::fs;
use std::io::Write;
use std::net::TcpListener as StdTcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::commands::{
    initial_file_content, new_file_name, read_tree_relative, safe_entry_name,
};

const PORT: u16 = 47321;
const ORIGIN_DESKTOP: &str = "desktop";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
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
    pub workspace_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Inner {
    root: Mutex<Option<PathBuf>>,
    token: String,
    port: u16,
    error: Mutex<Option<String>>,
    clients: Arc<AtomicUsize>,
    tx: broadcast::Sender<SyncEvent>,
    app: AppHandle,
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

    fn publish(&self, kind: &str, path: Option<String>, from: Option<String>, origin: &str) {
        let event = SyncEvent {
            kind: kind.to_string(),
            path,
            from,
            name: self.workspace_name(),
            origin: origin.to_string(),
        };
        let _ = self.tx.send(event.clone());
        let _ = self.app.emit("sync:event", &event);
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
            clients: self.inner.clients.load(Ordering::SeqCst),
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
    });
    if let Some(std_listener) = listener {
        let handle = HubHandle(inner.clone());
        tauri::async_runtime::spawn(async move {
            if let Err(err) = serve(std_listener, handle).await {
                eprintln!("局域网同步服务退出: {err}");
            }
        });
    }
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
    let content = body.content;
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::write(path, content).map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(Ok(())) => {
            hub.0
                .publish("write", Some(hub.0.to_rel(&rel)), None, &origin);
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

#[tauri::command]
pub fn sync_info(hub: tauri::State<'_, SyncHub>) -> SyncInfo {
    hub.info()
}

#[tauri::command]
pub fn sync_set_workspace(hub: tauri::State<'_, SyncHub>, path: Option<String>) {
    hub.set_root(path);
}
