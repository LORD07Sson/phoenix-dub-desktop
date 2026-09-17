//! Встроенный mpv-плеер для панели «Обрезка» (media-tools.js) — реальный
//! видеоплеер вместо браузерного `<video>`, который не декодирует HEVC/
//! ProRes и другие «непопулярные» в вебе кодеки без системных кодек-
//! пакетов. Только Windows (весь проект собирается только под Windows —
//! CI, ffmpeg.exe/ffprobe.exe, keyring windows-native).
//!
//! mpv не рисует в HTML/DOM — он рендерит в НАТИВНОЕ Win32-окно. Схема:
//! мы сами создаём child-окно (`CreateWindowExW`, `WS_CHILD`) как ребёнка
//! главного окна Tauri, отдаём его HWND аргументом `--wid=` в `mpv.exe`,
//! и mpv рендерит видео прямо в это окно. Дальше МЫ двигаем/ресайзим это
//! окно (`SetWindowPos`), синхронизируя его с прямоугольником HTML-
//! плейсхолдера (см. media-tools.js: ResizeObserver + mpv_set_bounds) —
//! mpv сам подхватывает новый размер, ему для этого ничего слать не нужно.
//! Управление (play/pause/seek/позиция) — через JSON IPC по именованному
//! пайпу (mpv.io/manual/master/#json-ipc): команды — JSON-строки
//! `{"command":[...]}\n`, события (после `observe_property`) — такие же
//! JSON-строки со стороны mpv, разбираем построчно в фоновой задаче.

use serde_json::json;
use std::process::{Child, Command};
use std::sync::OnceLock;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, WriteHalf};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::Mutex as AsyncMutex;
use windows::core::w;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, SetWindowPos,
    CS_HREDRAW, CS_VREDRAW, SWP_NOACTIVATE, SWP_NOZORDER, WNDCLASSW, WS_CHILD, WS_EX_NOACTIVATE,
    WS_VISIBLE,
};

use crate::audio_qc::resolve_binary_uncached;

pub struct MpvBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

fn resolve_mpv() -> &'static str {
    static RESOLVED: OnceLock<String> = OnceLock::new();
    RESOLVED.get_or_init(|| resolve_binary_uncached("mpv", "mpv.exe")).as_str()
}

// ---------- child-окно ----------

const CLASS_NAME: windows::core::PCWSTR = w!("PhoenixMpvHost");

// Сама mpv рисует в это окно через --wid — нашему WndProc реально нечего
// обрабатывать, кроме отдачи управления системе по умолчанию.
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn ensure_class_registered() {
    static REGISTERED: OnceLock<()> = OnceLock::new();
    REGISTERED.get_or_init(|| {
        let hinstance = unsafe { GetModuleHandleW(None) }.unwrap_or_default();
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        // Атом класса 0 при повторной регистрации — не ошибка (Windows
        // просто не дублирует уже зарегистрированный по этому имени в
        // рамках процесса); из-за OnceLock сюда и так попадаем только раз.
        unsafe { RegisterClassW(&wc) };
    });
}

fn create_child_window(parent: HWND, b: &MpvBounds) -> windows::core::Result<HWND> {
    ensure_class_registered();
    let hinstance = unsafe { GetModuleHandleW(None) }?;
    unsafe {
        CreateWindowExW(
            // NOACTIVATE — клик по видео не должен воровать фокус клавиатуры
            // у остального интерфейса (таймлайн/кнопки живут в HTML-части).
            WS_EX_NOACTIVATE,
            CLASS_NAME,
            w!(""),
            WS_CHILD | WS_VISIBLE,
            b.x,
            b.y,
            b.width,
            b.height,
            Some(parent),
            None,
            Some(hinstance.into()),
            None,
        )
    }
}

fn set_bounds_raw(hwnd: HWND, b: &MpvBounds) -> Result<(), String> {
    unsafe { SetWindowPos(hwnd, None, b.x, b.y, b.width, b.height, SWP_NOZORDER | SWP_NOACTIVATE) }
        .map_err(|e| e.to_string())
}

// ---------- состояние + IPC ----------

struct MpvState {
    hwnd: isize,
    child: Child,
    write_half: WriteHalf<NamedPipeClient>,
}

fn state() -> &'static AsyncMutex<Option<MpvState>> {
    static STATE: OnceLock<AsyncMutex<Option<MpvState>>> = OnceLock::new();
    STATE.get_or_init(|| AsyncMutex::new(None))
}

