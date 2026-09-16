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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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
    // Явный save(), а не расчёт на auto-save с дебаунсом: переключили
    // канал и тут же закрыли приложение — отложенная запись могла не
    // успеть долететь до диска, и настройка молча терялась.
    store.save().map_err(|e| e.to_string())
}

fn velopack_update_manager(app: &tauri::AppHandle) -> Result<velopack::UpdateManager, String> {
    let channel = get_update_channel(app.clone())?;
    let is_alpha = channel == ALPHA_CHANNEL;
    // Третий аргумент GithubSource — «смотреть ли на pre-release».
    // Альфа-канал публикуется build-alpha.yml именно как pre-release
    // (vpk upload --pre, тег alpha-latest), поэтому при false альфа-клиент
    // не видел НИ ОДНОГО обновления вообще. Стабильному каналу, наоборот,
    // pre-release не нужны: у альфа-релиза в ассетах лежит только
    // releases.alpha.json, стабильный фид (releases.win.json) там искать
    // бессмысленно — поэтому флаг зависит от выбранного канала.
    let source = velopack::sources::GithubSource::new(UPDATE_REPO_URL, None, is_alpha);
    // AllowVersionDowngrade — иначе переключение обратно на stable
    // после альфы не увидело бы стабильную версию как обновление:
    // "0.5.8-alpha.90" по SemVer СТАРШЕ "0.5.8" (у прешрелиза ниже
    // приоритет, чем у финальной версии с теми же числами), а стабильный
    // канал вообще может не успеть обогнать номер, до которого дошла
    // альфа. Ровно тот сценарий "хочу вернуться на stable без
    // переустановки", который описывает сам ExplicitChannel в докстринге
    // Velopack.
    let options = velopack::UpdateOptions {
        AllowVersionDowngrade: true,
        ExplicitChannel: if is_alpha { Some(ALPHA_CHANNEL.to_string()) } else { None },
        ..Default::default()
    };
    velopack::UpdateManager::new(source, Some(options), None).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct UpdateInfoOut {
    version: String,
    notes: String,
}

// (async) у синхронной функции — это НЕ косметика: команда без async
// выполняется прямо в главном потоке приложения и подвешивает окно на
// всё время работы. Тут внутри сетевой запрос к GitHub, так что без
// этого атрибута «Проверить обновления» морозило интерфейс.
#[tauri::command(async)]
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
///
/// (async) обязателен: без него скачивание идёт в главном потоке, и
/// события "update-progress" из фонового потока не могут быть
/// доставлены в webview до конца команды — прогресс-бар стоял бы на
/// нуле и прыгал сразу в 100%, ровно то, что этот код и должен чинить.
#[tauri::command(async)]
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

// ffmpeg на большом файле работает секундами — в главном потоке это
// замороженное окно на всё время анализа.
#[tauri::command(async)]
fn qc_analyze(path: String) -> Result<audio_qc::QcReport, String> {
    audio_qc::analyze(&path)
}

// Тоже через ffmpeg (полное декодирование в PCM) — на большом файле
// секунды, поэтому (async) по той же причине, что и у qc_analyze выше.
#[tauri::command(async)]
fn generate_waveform(path: String, buckets: u32) -> Result<audio_qc::WaveformData, String> {
    audio_qc::generate_waveform(&path, buckets)
}

// Запускает ffmpeg-субпроцесс и пишет файл на диск — блокирующее.
#[tauri::command(async)]
fn export_audio_clip(path: String, start: f64, end: f64, save_path: String) -> Result<(), String> {
    audio_qc::export_clip(&path, start, end, &save_path)
}

// Обращение к хранилищу учётных данных ОС тоже блокирующее (на Linux —
// синхронный вызов Secret Service по D-Bus).
#[tauri::command(async)]
fn token_save(token: String) -> Result<(), String> {
    token_store::save(&token)
}

#[tauri::command(async)]
fn token_load() -> Option<String> {
    token_store::load()
}

#[tauri::command(async)]
fn token_clear() -> Result<(), String> {
    token_store::clear()
}

// Прогресс пакетного QC (runQcBatch в qc.js) — на иконке в панели
// задач, а не только полоской внутри окна: у студии окно приложения
// часто свёрнуто в трей во время долгого прогона по папке с
// десятком дорожек, а таскбар виден всегда. progress=None гасит
// индикатор — вызывается и по завершении прогона, и если шторку
// закрыли посреди работы (иначе полоска осталась бы висеть на
// иконке до следующего вызова, вводя в заблуждение).
// Не (async): сам вызов — дешёвая нативная операция (Windows: одно
// COM-обращение к ITaskbarList3), в отличие от ffmpeg-субпроцессов
// или сетевых запросов выше блокировать интерфейс ей нечем.
#[tauri::command]
fn set_window_progress(app: tauri::AppHandle, progress: Option<u64>) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or("окно main не найдено")?;
    let status = if progress.is_some() {
        tauri::window::ProgressBarStatus::Normal
    } else {
        tauri::window::ProgressBarStatus::None
    };
    win.set_progress_bar(tauri::window::ProgressBarState {
        status: Some(status),
        progress,
    })
    .map_err(|e| e.to_string())
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

// Тот же хост, что и API_BASE в src/app/api.js — держать в синхроне
// руками, если он когда-нибудь сменится (не тянем сюда JS-константу,
// у Rust-стороны и так уже есть свой захардкоженный UPDATE_REPO_URL —
// тот же принцип: несколько мест, где живёт "адрес прода", это
// осознанный компромисс маленького проекта без общего конфига).
const API_BASE: &str = "https://minitg.shitstudent.com:8443/api";

// Один клиент на всё приложение — у reqwest::Client внутри пул
// соединений и TLS-сессии, создавать его на каждый запрос значит
// каждый раз заново поднимать TLS-хендшейк.
fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(reqwest::Client::new)
}

