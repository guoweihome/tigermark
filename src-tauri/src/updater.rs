use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

fn show_info(app: &AppHandle, title: &str, message: impl Into<String>) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

fn show_error(app: &AppHandle, detail: impl Into<String>) {
    app.dialog()
        .message(detail)
        .title("检查更新失败")
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

async fn confirm(app: &AppHandle, title: &str, message: &str, ok: &str, cancel: &str) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            ok.to_string(),
            cancel.to_string(),
        ))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });
    rx.await.unwrap_or(false)
}

pub fn check_for_updates(app: AppHandle, from_menu: bool) {
    tauri::async_runtime::spawn(async move {
        if cfg!(debug_assertions) {
            if from_menu {
                show_info(
                    &app,
                    "检查更新",
                    format!(
                        "开发模式不会自动更新\n当前版本 {}",
                        app.package_info().version
                    ),
                );
            }
            return;
        }

        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(err) => {
                if from_menu {
                    show_error(&app, format!("暂时无法检查更新\n{err}"));
                }
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let accepted = confirm(
                    &app,
                    "发现新版本",
                    &format!("TigerMark {version} 已发布\n下载完成后可以重启安装。当前编辑中的文件请先保存。"),
                    "立即更新",
                    "稍后",
                )
                .await;
                if !accepted {
                    return;
                }
                if let Err(err) = update.download_and_install(|_, _| {}, || {}).await {
                    show_error(&app, format!("暂时无法检查更新\n{err}"));
                    return;
                }
                let restart = confirm(
                    &app,
                    "更新已就绪",
                    &format!("新版本 {version} 已下载完成\n重启后完成安装。未保存的更改会先提示保存。"),
                    "立即重启",
                    "稍后",
                )
                .await;
                if restart {
                    app.restart();
                }
            }
            Ok(None) => {
                if from_menu {
                    show_info(
                        &app,
                        "检查更新",
                        format!("已是最新版本\n当前版本 {}", app.package_info().version),
                    );
                }
            }
            Err(err) => {
                if from_menu {
                    show_error(&app, format!("暂时无法检查更新\n{err}"));
                }
            }
        }
    });
}

pub fn setup_auto_updater(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        check_for_updates(app, false);
    });
}