// mpv поднимает пайп-сервер не мгновенно после spawn — короткий поллинг
// подключения вместо гадания с фиксированной задержкой.
async fn connect_with_retry(pipe_name: &str) -> std::io::Result<NamedPipeClient> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match ClientOptions::new().open(pipe_name) {
            Ok(client) => return Ok(client),
            Err(e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(e);
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

/// Создаёт child-окно + процесс mpv, если их ещё нет; если уже есть —
/// просто переставляет существующее окно (тот же путь, что
/// `mpv_set_bounds`, — вызывается и с явным `mpv_set_bounds` при ресайзе
/// плейсхолдера, и отсюда при повторном `mpv_create` на тот же файл).
pub async fn mpv_create(app: &tauri::AppHandle, bounds: MpvBounds) -> Result<(), String> {
    let mut guard = state().lock().await;
    if let Some(existing) = guard.as_ref() {
        return set_bounds_raw(HWND(existing.hwnd as _), &bounds);
    }

    // HWND (windows-rs) оборачивает *mut c_void — не Send, поэтому не
    // держим значение этого типа живым НИ ЧЕРЕЗ ОДИН await ниже: сразу
    // выдёргиваем raw isize во вложенном блоке (область видимости самого
    // `hwnd: HWND` заканчивается на закрывающей скобке, до первого
    // `.await`), а HWND пересобираем заново из isize только там, где он
    // синхронно нужен здесь и сейчас (DestroyWindow).
    let hwnd_raw: isize = {
        let parent = app
            .get_webview_window("main")
            .ok_or("окно main не найдено")?
            .hwnd()
            .map_err(|e| e.to_string())?;
        let hwnd = create_child_window(parent, &bounds).map_err(|e| e.to_string())?;
        hwnd.0 as isize
    };

    let pipe_name = format!(r"\\.\pipe\phoenix-mpv-{}", std::process::id());
    let mpv = resolve_mpv();
    log::info!("spawn {mpv} --wid={hwnd_raw} bounds={}x{}+{},{}", bounds.width, bounds.height, bounds.x, bounds.y);
    let child = Command::new(mpv)
        .args([
            format!("--wid={hwnd_raw}"),
            "--idle=yes".into(),
            "--keep-open=always".into(),
            "--no-osc".into(),
            "--no-input-default-bindings".into(),
            format!("--input-ipc-server={pipe_name}"),
        ])
        .spawn()
        .map_err(|e| {
            unsafe { let _ = DestroyWindow(HWND(hwnd_raw as _)); }
            format!("mpv не найден или не запустился ({mpv}): {e}.")
        })?;

    log::info!("spawned pid={:?}, подключаемся к пайпу {pipe_name}...", child.id());
    let client = connect_with_retry(&pipe_name).await.map_err(|e| {
        unsafe { let _ = DestroyWindow(HWND(hwnd_raw as _)); }
        log::error!("не удалось подключиться к mpv IPC за 5с: {e}");
        format!("не удалось подключиться к mpv IPC: {e}")
    })?;
    log::info!("пайп подключён");
    let (read_half, mut write_half) = tokio::io::split(client);

    // Подписка на позицию/паузу — раньше это давали события <video>
    // (timeupdate/play/pause), теперь их эмулирует property-change из mpv.
    write_half
        .write_all(b"{\"command\":[\"observe_property\",1,\"time-pos\"]}\n")
        .await
        .map_err(|e| e.to_string())?;
    write_half
        .write_all(b"{\"command\":[\"observe_property\",2,\"pause\"]}\n")
        .await
        .map_err(|e| e.to_string())?;

    let app_events = app.clone();
    tokio::spawn(async move {
        use tauri::Emitter;
        let mut lines = BufReader::new(read_half).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if v.get("event").and_then(|e| e.as_str()) == Some("property-change") {
                let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
                let _ = app_events.emit("mpv-state", json!({ "name": name, "data": data }));
            }
        }
        // Пайп закрылся (mpv умер сам, например файл битый) — сообщаем
        // фронтенду тем же каналом, чтобы не показывать замёршую кнопку
        // play вечно.
        log::warn!("пайп IPC закрылся — mpv, судя по всему, завершился сам");
        let _ = app_events.emit("mpv-state", json!({ "name": "exited", "data": true }));
    });

    *guard = Some(MpvState { hwnd: hwnd_raw, child, write_half });
    Ok(())
}

pub async fn mpv_set_bounds(bounds: MpvBounds) -> Result<(), String> {
    let guard = state().lock().await;
    let s = guard.as_ref().ok_or("mpv не создан")?;
    set_bounds_raw(HWND(s.hwnd as _), &bounds)
}

async fn send_command(cmd: serde_json::Value) -> Result<(), String> {
    let mut guard = state().lock().await;
    let s = guard.as_mut().ok_or("mpv не создан — сначала выберите видео")?;
    let mut line = cmd.to_string();
    line.push('\n');
    s.write_half.write_all(line.as_bytes()).await.map_err(|e| format!("mpv IPC: {e}"))
}

pub async fn mpv_load(path: &str) -> Result<(), String> {
    send_command(json!({ "command": ["loadfile", path, "replace"] })).await
}

pub async fn mpv_play() -> Result<(), String> {
    send_command(json!({ "command": ["set_property", "pause", false] })).await
}

pub async fn mpv_pause() -> Result<(), String> {
    send_command(json!({ "command": ["set_property", "pause", true] })).await
}

pub async fn mpv_seek(seconds: f64) -> Result<(), String> {
    send_command(json!({ "command": ["seek", seconds, "absolute"] })).await
}

/// Разрушает child-окно и завершает процесс mpv — вызывается и явно
/// (смена файла/закрытие модалки на JS-стороне), и должна быть безопасна
/// вызвать повторно (idempotent), если фронтенд позвал её на всякий
/// случай при закрытии, когда плеера и не было.
pub async fn mpv_close() -> Result<(), String> {
    let mut guard = state().lock().await;
    if let Some(mut s) = guard.take() {
        let _ = s.write_half.write_all(b"{\"command\":[\"quit\"]}\n").await;
        let _ = s.child.kill();
        unsafe { let _ = DestroyWindow(HWND(s.hwnd as _)); }
    }
    Ok(())
}