/// Пути файлов, которые пользователь СВОИМИ РУКАМИ перетащил в окно.
/// `upload_report_file` ниже читает файл с диска по пути, пришедшему из
/// JS, — без этого списка любой XSS в webview превращался бы в примитив
/// «прочитать произвольный файл пользователя и отправить его на сервер»
/// (ровно то, от чего обычно защищает capability-скоуп tauri-plugin-fs).
/// Rust слушает то же самое нативное событие drag&drop, что и JS-сторона
/// (см. src/app/file-drop.js), поэтому список наполняется сам.
#[derive(Default)]
struct DroppedFiles(Mutex<HashSet<PathBuf>>);

impl DroppedFiles {
    fn remember(&self, paths: &[PathBuf]) {
        if let Ok(mut set) = self.0.lock() {
            // Держим только последний дроп — старые пути незачем
            // оставлять доступными на всю жизнь процесса.
            set.clear();
            for p in paths {
                set.insert(p.canonicalize().unwrap_or_else(|_| p.clone()));
            }
        }
    }

    fn contains(&self, path: &Path) -> bool {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        self.0
            .lock()
            .map(|set| set.contains(&canonical))
            .unwrap_or(false)
    }
}

// Тот же список, что ALLOWED_EXT в src/app/file-drop.js — держать в
// синхроне руками. Проверка дублируется намеренно: JS-сторону можно
// обойти, Rust-сторону — нет.
const ALLOWED_UPLOAD_EXT: &[&str] = &[
    "wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "mp4", "mov", "mkv", "avi", "png", "jpg",
    "jpeg", "webp", "pdf", "doc", "docx", "ppt", "pptx", "zip",
];

// Гигабайтный файл, целиком загруженный в память, уронил бы приложение
// раньше, чем сервер успел бы его отклонить.
const MAX_UPLOAD_BYTES: u64 = 200 * 1024 * 1024;

fn checked_upload_path(dropped: &DroppedFiles, file_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(file_path);
    if !dropped.contains(&path) {
        return Err("Этот файл не перетаскивали в окно — загрузка отклонена.".into());
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_UPLOAD_EXT.contains(&ext.as_str()) {
        return Err(format!("Формат файла не поддерживается: .{ext}"));
    }
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("Не удалось прочитать файл: {e}"))?
        .len();
    if size > MAX_UPLOAD_BYTES {
        return Err(format!(
            "Файл слишком большой ({} МБ) — лимит {} МБ.",
            size / 1024 / 1024,
            MAX_UPLOAD_BYTES / 1024 / 1024
        ));
    }
    Ok(path)
}

