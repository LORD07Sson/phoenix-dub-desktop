// Project Desktop — Tauri-бэкенд.
//
// Фронтенд (dist/) — обычный HTML/CSS/JS, ходит напрямую в тот же REST API,
// что и мини-апп (`miniapp/server.py`), через fetch(). Rust-часть отвечает
// только за то, что веб-странице недоступно: нативное хранилище токена,
// локальный QC звука через ffmpeg, трей, глобальные горячие клавиши,
// автозапуск и системные уведомления.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio_qc;
mod board;
mod file_scope;
mod media_tools;
#[cfg(windows)]
mod mpv_embed;
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
// GitHub API, прокси на своём сервере не нужен.
const UPDATE_REPO_URL: &str = "https://github.com/LORD07Sson/project-desktop";

// Токен поднимает лимит запросов к GitHub API с 60/час (без токена, на
// IP — см. friendly_update_error/check_for_update_cached ниже, этого не
// хватало) до 5000/час. Зашивается на этапе СБОРКИ из переменной
// окружения CI (см. .github/workflows/build.yml/build-alpha.yml,
// секрет PROJECT_UPDATE_TOKEN) — option_env! читает её во время
// компиляции, а не во время работы приложения у пользователя, так что
// сам токен пользователю не виден иначе как разбором бинарника.
// Ожидаемый токен — fine-grained PAT с доступом ТОЛЬКО "Public
// Repositories (read-only)", без единого дополнительного права: он
// читает исключительно то, что и без него публично доступно всем, компрометация
// не даёт доступа ни к чему приватному, только выше лимит на чтение
// публичных данных. Локальная сборка без секрета (`cargo build` у
// разработчика) — токена просто нет, GithubSource откатывается на
// анонимный доступ, как было всегда; ничего не ломается.
const GITHUB_UPDATE_TOKEN: Option<&str> = option_env!("PROJECT_UPDATE_TOKEN");

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
    let source = velopack::sources::GithubSource::new(UPDATE_REPO_URL, GITHUB_UPDATE_TOKEN.map(str::to_string), is_alpha);
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

#[derive(serde::Serialize, Clone)]
struct UpdateInfoOut {
    version: String,
    notes: String,
}

// Даже с токеном (GITHUB_UPDATE_TOKEN выше, лимит 5000/час) 403 в
// принципе возможен — сборка без секрета (например, локальная у
// разработчика) откатывается на анонимный доступ (60/час на IP), плюс
// сам клиент и один способен дать несколько независимых запросов за
// сессию: автопроверка на старте (main.js) + открытие Настроек на
// альфа-канале (settings.js: refreshAlphaBlock тоже зовёт
// check_for_update отдельно) + ручная кнопка «Проверить обновления».
// check_for_update_cached ниже схлопывает их в один реальный запрос на
// короткое окно — независимо от того, что именно исчерпывает лимит.
fn friendly_update_error(e: impl std::fmt::Display) -> String {
    let text = e.to_string();
    if text.contains("403") {
        "Превышен лимит запросов к GitHub (возможно, IP делите с кем-то ещё, или само \
         приложение проверяло обновления несколько раз за последние минуты). \
         Попробуйте проверить вручную позже."
            .to_string()
    } else {
        text
    }
}

// TTL короче, чем троттлинг автопроверки на JS-стороне (maybeAutoCheckUpdates,
// 4 часа) — этот кэш не заменяет его, а закрывает случаи ВНУТРИ одной
// короткой сессии (открыли Настройки, посмотрели на коммит, закрыли,
// нажали «Проверить» — три вызова за секунды одного и того же вопроса
// "есть ли обновление").
const UPDATE_CHECK_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

struct CachedUpdateCheck {
    at: std::time::Instant,
    channel: String,
    result: Result<Option<UpdateInfoOut>, String>,
}

fn update_check_cache() -> &'static Mutex<Option<CachedUpdateCheck>> {
    static CACHE: OnceLock<Mutex<Option<CachedUpdateCheck>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

