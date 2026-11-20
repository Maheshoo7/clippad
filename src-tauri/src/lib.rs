//! ClipPad — thin Tauri shell.
//!
//! Registers the official Tauri plugins (global shortcut, store,
//! autostart), sets platform window policy, runs the native clipboard
//! watcher (`clipwatch`) which writes straight into the SQLite history
//! (`store`), and exposes small commands. The TypeScript frontend renders
//! history and sends edits; the database is the source of truth.

use tauri::Manager;

mod clipwatch;
mod store;
mod traypet;

use store::{History, Listing};
use traypet::Pet;

#[tauri::command]
fn history_list(history: tauri::State<'_, History>) -> Result<Listing, String> {
    history.list()
}

#[tauri::command]
fn history_version(history: tauri::State<'_, History>) -> u64 {
    history.version()
}

#[tauri::command]
fn history_set_pinned(
    app: tauri::AppHandle,
    history: tauri::State<'_, History>,
    id: String,
    pinned: bool,
) -> Result<u64, String> {
    let v = history.set_pinned(&id, pinned)?;
    traypet::poke(&app, if pinned { Pet::Pinned } else { Pet::Unpinned });
    Ok(v)
}

#[tauri::command]
fn history_delete(
    app: tauri::AppHandle,
    history: tauri::State<'_, History>,
    id: String,
) -> Result<u64, String> {
    let v = history.delete(&id)?;
    traypet::poke(&app, Pet::Deleted);
    Ok(v)
}

#[tauri::command]
fn history_clear(app: tauri::AppHandle, history: tauri::State<'_, History>) -> Result<u64, String> {
    let v = history.clear_unpinned()?;
    traypet::poke(&app, Pet::Deleted);
    Ok(v)
}

#[tauri::command]
fn history_set_limit(history: tauri::State<'_, History>, limit: i64) -> Result<u64, String> {
    history.set_limit(limit)
}

/// Quit ClipPad. The app has no Dock icon, so the frontend exposes this
/// as the user-facing way to exit.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Mouse cursor location in global screen *points* (top-left origin), the
/// same space as each monitor's `position / scaleFactor`. The frontend uses
/// it to find the monitor the user is on — tray-click rects and monitor
/// positions are each scaled by a *different* monitor's scale factor, so
/// they can't be compared directly on mixed-DPI (laptop + external) setups.
#[tauri::command]
fn cursor_point() -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;
        #[repr(C)]
        struct CGPoint {
            x: f64,
            y: f64,
        }
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventCreate(source: *const c_void) -> *mut c_void;
            fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFRelease(cf: *const c_void);
        }
        // SAFETY: CGEventCreate(NULL) returns an owned event (or NULL);
        // we read its location and release it.
        unsafe {
            let ev = CGEventCreate(std::ptr::null());
            if ev.is_null() {
                return None;
            }
            let p = CGEventGetLocation(ev);
            CFRelease(ev);
            Some((p.x, p.y))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

// ---- Launch at login ----
//
// macOS 13+: register the app itself via SMAppService, so ClipPad appears in
// System Settings → General → Login Items → "Open at Login" and macOS shows
// its own "Login Item Added" notification. Older macOS and other platforms
// fall back to tauri-plugin-autostart (a LaunchAgent plist on macOS).

#[cfg(target_os = "macos")]
mod login_item {
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    /// SMAppService exists only on macOS 13+; probe the class at runtime.
    pub fn available() -> bool {
        objc2::runtime::AnyClass::get(c"SMAppService").is_some()
    }

    pub fn status() -> SMAppServiceStatus {
        unsafe { SMAppService::mainAppService().status() }
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let svc = unsafe { SMAppService::mainAppService() };
        let res = unsafe {
            if enabled {
                svc.registerAndReturnError()
            } else {
                svc.unregisterAndReturnError()
            }
        };
        res.map_err(|e| e.localizedDescription().to_string())
    }

    pub fn open_settings() {
        unsafe { SMAppService::openSystemSettingsLoginItems() }
    }
}

/// "enabled" | "disabled" | "requires-approval"
#[tauri::command]
fn login_item_status(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    if login_item::available() {
        use objc2_service_management::SMAppServiceStatus as S;
        return Ok(match login_item::status() {
            S::Enabled => "enabled",
            S::RequiresApproval => "requires-approval",
            _ => "disabled",
        }
        .into());
    }
    use tauri_plugin_autostart::ManagerExt;
    let on = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
    Ok(if on { "enabled" } else { "disabled" }.into())
}

/// Turn launch-at-login on/off; returns the resulting status string.
#[tauri::command]
fn set_login_item(app: tauri::AppHandle, enabled: bool) -> Result<String, String> {
    use tauri_plugin_autostart::ManagerExt;
    #[cfg(target_os = "macos")]
    if login_item::available() {
        // Drop the LaunchAgent plist older builds created, so the app
        // doesn't end up with two launch mechanisms.
        if app.autolaunch().is_enabled().unwrap_or(false) {
            let _ = app.autolaunch().disable();
        }
        login_item::set(enabled)?;
        let status = login_item_status(app)?;
        if enabled && status == "requires-approval" {
            login_item::open_settings();
        }
        return Ok(status);
    }
    if enabled {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())?;
    }
    login_item_status(app)
}

/// Put the panel at status-bar level, like a native menu-bar popover.
/// macOS pushes ordinary (incl. floating, always-on-top) windows below the
/// menu bar, which forced a ~30px gap under the tray icon: the window's top
/// band holds the popover arrow and the cat. At this level the band may
/// overlap the menu bar, so the arrow can sit right under the icon.
#[cfg(target_os = "macos")]
fn float_above_menu_bar(w: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    const NS_STATUS_WINDOW_LEVEL: isize = 25;
    let Ok(ptr) = w.ns_window() else { return };
    // SAFETY: called from setup on the main thread; ptr is this window's
    // live NSWindow (checked for null).
    unsafe {
        if let Some(ns) = (ptr as *mut AnyObject).as_ref() {
            let _: () = msg_send![ns, setLevel: NS_STATUS_WINDOW_LEVEL];
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            history_list,
            history_version,
            history_set_pinned,
            history_delete,
            history_clear,
            history_set_limit,
            clipwatch::history_copy,
            clipwatch::set_capture_images,
            traypet::tray_pet,
            quit_app,
            cursor_point,
            login_item_status,
            set_login_item
        ])
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // "Invisible until summoned": no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let dir = app.path().app_data_dir()?;
            let history = History::open_or_recover(&dir.join("history.sqlite"));
            history.import_legacy_json(&dir.join("clippad-history.json"));
            app.manage(history);
            clipwatch::start(app.handle());
            traypet::start(app.handle());
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("main") {
                float_above_menu_bar(&w);
            }
            Ok(())
        })
        // The kitty wakes while the panel is up and dozes off when it hides
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                let ev = if *focused { Pet::Open } else { Pet::Close };
                traypet::poke(window.app_handle(), ev);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ClipPad");
}
