use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State};
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

fn last_file(app: &tauri::AppHandle) -> Option<String> {
    let path = fs::read_to_string(last_file_ptr(app)).ok()?;
    let path = path.trim().to_string();
    if path.is_empty() || !PathBuf::from(&path).exists() {
        return None;
    }
    Some(path)
}

/* ---------------- file access allowlist ---------------- */

/// Paths the user has handed to the app through a native file dialog in this session.
///
/// The file commands below take a path from the webview, and the webview renders content
/// from `.novel` files that may come from anyone. So that a script smuggled in through such a
/// file cannot read or overwrite arbitrary files, every path-taking command only accepts a
/// path the user chose in a dialog, or one they opened in an earlier session (the recent
/// list and the last file, which only ever receive paths that passed this check).
#[derive(Default)]
struct GrantedPaths(Mutex<HashSet<PathBuf>>);

impl GrantedPaths {
    fn grant(&self, path: &Path) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(path_key(path));
    }

    fn contains(&self, key: &Path) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(key)
    }
}

/// Comparison key for a path: the canonical path, or for a file that does not exist yet (a
/// Save-As target) its canonical parent joined with the file name. `..` segments and
/// symlinked directories therefore cannot dress up a different file as a granted one.
fn path_key(path: &Path) -> PathBuf {
    if let Ok(p) = path.canonicalize() {
        return p;
    }
    match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => {
            let dir = if dir.as_os_str().is_empty() {
                Path::new(".")
            } else {
                dir
            };
            dir.canonicalize()
                .unwrap_or_else(|_| dir.to_path_buf())
                .join(name)
        }
        _ => path.to_path_buf(),
    }
}

/// Whether `key` (see `path_key`) may be read or written: granted in this session, or one
/// of the paths remembered from earlier sessions.
fn is_allowed(granted: &GrantedPaths, key: &Path, remembered: &[String]) -> bool {
    granted.contains(key) || remembered.iter().any(|p| path_key(Path::new(p)) == key)
}

fn check_path(
    app: &tauri::AppHandle,
    granted: &GrantedPaths,
    path: &str,
) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err("no path given".into());
    }
    let p = PathBuf::from(path);
    let key = path_key(&p);
    if granted.contains(&key) {
        return Ok(p);
    }
    let mut remembered = read_recent(app);
    remembered.extend(last_file(app));
    if is_allowed(granted, &key, &remembered) {
        granted.grant(&p);
        return Ok(p);
    }
    Err(format!(
        "access denied: {path} was not chosen in a file dialog"
    ))
}

fn base_name(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

/* ---------------- commands ---------------- */

// The dialogs are async commands: synchronous commands run on the main thread, where the
// dialog plugin's blocking_* calls must not be used (they wait for the event loop that the
// main thread is supposed to be running). The blocking call happens on a worker thread.
// Each dialog is parented to the window, as the plugin's own commands do, so it stays modal
// (Windows) or a sheet (macOS) instead of leaving the editor usable underneath; the
// frontend additionally shields the window while a dialog is pending (pickPath in app.js).
#[tauri::command]
async fn pick_open(
    app: tauri::AppHandle,
    window: tauri::Window,
    granted: State<'_, GrantedPaths>,
) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        #[allow(unused_mut)]
        let mut dialog = app.dialog().file();
        #[cfg(any(windows, target_os = "macos"))]
        {
            dialog = dialog.set_parent(&window);
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = &window;
        dialog
            .add_filter("NovelCraft project", &["novel"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(p) = &picked {
        granted.grant(p);
    }
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn pick_save(
    app: tauri::AppHandle,
    window: tauri::Window,
    granted: State<'_, GrantedPaths>,
    default_name: String,
) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let ext = default_name
            .rsplit('.')
            .next()
            .unwrap_or("novel")
            .to_string();
        app.dialog()
            .file()
            .set_parent(&window)
            .set_file_name(&default_name)
            .add_filter("File", &[ext.as_str()])
            .add_filter("All files", &["*"])
            .blocking_save_file()
            .and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(p) = &picked {
        granted.grant(p);
    }
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

// The read/write commands stay synchronous on purpose: running on the main thread keeps
// them in call order, and the frontend relies on a later save never being overtaken by an
// earlier one.
#[tauri::command]
fn read_text(
    app: tauri::AppHandle,
    granted: State<'_, GrantedPaths>,
    path: String,
) -> Result<String, String> {
    let path = check_path(&app, &granted, &path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write via a temporary file in the same directory, flushed to disk, then renamed over the
/// target: a crash or power loss leaves either the old file or the new one, never a torn
/// or empty one. The temporary file is removed if anything fails.
fn atomic_write(target: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new(""));
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let temp_path = dir.join(format!(
        ".~tmp_{}_{}.tmp",
        epoch.as_secs(),
        epoch.subsec_nanos()
    ));

    let written = fs::File::create(&temp_path).and_then(|mut f| {
        f.write_all(contents.as_ref())?;
        f.sync_all()
    });
    if let Err(e) = written.and_then(|_| fs::rename(&temp_path, target)) {
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
fn write_text(
    app: tauri::AppHandle,
    granted: State<'_, GrantedPaths>,
    path: String,
    content: String,
) -> Result<(), String> {
    let path = check_path(&app, &granted, &path)?;
    atomic_write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_last_file(app: tauri::AppHandle) -> Option<String> {
    last_file(&app)
}

#[tauri::command]
fn set_last_file(
    app: tauri::AppHandle,
    granted: State<'_, GrantedPaths>,
    path: String,
) -> Result<(), String> {
    check_path(&app, &granted, &path)?;
    atomic_write(&last_file_ptr(&app), path).map_err(|e| e.to_string())
}

#[tauri::command]
fn autosave(app: tauri::AppHandle, content: String) -> Result<(), String> {
    atomic_write(&working_file(&app), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_autosave(app: tauri::AppHandle) -> Result<String, String> {
    fs::read_to_string(working_file(&app)).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_autosave(app: tauri::AppHandle) -> Result<(), String> {
    let p = working_file(&app);
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

/// Write a binary file (EPUB / DOCX / images) from a base64-encoded payload.
#[tauri::command]
fn write_binary(
    app: tauri::AppHandle,
    granted: State<'_, GrantedPaths>,
    path: String,
    base64: String,
) -> Result<(), String> {
    let path = check_path(&app, &granted, &path)?;
    let bytes = b64_decode(&base64).ok_or_else(|| "invalid base64".to_string())?;
    atomic_write(&path, bytes).map_err(|e| e.to_string())
}

/// Minimal standard-base64 decoder (avoids pulling in an extra crate).
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' {
            continue;
        }
        let v = val(c)?;
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
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
fn add_recent_file(
    app: tauri::AppHandle,
    granted: State<'_, GrantedPaths>,
    path: String,
) -> Result<(), String> {
    check_path(&app, &granted, &path)?;
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
            &MenuItem::with_id(app, "compile", "Compile Novel…", true, None::<&str>)?,
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
        .manage(GrantedPaths::default())
        .setup(|app| {
            let handle = app.handle();
            // The native "Open Recent" submenu is built once, from the recent list as it is
            // now; its entries must stay openable even after newer files push them out of
            // recent.json. (Menu event payloads themselves are never trusted for this.)
            let granted = app.state::<GrantedPaths>();
            for p in read_recent(handle).into_iter().chain(last_file(handle)) {
                granted.grant(Path::new(&p));
            }
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
            write_binary,
            get_last_file,
            set_last_file,
            autosave,
            read_autosave,
            clear_autosave,
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

#[cfg(test)]
mod tests;