// Кэш ключуется каналом обновлений — переключение stable/alpha в Настройках
// должно увидеть актуальные данные немедленно, не ждать протухания TTL.
fn check_for_update_cached(app: &tauri::AppHandle) -> Result<Option<UpdateInfoOut>, String> {
    let channel = get_update_channel(app.clone())?;
    let cache = update_check_cache();
    if let Some(cached) = cache.lock().unwrap().as_ref() {
        if cached.channel == channel && cached.at.elapsed() < UPDATE_CHECK_CACHE_TTL {
            return cached.result.clone();
        }
    }

    let um = velopack_update_manager(app)?;
    let result = match um.check_for_updates().map_err(friendly_update_error) {
        Ok(velopack::UpdateCheck::UpdateAvailable(info)) => Ok(Some(UpdateInfoOut {
            version: info.TargetFullRelease.Version.clone(),
            notes: info.TargetFullRelease.NotesMarkdown.clone(),
        })),
        Ok(_) => Ok(None),
        Err(e) => Err(e),
    };
    *cache.lock().unwrap() = Some(CachedUpdateCheck { at: std::time::Instant::now(), channel, result: result.clone() });
    result
}

// (async) у синхронной функции — это НЕ косметика: команда без async
// выполняется прямо в главном потоке приложения и подвешивает окно на
// всё время работы. Тут внутри сетевой запрос к GitHub, так что без
// этого атрибута «Проверить обновления» морозило интерфейс.
#[tauri::command(async)]
fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfoOut>, String> {
    log_result("check_for_update", check_for_update_cached(&app))
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
    log_result("download_and_apply_update", (|| {
        let um = velopack_update_manager(&app)?;
        let info = match um.check_for_updates().map_err(friendly_update_error)? {
            velopack::UpdateCheck::UpdateAvailable(info) => *info,
            _ => return Err("Обновление больше не доступно — кто-то уже обновился раньше вас?".into()),
        };
        log::info!("download_and_apply_update: качаем {}", info.TargetFullRelease.Version);

        let (tx, rx) = std::sync::mpsc::channel::<i16>();
        let progress_app = app.clone();
        std::thread::spawn(move || {
            for pct in rx {
                let _ = progress_app.emit("update-progress", pct);
            }
        });

        um.download_updates(&info, Some(tx)).map_err(|e| e.to_string())?;
        // apply_updates_and_restart сама завершает процесс — строка ниже
        // в норме никогда не выполняется до конца, но если она вообще
        // вернула управление, это уже само по себе ошибка на стороне ОС.
        um.apply_updates_and_restart(&info.TargetFullRelease).map_err(|e| e.to_string())
    })())
}

// Логирует Err любой команды с её именем перед тем, как отдать наружу —
// единая точка диагностики по всем tauri::command в этом файле, вместо
// разметки логов внутри каждого модуля (audio_qc/media_tools/mpv_embed)
// отдельно: тот же приём, что toast() на JS-стороне (см. api.js) для
// error-тостов. Успешный путь намеренно не логируется здесь — иначе
// файл раздувался бы шумом на каждый клик, а не только там, где
// реально что-то пошло не так.
fn log_result<T>(command: &str, result: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &result {
        log::error!("[{command}] {e}");
    }
    result
}

// ffmpeg на большом файле работает секундами — в главном потоке это
// замороженное окно на всё время анализа.
//
// Путь больше не берётся на веру: file_scope.rs проверяет, что этот
// файл пользователь действительно выбрал сам (нативный диалог или
// перетаскивание в окно). Без проверки любой XSS в webview мог бы
// прочитать/перезаписать произвольный файл на диске — см. шапку
// file_scope.rs.
#[tauri::command(async)]
fn qc_analyze(app: tauri::AppHandle, path: String) -> Result<audio_qc::QcReport, String> {
    log_result("qc_analyze", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        audio_qc::analyze(&path.to_string_lossy())
    })())
}

// Тоже через ffmpeg (полное декодирование в PCM) — на большом файле
// секунды, поэтому (async) по той же причине, что и у qc_analyze выше.
#[tauri::command(async)]
fn generate_waveform(app: tauri::AppHandle, path: String, buckets: u32) -> Result<audio_qc::WaveformData, String> {
    log_result("generate_waveform", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        audio_qc::generate_waveform(&path.to_string_lossy(), buckets)
    })())
}

// Запускает ffmpeg-субпроцесс и пишет файл на диск — блокирующее.
#[tauri::command(async)]
fn export_audio_clip(
    app: tauri::AppHandle,
    path: String,
    start: f64,
    end: f64,
    save_path: String,
) -> Result<(), String> {
    log_result("export_audio_clip", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let save_path = scope.check_write(&save_path)?;
        file_scope::refuse_input_as_output(&path, &save_path)?;
        audio_qc::export_clip(&path.to_string_lossy(), start, end, &save_path.to_string_lossy())
    })())
}

