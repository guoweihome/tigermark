mod commands;
#[cfg(desktop)]
mod menu;
mod sync;
#[cfg(desktop)]
mod updater;

use commands::CloseState;
use tauri::{Emitter, Manager, Runtime, Url, Webview, WindowEvent};
use tauri_plugin_opener::OpenerExt;

#[cfg(not(target_os = "macos"))]
use std::sync::atomic::Ordering;

fn is_app_navigation(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" | "ipc" | "about" => true,
        "http" | "https" => url.host_str().is_some_and(|host| {
            host == "localhost"
                || host == "127.0.0.1"
                || host == "::1"
                || host.ends_with(".localhost")
        }),
        _ => false,
    }
}

fn external_links<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("external-links")
        .on_navigation(|webview: &Webview<R>, url| {
            if is_app_navigation(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(external_links());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder
        .manage(CloseState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::dialog_open_directory,
            commands::fs_read_directory,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::fs_create_file,
            commands::fs_create_directory,
            commands::fs_delete_path,
            commands::fs_rename_path,
            commands::fs_save_image,
            commands::shell_show_item_in_folder,
            commands::open_external_url,
            commands::theme_set,
            commands::window_close_allow,
            commands::window_close_deny,
            commands::window_hide,
            commands::app_quit,
            sync::sync_info,
            sync::sync_set_workspace,
            sync::sync_set_sharing,
            sync::sync_discover,
            sync::sync_follow,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(sync::start(handle));
            #[cfg(desktop)]
            {
                let handle = app.handle();
                let menu = menu::build_menu(handle)?;
                app.set_menu(menu)?;
            }
            Ok(())
        });

    #[cfg(desktop)]
    let builder = builder.on_menu_event(|app, event| {
        menu::handle_menu_event(app, event.id().as_ref());
    });

    builder
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    let _ = window.emit("window:hide-request", ());
                    return;
                }

                #[cfg(not(target_os = "macos"))]
                {
                    let allowed = window
                        .state::<CloseState>()
                        .allow_close
                        .load(Ordering::SeqCst);
                    if !allowed {
                        api.prevent_close();
                        let _ = window.emit("window:close-request", ());
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building TigerMark")
        .run(|app, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
        });
}

