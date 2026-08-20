//! Tauri desktop entry point and plugin/command registration.

#[cfg(desktop)]
mod backend;
#[cfg(desktop)]
mod backend_download;
#[cfg(desktop)]
mod external_link;
#[cfg(mobile)]
mod mobile_runtime;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod updates;

#[cfg(desktop)]
use tauri::{Manager, RunEvent, WebviewWindow, WindowEvent};

/// Opens the WebView DevTools. Gated by the hidden 8-click logo gesture in the
/// frontend so end users cannot open DevTools via the default context menu or
/// keyboard shortcuts in production builds.
#[cfg(desktop)]
#[tauri::command]
fn open_devtools(window: WebviewWindow) {
    window.open_devtools();
}

#[cfg(desktop)]
/// Build the desktop app, wire native plugins/commands, and stop the backend on exit.
pub fn run() {
    let build_result = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(updates::is_remote_update_newer)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            backend_download::download_backend_file,
            backend_download::read_workspace_binary_file,
            backend::backend_port,
            backend::backend_startup_error,
            backend::restart_backend,
            external_link::open_external_link,
            updates::check_desktop_update,
            updates::install_desktop_update,
            updates::download_desktop_update,
            updates::install_downloaded_update,
            updates::check_cached_update,
            tray::minimize_to_tray,
            tray::quit_app,
            tray::set_tray_labels,
            tray::ack_close,
        ])
        .manage(backend::BackendState::default())
        .manage(tray::TrayState::default())
        .setup(|app| {
            backend::setup(app)?;
            tray::setup(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                tray::request_close(window.app_handle());
            }
        })
        .build(tauri::generate_context!());

    match build_result {
        Ok(app) => {
            app.run(|app_handle, event| match event {
                // `code` is `None` only for OS-initiated quits (e.g. macOS
                // Cmd+Q / app menu Quit). On macOS we route those through the
                // same close prompt as the window's red button, so the choice
                // (minimize-to-tray vs. quit) stays consistent with Windows
                // Alt+F4. Programmatic exits from `quit_app` carry a `code` and
                // fall through to the normal shutdown path below.
                RunEvent::ExitRequested { api, code, .. } => {
                    #[cfg(target_os = "macos")]
                    if code.is_none() {
                        api.prevent_exit();
                        // The window may be hidden in the tray; bring it back so
                        // the close prompt is actually visible before asking.
                        tray::show_main_window(app_handle);
                        tray::request_close(app_handle);
                        return;
                    }
                    #[cfg(not(target_os = "macos"))]
                    let _ = (&api, &code);
                    backend::stop(app_handle);
                }
                // macOS emits this when the user clicks the Dock icon. Without
                // it, a window hidden via "minimize to tray" can only be
                // restored from the menu-bar icon, leaving a dead Dock icon.
                #[cfg(target_os = "macos")]
                RunEvent::Reopen { .. } => {
                    tray::show_main_window(app_handle);
                }
                _ => {}
            });
        }
        Err(err) => {
            eprintln!("[QwenPaw Desktop] Fatal startup error: {err}");
            std::process::exit(1);
        }
    }
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
/// Android/iOS run the LensGo product runtime locally and call model providers
/// directly. No Python/QwenPaw server is required for core mobile features.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            mobile_runtime::mobile_load_settings,
            mobile_runtime::mobile_save_settings,
            mobile_runtime::mobile_load_crowd_settings,
            mobile_runtime::mobile_save_crowd_settings,
            mobile_runtime::mobile_fetch_crowd_places,
            mobile_runtime::mobile_test_provider,
            mobile_runtime::mobile_chat,
            mobile_runtime::mobile_test_qwenpaw,
            mobile_runtime::mobile_qwenpaw_chat,
            mobile_runtime::mobile_qwenpaw_latest_itinerary,
            mobile_runtime::mobile_hotel_gateway,
            mobile_runtime::mobile_qwenpaw_route,
            mobile_runtime::mobile_upload_cloud_photo,
            mobile_runtime::mobile_delete_cloud_photo,
            mobile_runtime::mobile_analyze_image,
            mobile_runtime::mobile_generate_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LensGo local mobile runtime");
}