/// Прогресс длинных операций ffmpeg уезжает в вебвью событием
/// `mediatool-progress` — сам media_tools.rs про окно приложения ничего
/// не знает (см. media_tools::Progress), поэтому мост живёт здесь.
fn progress_to_webview(app: &tauri::AppHandle) -> impl Fn(f64, &str) + Sync + '_ {
    move |fraction, label| {
        let _ = app.emit(
            "mediatool-progress",
            serde_json::json!({ "fraction": fraction, "label": label }),
        );
    }
}

/// Раскладка доски: сортировка по срочности, метрики колонок, поиск.
/// Считается в Rust не ради скорости (на сотне карточек её и не
/// заметить), а ради того, что это чистая функция без DOM — её целиком
/// покрывают тесты в board.rs, чего про обработчики рендера сказать
/// нельзя. Сегодняшнюю дату присылает фронтенд: часовой пояс студии
/// знает он, а не процесс.
#[tauri::command]
fn board_layout(
    columns: Vec<board::BoardColumnIn>,
    view: board::BoardView,
) -> board::BoardLayout {
    board::layout(columns, &view)
}

// ---------- нативные диалоги выбора файлов (file_scope.rs) ----------
// Раньше диалоги открывал JS (@tauri-apps/plugin-dialog) и присылал
// бэкенду готовый путь — то есть путь приходил из вебвью и ничем не
// отличался от произвольной строки. Теперь диалог открывает Rust: путь
// становится известен ему раньше, чем JS, и сразу попадает в скоуп.

#[tauri::command(async)]
fn pick_input_files(
    app: tauri::AppHandle,
    filters: Vec<file_scope::PickFilter>,
    multiple: bool,
) -> Vec<String> {
    file_scope::pick_input_files(&app, filters, multiple)
}

#[tauri::command(async)]
fn pick_output_file(
    app: tauri::AppHandle,
    default_name: Option<String>,
    filters: Vec<file_scope::PickFilter>,
) -> Option<String> {
    file_scope::pick_output_file(&app, default_name, filters)
}

#[tauri::command(async)]
fn pick_output_dir(app: tauri::AppHandle) -> Option<String> {
    file_scope::pick_output_dir(&app)
}

// ---------- «Инструменты ffmpeg» (media_tools.rs) ----------

#[tauri::command(async)]
fn mt_probe_media(app: tauri::AppHandle, path: String) -> Result<media_tools::MediaInfo, String> {
    log_result("mt_probe_media", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        media_tools::probe_media(&path.to_string_lossy())
    })())
}

#[tauri::command(async)]
fn mt_probe_keyframes(app: tauri::AppHandle, path: String) -> Result<Vec<f64>, String> {
    log_result("mt_probe_keyframes", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        media_tools::probe_keyframes(&path.to_string_lossy())
    })())
}

// Не (async): сам вызов — просто регистрация пути в скоупе asset-протокола
// (запись в память), никакого ffmpeg-субпроцесса здесь нет.
//
// Проверка скоупа тут самая важная во всём файле: allow_file() открывает
// вебвью чтение файла ПО HTTP-подобному asset://-адресу, то есть без
// неё одна строка из XSS давала бы чтение любого файла на диске.
#[tauri::command]
fn mt_register_media_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    log_result("mt_register_media_file", (|| {
        let path = app.state::<file_scope::FileScope>().check_read(&path)?;
        media_tools::register_media_file(&app, &path.to_string_lossy())
    })())
}

#[tauri::command(async)]
fn mt_cut_media(
    app: tauri::AppHandle,
    path: String,
    segments: Vec<media_tools::CutSegment>,
    out_dir: String,
    keep_separate: bool,
    merge: bool,
    precise: bool,
) -> Result<media_tools::CutResult, String> {
    log_result("mt_cut_media", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_dir = scope.check_write_dir(&out_dir)?;
        let sink = progress_to_webview(&app);
        media_tools::cut_media(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &segments,
            &out_dir.to_string_lossy(),
            keep_separate,
            merge,
            precise,
        )
    })())
}

#[tauri::command(async)]
fn mt_transcode_media(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    opts: media_tools::TranscodeOpts,
) -> Result<(), String> {
    log_result("mt_transcode_media", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::transcode_media(&media_tools::Progress(&sink), &path.to_string_lossy(), &out_path.to_string_lossy(), &opts)
    })())
}

