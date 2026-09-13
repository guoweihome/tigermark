mod commands;
mod menu;
mod updater;

use std::sync::atomic::Ordering;

use commands::CloseState;
use tauri::{Emitter, Manager, WindowEvent};

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
        ])
        .setup(|app| {
            let handle = app.handle();
            let menu = menu::build_menu(handle)?;
            app.set_menu(menu)?;
            apply_window_effects(handle);
            updater::setup_auto_updater(handle.clone());
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::handle_menu_event(app, event.id().as_ref());
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let allowed = window
                    .state::<CloseState>()
                    .allow_close
                    .load(Ordering::SeqCst);
                if !allowed {
                    api.prevent_close();
                    let _ = window.emit("window:close-request", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running TigerMark");
}

fn apply_window_effects(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        let _ = window.set_effects(
            EffectsBuilder::new()
                .effect(Effect::UnderWindowBackground)
                .state(EffectState::FollowsWindowActiveState)
                .build(),
        );
    }

    #[cfg(target_os = "windows")]
    {
        use tauri::window::{Effect, EffectsBuilder};
        let _ = window.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build());
    }

    let _ = window;
}