/// Файл, перетащенный из проводника (см. src/app/file-drop.js,
/// onDragDropEvent отдаёт только путь на диске, не байты) — читаем его
/// здесь, в Rust, и сами шлём multipart-запросом на
/// /api/report/{id}/files/upload, а не через JS/fetch: так не нужен
/// tauri-plugin-fs со capability-скоупом на произвольный путь на диске.
/// Скоуп при этом никуда не девается — он просто свой (см. DroppedFiles
/// выше): читаем только то, что пользователь сам перетащил в окно.
#[tauri::command]
async fn upload_report_file(
    app: tauri::AppHandle,
    report_id: String,
    file_path: String,
    init_data: String,
) -> Result<serde_json::Value, String> {
    let path = checked_upload_path(&app.state::<DroppedFiles>(), &file_path)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());

    // std::fs::read (блокирующий), не tokio::fs — не тащим отдельно
    // зависимость на tokio ради одного чтения файла.
    let bytes = std::fs::read(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))?;

    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
    let form = reqwest::multipart::Form::new().part("file", part);

    let resp = http()
        .post(format!("{API_BASE}/report/{report_id}/files/upload"))
        .header("X-Init-Data", init_data)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Не удалось отправить файл: {e}"))?;

    if !resp.status().is_success() {
        return Err(error_detail(resp, "сервер отклонил файл").await);
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Некорректный ответ сервера: {e}"))
}

/// Скачивание вложения отчёта. Раньше это была обычная ссылка
/// `<a href="...?init_data=ТОКЕН" target="_blank">` в карточке отчёта:
/// во-первых, target="_blank" внутри webview никакого окна не открывает
/// (кнопка просто не работала), во-вторых, токен `dsk_...` уезжал в
/// строку URL — то есть в логи сервера и в историю внешнего браузера.
/// Теперь запрос идёт отсюда, токен — заголовком, а путь сохранения
/// пользователь выбирает нативным диалогом (plugin-dialog на JS-стороне).
#[tauri::command]
async fn download_report_file(
    report_id: String,
    file_id: String,
    init_data: String,
    save_path: String,
) -> Result<(), String> {
    let resp = http()
        .get(format!(
            "{API_BASE}/report/{report_id}/files/{file_id}/download"
        ))
        .header("X-Init-Data", init_data)
        .send()
        .await
        .map_err(|e| format!("Не удалось скачать файл: {e}"))?;

    if !resp.status().is_success() {
        return Err(error_detail(resp, "сервер отказал в скачивании").await);
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Обрыв при скачивании: {e}"))?;
    std::fs::write(&save_path, &bytes).map_err(|e| format!("Не удалось сохранить файл: {e}"))
}

/// Текст ошибки из тела ответа сервера ({"detail": "..."}), если он там
/// есть — иначе переданная заглушка.
async fn error_detail(resp: reqwest::Response, fallback: &str) -> String {
    resp.json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
        .unwrap_or_else(|| fallback.to_string())
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        if visible {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
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
                    toggle_main_window(app);
                }
            }
        }).build())
        .manage(DroppedFiles::default())
        .invoke_handler(tauri::generate_handler![
            qc_analyze,
            generate_waveform,
            export_audio_clip,
            set_window_progress,
            token_save,
            token_load,
            token_clear,
            set_autostart,
            is_autostart,
            check_for_update,
            download_and_apply_update,
            upload_report_file,
            download_report_file,
            get_update_channel,
            set_update_channel,
        ])
        .setup(|app| {
            // Глобальная горячая клавиша — свернуть/показать окно из любого
            // места (Ctrl+Shift+P). Не через `?`: если комбинацию уже занял
            // кто-то другой в системе, ошибка отсюда уронила бы весь запуск
            // приложения — из-за необязательной горячей клавиши.
            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
            if let Err(e) = app.global_shortcut().register(toggle) {
                eprintln!("Не удалось зарегистрировать Ctrl+Shift+P (занята другим приложением?): {e}");
            }

            // Иконка в трее с меню — открыть/скрыть окно и выйти по-настоящему.
            let show_i = MenuItem::with_id(app, "show", "Открыть", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
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
                        toggle_main_window(tray.app_handle());
                    }
                });
            // Без unwrap(): иконки может не оказаться (собрали без
            // bundle.icon) — трей тогда просто будет с иконкой по
            // умолчанию, а не паника на старте.
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            let _tray = tray.build(app)?;

            let win = app
                .get_webview_window("main")
                .ok_or("окно main не найдено — проверьте tauri.conf.json")?;
            let win_clone = win.clone();
            let handle = app.handle().clone();
            win.on_window_event(move |event| match event {
                // Крестик у окна — сворачиваем в трей вместо закрытия (опрос
                // уведомлений на JS-стороне продолжает идти, пока процесс жив).
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = win_clone.hide();
                }
                // Тот же дроп, который обрабатывает JS (file-drop.js), —
                // запоминаем пути, чтобы upload_report_file знал, какие
                // файлы пользователь реально разрешил трогать.
                tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    handle.state::<DroppedFiles>().remember(paths);
                }
                _ => {}
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