#[tauri::command(async)]
fn mt_extract_audio(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    opts: media_tools::ExtractAudioOpts,
) -> Result<(), String> {
    log_result("mt_extract_audio", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::extract_audio(&media_tools::Progress(&sink), &path.to_string_lossy(), &out_path.to_string_lossy(), &opts)
    })())
}

#[tauri::command(async)]
fn mt_concat_media(app: tauri::AppHandle, paths: Vec<String>, out_path: String) -> Result<String, String> {
    log_result("mt_concat_media", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let checked: Vec<String> = paths
            .iter()
            .map(|p| scope.check_read(p).map(|p| p.to_string_lossy().into_owned()))
            .collect::<Result<_, _>>()?;
        let out_path = scope.check_write(&out_path)?;
        for p in &checked {
            file_scope::refuse_input_as_output(Path::new(p), &out_path)?;
        }
        let sink = progress_to_webview(&app);
        media_tools::concat_media(&media_tools::Progress(&sink), &checked, &out_path.to_string_lossy())
    })())
}

#[tauri::command(async)]
fn mt_mux_media(app: tauri::AppHandle, tracks: Vec<media_tools::MuxTrack>, out_path: String) -> Result<(), String> {
    log_result("mt_mux_media", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let mut checked = Vec::with_capacity(tracks.len());
        let out_path = scope.check_write(&out_path)?;
        for t in tracks {
            let p = scope.check_read(&t.path)?;
            file_scope::refuse_input_as_output(&p, &out_path)?;
            checked.push(media_tools::MuxTrack { path: p.to_string_lossy().into_owned(), ..t });
        }
        media_tools::mux_media(&checked, &out_path.to_string_lossy())
    })())
}

// ---------- новые операции: дубляж, скорость, кадры, GIF, субтитры ----------
// Все по одному образцу: скоуп проверяет входы и выход, отказ писать
// поверх исходника, прогресс уезжает в вебвью тем же событием.

#[tauri::command(async)]
fn mt_dub_audio(
    app: tauri::AppHandle,
    video: String,
    dub: String,
    out_path: String,
    opts: media_tools::DubOpts,
) -> Result<(), String> {
    log_result("mt_dub_audio", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let video = scope.check_read(&video)?;
        let dub = scope.check_read(&dub)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&video, &out_path)?;
        file_scope::refuse_input_as_output(&dub, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::dub_audio(
            &media_tools::Progress(&sink),
            &video.to_string_lossy(),
            &dub.to_string_lossy(),
            &out_path.to_string_lossy(),
            &opts,
        )
    })())
}

#[tauri::command(async)]
fn mt_change_speed(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    speed: f64,
    keep_pitch: bool,
) -> Result<(), String> {
    log_result("mt_change_speed", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::change_speed(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &out_path.to_string_lossy(),
            speed,
            keep_pitch,
        )
    })())
}

#[tauri::command(async)]
fn mt_extract_frames(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    opts: media_tools::FrameOpts,
) -> Result<(), String> {
    log_result("mt_extract_frames", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::extract_frames(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &out_path.to_string_lossy(),
            &opts,
        )
    })())
}

#[tauri::command(async)]
fn mt_make_gif(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    start: f64,
    duration: f64,
    fps: u32,
    width: u32,
) -> Result<(), String> {
    log_result("mt_make_gif", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::make_gif(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &out_path.to_string_lossy(),
            start,
            duration,
            fps,
            width,
        )
    })())
}

#[tauri::command(async)]
fn mt_burn_subtitles(
    app: tauri::AppHandle,
    video: String,
    subs: String,
    out_path: String,
    font_size: u32,
) -> Result<(), String> {
    log_result("mt_burn_subtitles", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let video = scope.check_read(&video)?;
        let subs = scope.check_read(&subs)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&video, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::burn_subtitles(
            &media_tools::Progress(&sink),
            &video.to_string_lossy(),
            &subs.to_string_lossy(),
            &out_path.to_string_lossy(),
            font_size,
        )
    })())
}

#[tauri::command(async)]
fn mt_extract_subtitles(
    app: tauri::AppHandle,
    path: String,
    out_path: String,
    track: u32,
) -> Result<(), String> {
    log_result("mt_extract_subtitles", (|| {
        let scope = app.state::<file_scope::FileScope>();
        let path = scope.check_read(&path)?;
        let out_path = scope.check_write(&out_path)?;
        file_scope::refuse_input_as_output(&path, &out_path)?;
        let sink = progress_to_webview(&app);
        media_tools::extract_subtitles(
            &media_tools::Progress(&sink),
            &path.to_string_lossy(),
            &out_path.to_string_lossy(),
            track,
        )
    })())
}

