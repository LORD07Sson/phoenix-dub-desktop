// PHOENIX DUB Desktop — Tauri-бэкенд.
//
// Фронтенд (dist/) — обычный HTML/CSS/JS, ходит напрямую в тот же REST API,
// что и мини-апп (`miniapp/server.py`), через fetch(). Rust-часть отвечает
// только за то, что веб-странице недоступно: нативное хранилище токена,
// локальный QC звука через ffmpeg, трей, глобальные горячие клавиши,
// автозапуск и системные уведомления.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_qc;
mod token_store;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[tauri::command]
fn qc_analyze(path: String) -> Result<audio_qc::QcReport, String> {
    audio_qc::analyze(&path)
}

#[tauri::command]
fn token_save(token: String) -> Result<(), String> {
    token_store::save(&token)
}

#[tauri::command]
fn token_load() -> Option<String> {
    token_store::load()
}

#[tauri::command]
fn token_clear() -> Result<(), String> {
    token_store::clear()
}

#[tauri::command]
async fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn is_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // Второй запуск (ярлык, автозапуск + ручной старт и т.п.) не должен
        // плодить второй процесс — вместо этого просто разворачиваем уже
        // работающее окно. Должен регистрироваться самым первым плагином.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
                if shortcut == &toggle {
                    if let Some(win) = app.get_webview_window("main") {
                        let visible = win.is_visible().unwrap_or(false);
                        if visible {
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                }
            }
        }).build())
        .invoke_handler(tauri::generate_handler![
            qc_analyze,
            token_save,
            token_load,
            token_clear,
            set_autostart,
            is_autostart,
        ])
        .setup(|app| {
            // Глобальная горячая клавиша — свернуть/показать окно из любого места (Ctrl+Shift+P).
            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
            app.global_shortcut().register(toggle)?;

            // Иконка в трее с меню — открыть/скрыть окно и выйти по-настоящему.
            let show_i = MenuItem::with_id(app, "show", "Открыть", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let visible = win.is_visible().unwrap_or(false);
                            if visible {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Крестик у окна — сворачиваем в трей вместо закрытия (опрос
            // уведомлений на JS-стороне продолжает идти, пока процесс жив).
            let win = app.get_webview_window("main").unwrap();
            let win_clone = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win_clone.hide();
                }
            });

            Ok(())
        })
        .on_menu_event(|_app, _event| {})
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Реэкспорт события для фронтенда — тип уведомления "новый отчёт назначен" /
// "просрочка", шлётся из JS через emit, слушается тем же JS в других окнах
// при необходимости (сейчас окно одно, задел на будущее).
#[allow(dead_code)]
fn broadcast(app: &tauri::AppHandle, event: &str, payload: serde_json::Value) {
    let _ = app.emit(event, payload);
}
