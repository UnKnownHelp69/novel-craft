use std::fs;
use std::path::PathBuf;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// Resolve (and create) the app config directory.
fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn last_file_ptr(app: &tauri::AppHandle) -> PathBuf {
    config_dir(app).join("last_file.txt")
}

fn working_file(app: &tauri::AppHandle) -> PathBuf {
    config_dir(app).join("working.novel")
}

fn recent_path(app: &tauri::AppHandle) -> PathBuf {
    config_dir(app).join("recent.json")
}

fn read_recent(app: &tauri::AppHandle) -> Vec<String> {
    fs::read_to_string(recent_path(app))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| PathBuf::from(p).exists())
        .collect()
}

fn base_name(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

/* ---------------- commands ---------------- */

#[tauri::command]
fn pick_open(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .add_filter("NovelCraft project", &["novel"])
        .add_filter("All files", &["*"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn pick_save(app: tauri::AppHandle, default_name: String) -> Option<String> {
    let ext = default_name.rsplit('.').next().unwrap_or("novel").to_string();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("File", &[ext.as_str()])
        .add_filter("All files", &["*"])
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_last_file(app: tauri::AppHandle) -> Option<String> {
    let ptr = last_file_ptr(&app);
    let path = fs::read_to_string(ptr).ok()?;
    let path = path.trim().to_string();
    if path.is_empty() || !PathBuf::from(&path).exists() {
        return None;
    }
    Some(path)
}

#[tauri::command]
fn set_last_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    fs::write(last_file_ptr(&app), path).map_err(|e| e.to_string())
}

#[tauri::command]
fn autosave(app: tauri::AppHandle, content: String) -> Result<(), String> {
    fs::write(working_file(&app), content).map_err(|e| e.to_string())
}

/* ---------------- window controls ---------------- */

#[tauri::command]
fn minimize_window(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn maximize_window(window: tauri::Window) {
    let _ = window.maximize();
}

#[tauri::command]
fn unmaximize_window(window: tauri::Window) {
    let _ = window.unmaximize();
}

/// Destroy the window without re-emitting a CloseRequested event
/// (the frontend has already handled the unsaved-changes dialog).
#[tauri::command]
fn close_window(window: tauri::Window) {
    let _ = window.destroy();
}

#[tauri::command]
fn is_maximized(window: tauri::Window) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn set_decorations(window: tauri::Window, on: bool) {
    let _ = window.set_decorations(on);
}

#[tauri::command]
fn set_window_title(window: tauri::Window, title: String) {
    let _ = window.set_title(&format!("NovelCraft — {}", title));
}

/* ---------------- recent files ---------------- */

#[tauri::command]
fn get_recent_files(app: tauri::AppHandle) -> Vec<String> {
    read_recent(&app)
}

#[tauri::command]
fn add_recent_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut list = read_recent(&app);
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(5);
    fs::write(
        recent_path(&app),
        serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()),
    )
    .map_err(|e| e.to_string())
}

/* ---------------- menu ---------------- */

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // "Open Recent" submenu, populated from recent.json at launch
    let recent = read_recent(app);
    let recent_items: Vec<MenuItem<tauri::Wry>> = if recent.is_empty() {
        vec![MenuItem::with_id(
            app,
            "recent_none",
            "No recent files",
            false,
            None::<&str>,
        )?]
    } else {
        recent
            .iter()
            .map(|p| {
                MenuItem::with_id(app, format!("recent:{}", p), base_name(p), true, None::<&str>)
            })
            .collect::<tauri::Result<Vec<_>>>()?
    };
    let recent_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        recent_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let open_recent = Submenu::with_items(app, "Open Recent", true, &recent_refs)?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new", "New Novel", true, None::<&str>)?,
            &MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?,
            &open_recent,
            &MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(app, "save_as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "export_txt", "Export as TXT", true, None::<&str>)?,
            &MenuItem::with_id(app, "export_html", "Export as HTML", true, None::<&str>)?,
            &MenuItem::with_id(app, "export_md", "Export as Markdown", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit"))?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Cut"))?,
            &PredefinedMenuItem::copy(app, Some("Copy"))?,
            &PredefinedMenuItem::paste(app, Some("Paste"))?,
            &PredefinedMenuItem::select_all(app, Some("Select All"))?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "toggle_focus", "Toggle Focus Mode", true, Some("CmdOrCtrl+Shift+F"))?,
            &MenuItem::with_id(app, "toggle_panels", "Toggle Side Panels", true, None::<&str>)?,
        ],
    )?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[&MenuItem::with_id(app, "about", "About NovelCraft", true, None::<&str>)?],
    )?;

    Menu::with_items(app, &[&file, &edit, &view, &help])
}

/* ---------------- run ---------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let handle = app.handle();
            let menu = build_menu(handle)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            pick_open,
            pick_save,
            read_text,
            write_text,
            get_last_file,
            set_last_file,
            autosave,
            minimize_window,
            maximize_window,
            unmaximize_window,
            close_window,
            is_maximized,
            set_decorations,
            set_window_title,
            get_recent_files,
            add_recent_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running NovelCraft");
}