/// Прервать текущую операцию ffmpeg («Отмена» в панели инструментов).
/// До неё единственным способом остановить сорокаминутный транскод было
/// закрыть приложение — и даже это оставляло процесс ffmpeg дожёвывать
/// файл в фоне.
#[tauri::command(async)]
fn mt_cancel() -> Result<(), String> {
    media_tools::cancel_current_job()
}

// ---------- встроенный mpv-плеер (mpv_embed.rs, только Windows) ----------
// Один текст на все ветки cfg(not(windows)) — раньше та же строка была
// продублирована в каждой команде по отдельности.
#[cfg(not(windows))]
const MPV_WINDOWS_ONLY: &str = "Встроенный плеер поддерживается только на Windows.";

// Тела команд ветвятся по платформе, а не сами команды — иначе
// `generate_handler!` ниже пришлось бы собирать двумя разными списками
// под cfg(windows)/cfg(not(windows)), а этот проект и так никогда не
// собирается не под Windows (ffmpeg.exe/ffprobe.exe/mpv.exe — не
// кросс-платформенные бинарники); так хотя бы `cargo check` на другой ОС
// не ломается на отсутствующих Win32-символах.

#[tauri::command(async)]
async fn mpv_create(app: tauri::AppHandle, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_create(&app, mpv_embed::MpvBounds { x, y, width, height }).await;
    #[cfg(not(windows))]
    let result = {
        let _ = (app, x, y, width, height);
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_create", result)
}

#[tauri::command(async)]
async fn mpv_set_bounds(app: tauri::AppHandle, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_set_bounds(&app, mpv_embed::MpvBounds { x, y, width, height }).await;
    #[cfg(not(windows))]
    let result = {
        let _ = (app, x, y, width, height);
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_set_bounds", result)
}

#[tauri::command(async)]
async fn mpv_load(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(windows)]
    let result = {
        match app.state::<file_scope::FileScope>().check_read(&path) {
            Ok(checked) => mpv_embed::mpv_load(&checked.to_string_lossy()).await,
            Err(e) => Err(e),
        }
    };
    #[cfg(not(windows))]
    let result = {
        let _ = (app, path);
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_load", result)
}

#[tauri::command(async)]
async fn mpv_play() -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_play().await;
    #[cfg(not(windows))]
    let result = Err(MPV_WINDOWS_ONLY.to_string());
    log_result("mpv_play", result)
}

#[tauri::command(async)]
async fn mpv_pause() -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_pause().await;
    #[cfg(not(windows))]
    let result = Err(MPV_WINDOWS_ONLY.to_string());
    log_result("mpv_pause", result)
}

#[tauri::command(async)]
async fn mpv_seek(seconds: f64) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_seek(seconds).await;
    #[cfg(not(windows))]
    let result = {
        let _ = seconds;
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_seek", result)
}

// Громкость/скорость/покадровый шаг — то, без чего «плеер» остаётся
// картинкой с кнопкой play: на укладке дубляжа границу реплики ставят
// покадрово, а тихую дорожку проверяют на слух с поднятой громкостью.
#[tauri::command(async)]
async fn mpv_set_volume(volume: f64) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_set_volume(volume).await;
    #[cfg(not(windows))]
    let result = {
        let _ = volume;
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_set_volume", result)
}

#[tauri::command(async)]
async fn mpv_set_mute(mute: bool) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_set_mute(mute).await;
    #[cfg(not(windows))]
    let result = {
        let _ = mute;
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_set_mute", result)
}

#[tauri::command(async)]
async fn mpv_set_speed(speed: f64) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_set_speed(speed).await;
    #[cfg(not(windows))]
    let result = {
        let _ = speed;
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_set_speed", result)
}

#[tauri::command(async)]
async fn mpv_frame_step(forward: bool) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_frame_step(forward).await;
    #[cfg(not(windows))]
    let result = {
        let _ = forward;
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_frame_step", result)
}

