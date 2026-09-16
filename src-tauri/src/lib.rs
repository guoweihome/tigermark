mod commands;
mod menu;
mod updater;

use commands::CloseState;
use tauri::{Emitter, Manager, WindowEvent};

#[cfg(not(target_os = "macos"))]
use std::sync::atomic::Ordering;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            commands::theme_set,
            commands::window_close_allow,
            commands::window_close_deny,
            commands::window_hide,
            commands::app_quit,
        ])
        .setup(|app| {
            let handle = app.handle();
            let menu = menu::build_menu(handle)?;
            app.set_menu(menu)?;
            updater::setup_auto_updater(handle.clone());
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_menu_event(app, event.id().as_ref());
        })
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

