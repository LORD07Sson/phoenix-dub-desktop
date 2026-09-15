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
use tauri_plugin_store::StoreExt;

// Репозиторий публичный — GithubSource читает releases напрямую через
// GitHub API (без токена, лимит 60 запросов/час на IP — с запасом для
// студийного инструмента), прокси на своём сервере не нужен.
const UPDATE_REPO_URL: &str = "https://github.com/LORD07Sson/phoenix-dub-desktop";

// Канал обновлений — та же настройка Velopack, что описана в
// docs.velopack.io/packaging/channels: сборки альфа-канала публикует
// отдельный workflow на каждый push в main (build-alpha.yml), без
// правки VERSION — обычный build.yml (стабильный канал `win`) остаётся
// только на реальные релизы. Хранится через tauri-plugin-store (тот же
// плагин уже был зарегистрирован, просто раньше ничем не пользовались).
const SETTINGS_STORE: &str = "settings.json";
const UPDATE_CHANNEL_KEY: &str = "update_channel";
const ALPHA_CHANNEL: &str = "alpha";

#[tauri::command]
fn get_update_channel(app: tauri::AppHandle) -> Result<String, String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    Ok(store
        .get(UPDATE_CHANNEL_KEY)
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "stable".to_string()))
}

#[tauri::command]
fn set_update_channel(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    if channel != "stable" && channel != ALPHA_CHANNEL {
        return Err(format!("Неизвестный канал обновлений: {channel}"));
    }
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set(UPDATE_CHANNEL_KEY, serde_json::json!(channel));
    Ok(())
}

fn velopack_update_manager(app: &tauri::AppHandle) -> Result<velopack::UpdateManager, String> {
    let source = velopack::sources::GithubSource::new(UPDATE_REPO_URL, None, false);
    let channel = get_update_channel(app.clone())?;
    let options = if channel == ALPHA_CHANNEL {
        Some(velopack::UpdateOptions {
            ExplicitChannel: Some(ALPHA_CHANNEL.to_string()),
            ..Default::default()
        })
    } else {
        None
    };
    velopack::UpdateManager::new(source, options, None).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct UpdateInfoOut {
    version: String,
    notes: String,
}

#[tauri::command]
fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfoOut>, String> {
    let um = velopack_update_manager(&app)?;
    match um.check_for_updates().map_err(|e| e.to_string())? {
        velopack::UpdateCheck::UpdateAvailable(info) => Ok(Some(UpdateInfoOut {
            version: info.TargetFullRelease.Version.clone(),
            notes: info.TargetFullRelease.NotesMarkdown.clone(),
        })),
        _ => Ok(None),
    }
}

/// Качает и сразу ставит обновление, перезапуская приложение —
/// `apply_updates_and_restart` завершает текущий процесс сам, эта
/// команда наружу успевает вернуться только в случае ошибки.
/// Прогресс скачивания (0..100) шлётся в JS событием "update-progress",
/// чтобы прогресс-бар в диалоге обновления не стоял на месте на большом
/// файле (сейчас ffmpeg внутри — установщик тяжёлый).
#[tauri::command]
fn download_and_apply_update(app: tauri::AppHandle) -> Result<(), String> {
    let um = velopack_update_manager(&app)?;
    let info = match um.check_for_updates().map_err(|e| e.to_string())? {
        velopack::UpdateCheck::UpdateAvailable(info) => *info,
        _ => return Err("Обновление больше не доступно — кто-то уже обновился раньше вас?".into()),
    };

    let (tx, rx) = std::sync::mpsc::channel::<i16>();
    let progress_app = app.clone();
    std::thread::spawn(move || {
        for pct in rx {
            let _ = progress_app.emit("update-progress", pct);
        }
    });

    um.download_updates(&info, Some(tx)).map_err(|e| e.to_string())?;
    um.apply_updates_and_restart(&info.TargetFullRelease).map_err(|e| e.to_string())?;
    Ok(())
}

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

// Тот же хост, что и API_BASE в dist/app/api.js — держать в синхроне
// руками, если он когда-нибудь сменится (не тянем сюда JS-константу,
// у Rust-стороны и так уже есть свой захардкоженный UPDATE_REPO_URL —
// тот же принцип: несколько мест, где живёт "адрес прода", это
// осознанный компромисс маленького проекта без общего конфига).
const API_BASE: &str = "https://minitg.shitstudent.com:8443/api";

/// Файл, перетащенный из проводника (см. dist/app/file-drop.js,
/// onDragDropEvent отдаёт только путь на диске, не байты) — читаем его
/// здесь, в Rust, и сами шлём multipart-запросом на
/// /api/report/{id}/files/upload, а не через JS/fetch: так не нужен
/// tauri-plugin-fs со capability-скоупом на произвольный путь на диске
/// (drag&drop даёт путь ЛЮБОГО файла пользователя, не только из
/// appdata/temp, куда обычно и ограничивают fs-плагин).
#[tauri::command]
async fn upload_report_file(report_id: String, file_path: String, init_data: String) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&file_path);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());

    // std::fs::read (блокирующий), не tokio::fs — не тащим отдельно
    // зависимость на tokio ради одного чтения файла; та же цена, что
    // и у синхронного qc_analyze выше.
    let bytes = std::fs::read(&file_path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;

    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
    let form = reqwest::multipart::Form::new().part("file", part);

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{API_BASE}/report/{report_id}/files/upload"))
        .header("X-Init-Data", init_data)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Не удалось отправить файл: {e}"))?;

    if !resp.status().is_success() {
        let detail = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
            .unwrap_or_else(|| "сервер отклонил файл".to_string());
        return Err(detail);
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Некорректный ответ сервера: {e}"))
}

fn main() {
    // Должен быть самой первой инструкцией в main() — Velopack иногда
    // перезапускает/завершает процесс сам для служебных операций
    // (первичная установка, применение обновления и т.п.), до того как
    // остальной код приложения вообще успеет пойти.
    velopack::VelopackApp::build().run();

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
            check_for_update,
            download_and_apply_update,
            upload_report_file,
            get_update_channel,
            set_update_channel,
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