// Петля A-B, выбор дорожки и стоп-кадр — то, без чего встроенный плеер
// остаётся «картинкой с кнопкой play»: укладка реплики идёт по кругу
// между метками, у многоязычного релиза несколько звуковых дорожек, а
// кадр из плеера регулярно нужен как референс в переписке.
#[tauri::command(async)]
async fn mpv_set_ab_loop(start: Option<f64>, end: Option<f64>) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_set_ab_loop(start, end).await;
    #[cfg(not(windows))]
    let result = {
        let _ = (start, end);
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_set_ab_loop", result)
}

#[tauri::command(async)]
async fn mpv_set_track(kind: String, id: i64) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_set_track(&kind, id).await;
    #[cfg(not(windows))]
    let result = {
        let _ = (kind, id);
        Err(MPV_WINDOWS_ONLY.to_string())
    };
    log_result("mpv_set_track", result)
}

/// Путь сохранения проверяется скоупом ровно как у любой другой записи
/// на диск: команду зовёт вебвью, значит путь — не доверенные данные.
#[tauri::command(async)]
async fn mpv_screenshot(app: tauri::AppHandle, save_path: String) -> Result<(), String> {
    let checked = app.state::<file_scope::FileScope>().check_write(&save_path);
    let result = match checked {
        Ok(path) => {
            #[cfg(windows)]
            {
                mpv_embed::mpv_screenshot(&path.to_string_lossy()).await
            }
            #[cfg(not(windows))]
            {
                let _ = path;
                Err(MPV_WINDOWS_ONLY.to_string())
            }
        }
        Err(e) => Err(e),
    };
    log_result("mpv_screenshot", result)
}

#[tauri::command(async)]
async fn mpv_close(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    let result = mpv_embed::mpv_close(&app).await;
    #[cfg(not(windows))]
    let result = {
        let _ = app;
        Ok(())
    };
    log_result("mpv_close", result)
}

// Открыть папку с файловыми логами (tauri-plugin-log, см. run()) —
// кнопка в настройках, чтобы при жалобе пользователь мог просто
// прислать файл, а не пересказывать своими словами, что было на экране.
// app_log_dir() — тот же путь, что резолвит сам плагин под капотом
// (TargetKind::LogDir), так что открывается ровно та папка, куда
// реально пишутся логи, без риска разъехаться с ним. reveal_item_in_dir
// (а не shell::open, который у tauri 2 к тому же deprecated в пользу
// этого же opener) открывает родителя и подсвечивает саму папку logs —
// этого достаточно, чтобы её найти и зайти внутрь.
#[tauri::command(async)]
fn open_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().reveal_item_in_dir(&dir).map_err(|e| e.to_string())
}

// Обращение к хранилищу учётных данных ОС тоже блокирующее (на Linux —
// синхронный вызов Secret Service по D-Bus).
#[tauri::command(async)]
fn token_save(token: String) -> Result<(), String> {
    // log_result безопасен и здесь: он логирует только текст Err (общая
    // ошибка хранилища ОС), сам токен никогда не попадает в лог ни на
    // успешном, ни на неудачном пути.
    log_result("token_save", token_store::save(&token))
}

#[tauri::command(async)]
fn token_load() -> Option<String> {
    token_store::load()
}

