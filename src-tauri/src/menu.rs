use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::{open_website, show_about};
use crate::updater::check_for_updates;

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open-directory", "打开文件夹…", true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, "save", "保存", true, Some("CmdOrCtrl+S"))?;
    let view_edit = MenuItem::with_id(app, "view-edit", "仅编辑", true, Some("CmdOrCtrl+1"))?;
    let view_split = MenuItem::with_id(app, "view-split", "分屏", true, Some("CmdOrCtrl+2"))?;
    let view_preview = MenuItem::with_id(app, "view-preview", "仅预览", true, Some("CmdOrCtrl+3"))?;
    let toggle_sidebar =
        MenuItem::with_id(app, "toggle-sidebar", "切换侧边栏", true, Some("CmdOrCtrl+B"))?;
    let devtools = MenuItem::with_id(app, "devtools", "开发者工具", true, Some("Alt+CmdOrCtrl+I"))?;
    let website = MenuItem::with_id(app, "website", "官网", true, None::<&str>)?;
    let website_help = MenuItem::with_id(app, "website", "官网", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(app, "check-updates", "检查更新…", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于 TigerMark", true, None::<&str>)?;
    #[allow(unused_variables)]
    let about_help = MenuItem::with_id(app, "about", "关于 TigerMark", true, None::<&str>)?;

    let file = if cfg!(target_os = "macos") {
        Submenu::with_items(
            app,
            "文件",
            true,
            &[
                &open,
                &save,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::close_window(app, Some("关闭"))?,
            ],
        )?
    } else {
        Submenu::with_items(
            app,
            "文件",
            true,
            &[
                &open,
                &save,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, Some("退出"))?,
            ],
        )?
    };

    let find = MenuItem::with_id(app, "find", "查找…", true, Some("CmdOrCtrl+F"))?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &PredefinedMenuItem::separator(app)?,
            &find,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &view_edit,
            &view_split,
            &view_preview,
            &PredefinedMenuItem::separator(app)?,
            &toggle_sidebar,
            &PredefinedMenuItem::separator(app)?,
            &devtools,
            &PredefinedMenuItem::fullscreen(app, Some("全屏"))?,
        ],
    )?;

    let help = if cfg!(target_os = "macos") {
        Submenu::with_items(app, "帮助", true, &[&website_help, &check_updates])?
    } else {
        Submenu::with_items(app, "帮助", true, &[&about_help, &website_help, &check_updates])?
    };

    if cfg!(target_os = "macos") {
        let app_menu = Submenu::with_items(
            app,
            "TigerMark",
            true,
            &[
                &about,
                &website,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        Menu::with_items(app, &[&app_menu, &file, &edit, &view, &help])
    } else {
        Menu::with_items(app, &[&file, &edit, &view, &help])
    }
}

pub fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "open-directory" => {
            let _ = app.emit("menu:open-directory", ());
        }
        "save" => {
            let _ = app.emit("menu:save", ());
        }
        "view-edit" => {
            let _ = app.emit("menu:view-mode", "edit");
        }
        "view-split" => {
            let _ = app.emit("menu:view-mode", "split");
        }
        "view-preview" => {
            let _ = app.emit("menu:view-mode", "preview");
        }
        "toggle-sidebar" => {
            let _ = app.emit("menu:toggle-sidebar", ());
        }
        "find" => {
            let _ = app.emit("menu:find", ());
        }
        "devtools" => {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        }
        "website" => open_website(app),
        "about" => show_about(app),
        "check-updates" => check_for_updates(app.clone(), true),
        _ => {}
    }
}