#[tauri::command(async)]
fn token_clear() -> Result<(), String> {
    log_result("token_clear", token_store::clear())
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
    let result = if enabled { mgr.enable() } else { mgr.disable() }.map_err(|e| e.to_string());
    log_result("set_autostart", result)
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

// Файл разрешён к загрузке, если пользователь сам его указал ЛЮБЫМ
// из двух способов — перетащил в окно (DroppedFiles) или выбрал в
// нативном диалоге (FileScope.readable, тот же скоуп, что уже даёт
// mt_register_media_file и остальным ffmpeg-командам). Раньше
// upload_report_file понимал только drag-drop — кнопка «Выбрать файл»
// (если такая появится в интерфейсе) молча отклонялась бы с той же
// ошибкой, хотя источник доверия ровно тот же: явный выбор
// пользователя, а не путь, подставленный из вебвью.
fn checked_upload_path(
    dropped: &DroppedFiles,
    scope: &file_scope::FileScope,
    file_path: &str,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(file_path);
    if !dropped.contains(&path) && scope.check_read(file_path).is_err() {
        return Err("Этот файл не выбирали в приложении — загрузка отклонена.".into());
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
    let result = async {
        let path = checked_upload_path(
            &app.state::<DroppedFiles>(),
            &app.state::<file_scope::FileScope>(),
            &file_path,
        )?;
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
    .await;
    log_result("upload_report_file", result)
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
    app: tauri::AppHandle,
    report_id: String,
    file_id: String,
    init_data: String,
    save_path: String,
) -> Result<(), String> {
    let result = async {
        // Путь сохранения приходит из вебвью. Без этой проверки XSS мог
        // бы положить файл с содержимым от сервера куда угодно — в папку
        // автозагрузки, поверх чужого документа и т.п.
        let save_path = app.state::<file_scope::FileScope>().check_write(&save_path)?;
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

        // Тот же предел, что и на загрузку (MAX_UPLOAD_BYTES): ответ
        // целиком уезжает в память, и без крышки один большой файл
        // (или сервер, отдающий бесконечный поток) роняет приложение по
        // памяти. Content-Length может врать или отсутствовать, поэтому
        // проверяем и заявленный размер, и фактически прочитанный.
        if let Some(len) = resp.content_length() {
            if len > MAX_UPLOAD_BYTES {
                return Err(format!("Файл слишком большой ({} МБ).", len / 1024 / 1024));
            }
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Обрыв при скачивании: {e}"))?;
        if bytes.len() as u64 > MAX_UPLOAD_BYTES {
            return Err("Файл слишком большой.".into());
        }
        std::fs::write(&save_path, &bytes).map_err(|e| format!("Не удалось сохранить файл: {e}"))
    }
    .await;
    log_result("download_report_file", result)
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

/// Скругление углов и цвет рамки окна — Windows 11 (build 22000+).
/// Системный заголовок у окна выключен (tauri.conf.json:
/// decorations:false, полосу рисует сам фронтенд, см. window-chrome.js),
/// поэтому единственное, что осталось от системного оформления, — тонкая
/// рамка, которую рисует DWM. По умолчанию она серая и к палитре
/// приложения отношения не имеет.
///
/// На Windows 10 обоих атрибутов не существует, вызов вернёт E_INVALIDARG
/// — намеренно игнорируем: окно просто останется с прямыми углами и
/// рамкой по умолчанию, как было.
#[cfg(windows)]
fn apply_windows_11_chrome(win: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    let Ok(hwnd) = win.hwnd() else {
        log::warn!("apply_windows_11_chrome: у окна нет HWND");
        return;
    };
    unsafe {
        let corner = DWMWCP_ROUND;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            std::ptr::addr_of!(corner).cast(),
            std::mem::size_of_val(&corner) as u32,
        );
        // COLORREF — 0x00BBGGRR, не привычный #RRGGBB: это --line из
        // styles.css (#38262e) с переставленными байтами.
        let border: u32 = 0x002e_2638;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            std::ptr::addr_of!(border).cast(),
            std::mem::size_of_val(&border) as u32,
        );
    }
}

/// WebView2 по умолчанию сам перехватывает часть «браузерных» горячих
/// клавиш (Ctrl+F/Ctrl+P/Ctrl+K и т.п. — то же, что в обычном Edge) ДО
/// того, как они доходят до keydown-слушателя страницы. У нас Ctrl+K —
/// это command-palette.js (document.addEventListener("keydown", ...)),
/// и в реальном приложении на Windows он никогда не срабатывал, хотя в
/// headless Playwright-тестах на Linux (не настоящий WebView2 — синтетика
/// диспетчерит события прямо в DOM, минуя браузерный слой) всё было
/// зелёным. AreBrowserAcceleratorKeysEnabled=false отдаёт эти комбинации
/// странице как обычные keydown.
fn disable_browser_accelerator_keys(win: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;
    let result = win.with_webview(|webview| {
        let apply = || -> windows::core::Result<()> {
            let controller = webview.controller();
            let core = unsafe { controller.CoreWebView2() }?;
            let settings = unsafe { core.Settings() }?;
            let settings3: ICoreWebView2Settings3 = settings.cast()?;
            unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) }
        };
        if let Err(e) = apply() {
            log::warn!("не удалось отключить браузерные accelerator keys WebView2 (Ctrl+K и другие горячие клавиши могут не доходить до страницы): {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("disable_browser_accelerator_keys: with_webview не выполнился: {e}");
    }
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
        // Файловые логи с ротацией — единая точка диагностики вместо
        // разрозненных toast/eprintln!, после которых при жалобе из
        // реальной студии оставалось только гадать (см. историю с mpv-
        // плеером: ни toast, ни процесса, а eprintln! в --release без
        // консоли уходил в никуда — оба факта стали видны только после
        // добавления этого плагина). Webview-таргет зеркалит и то, что
        // шлёт console.* из JS (media-tools.js и т.д.), в тот же файл —
        // не только в devtools-консоль, которую пользователь не откроет
        // сам. Info по умолчанию (сторонние крейты — reqwest/tauri сами
        // не должны заваливать файл своим trace/debug), Debug — для
        // собственного кода (level_for), максимум 5 МБ на файл, храним
        // 3 последних ротации, остального обычно достаточно, чтобы
        // покрыть один сеанс работы студии.
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir { file_name: Some("project-dub".into()) },
                ))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview))
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .level(log::LevelFilter::Off)
                .level_for("phoenix_dub_desktop", log::LevelFilter::Off)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        // reveal_item_in_dir для open_log_folder (кнопка «Открыть логи»
        // в настройках) — не тот же плагин, что shell:allow-open,
        // который open_log_folder раньше использовал через deprecated
        // Shell::open.
        .plugin(tauri_plugin_opener::init())
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
        .manage(file_scope::FileScope::default())
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
            board_layout,
            pick_input_files,
            pick_output_file,
            pick_output_dir,
            mt_cancel,
            mt_dub_audio,
            mt_change_speed,
            mt_extract_frames,
            mt_make_gif,
            mt_burn_subtitles,
            mt_extract_subtitles,
            mt_probe_media,
            mt_probe_keyframes,
            mt_register_media_file,
            mt_cut_media,
            mt_transcode_media,
            mt_extract_audio,
            mt_concat_media,
            mt_mux_media,
            mpv_create,
            mpv_set_bounds,
            mpv_load,
            mpv_play,
            mpv_pause,
            mpv_seek,
            mpv_set_volume,
            mpv_set_mute,
            mpv_set_speed,
            mpv_frame_step,
            mpv_set_ab_loop,
            mpv_set_track,
            mpv_screenshot,
            mpv_close,
            open_log_folder,
        ])
        .setup(|app| {
            // Первая строка в файловом логе за сеанс — якорь, от которого
            // считать всё остальное при разборе присланного лога (версия
            // сборки — иначе непонятно, к какому коммиту относится баг-
            // репорт присланного файла).
            log::info!("Project Desktop {} запускается", app.package_info().version);

            // Глобальная горячая клавиша — свернуть/показать окно из любого
            // места (Ctrl+Shift+P). Не через `?`: если комбинацию уже занял
            // кто-то другой в системе, ошибка отсюда уронила бы весь запуск
            // приложения — из-за необязательной горячей клавиши.
            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyP);
            if let Err(e) = app.global_shortcut().register(toggle) {
                log::warn!("Не удалось зарегистрировать Ctrl+Shift+P (занята другим приложением?): {e}");
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
            #[cfg(windows)]
            apply_windows_11_chrome(&win);
            #[cfg(windows)]
            disable_browser_accelerator_keys(&win);
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
                    // Перетащенный файл — такой же явный выбор пользователя,
                    // как выбранный в диалоге: QC звука умеет запускаться
                    // прямо по дропу (file-drop.js), а qc_analyze теперь
                    // сверяется со скоупом (file_scope.rs).
                    let scope = handle.state::<file_scope::FileScope>();
                    for p in paths {
                        scope.allow_read(p);
                    }
                }
                // mpv-плеер (mpv_embed.rs) сидит в отдельном owned-окне,
                // не в дочернем, поэтому не переезжает и не ресайзится
                // вместе с главным окном сам по себе — а ResizeObserver
                // на JS-стороне здесь не поможет: прямоугольник
                // плейсхолдера ОТНОСИТЕЛЬНО страницы не меняется, когда
                // двигают/снапают само окно приложения. Досинхронизируем
                // явно на каждое такое событие; если плеер сейчас не
                // создан, mpv_resync_bounds тихо ничего не делает.
                #[cfg(windows)]
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        mpv_embed::mpv_resync_bounds(&handle).await;
                    });
                }
                _ => {}
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_update_error_explains_github_rate_limit() {
        let msg = friendly_update_error("Http error: http status: 403");
        assert!(msg.contains("лимит"), "должно объяснять причину, получили: {msg}");
        assert!(!msg.contains("403"), "пользователю не нужен голый код ответа: {msg}");
    }

    #[test]
    fn friendly_update_error_passes_through_other_errors() {
        let msg = friendly_update_error("Нет связи с сервером: connection refused");
        assert_eq!(msg, "Нет связи с сервером: connection refused");
    }
}
