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
//! Управление (play/pause/seek/громкость/скорость/покадрово) — через JSON
//! IPC по именованному пайпу (mpv.io/manual/master/#json-ipc): команды —
//! JSON-строки `{"command":[...]}\n`, события (после `observe_property`) —
//! такие же JSON-строки со стороны mpv, разбираем построчно в фоновой
//! задаче.
//!
//! ВАЖНО про потоки. Win32-окно принадлежит потоку, который его создал:
//! только этот поток получает его сообщения, и только у него есть цикл
//! их разбора. Команды `#[tauri::command(async)]` исполняются на рабочих
//! потоках tokio — никакого message loop там нет, а создание child-окна
//! с родителем из ДРУГОГО потока вдобавок сцепляет очереди ввода двух
//! потоков (AttachThreadInput, см. MSDN к CreateWindowEx/SetParent) и
//! умеет намертво подвесить интерфейс. Поэтому каждый вызов Win32,
//! трогающий это окно (Create/SetWindowPos/Destroy), маршалится на
//! главный поток приложения через `AppHandle::run_on_main_thread` —
//! тот самый поток, на котором крутится событийный цикл Tauri/tao.

use serde_json::json;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, WriteHalf};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::Mutex as AsyncMutex;
use windows::core::w;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, IsWindowVisible, RegisterClassW,
    SetWindowPos, CS_HREDRAW, CS_VREDRAW, HWND_TOP, SWP_NOACTIVATE, WNDCLASSW, WS_CHILD,
    WS_EX_NOACTIVATE, WS_VISIBLE,
};

use crate::audio_qc::{hidden_command, resolve_binary_uncached};

#[derive(Clone, Copy)]
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

// ---------- маршалинг Win32-вызовов на главный поток ----------

/// Выполняет `f` на главном потоке приложения и дожидается результата.
/// Все вызовы Win32 по child-окну идут только через неё — см. заметку
/// про потоки в шапке модуля. `R: Send` — результат едет обратно по
/// oneshot-каналу, поэтому сам HWND (не Send) наружу не выносим,
/// возвращаем raw isize.
async fn on_main_thread<R, F>(app: &tauri::AppHandle, f: F) -> Result<R, String>
where
    R: Send + 'static,
    F: FnOnce() -> R + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel::<R>();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("не удалось передать вызов в главный поток: {e}"))?;
    rx.await
        .map_err(|_| "главный поток не ответил (окно приложения закрывается?)".to_string())
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

/// Синхронная часть создания окна — вызывается ТОЛЬКО с главного потока
/// (см. `create_child_window_on_main`).
fn create_child_window_raw(parent_raw: isize, b: MpvBounds) -> Result<isize, String> {
    ensure_class_registered();
    let hinstance = unsafe { GetModuleHandleW(None) }.map_err(|e| e.to_string())?;
    let hwnd = unsafe {
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
            Some(HWND(parent_raw as _)),
            None,
            Some(hinstance.into()),
            None,
        )
    }
    .map_err(|e| format!("CreateWindowExW: {e}"))?;
    // Что реально получилось: если окно невидимо или нулевого размера,
    // mpv будет исправно декодировать «в никуда», и по одному только
    // «пайп подключён» этого не отличить от нормальной работы.
    let mut rect = windows::Win32::Foundation::RECT::default();
    let visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
    let got_rect = unsafe { GetClientRect(hwnd, &mut rect) }.is_ok();
    log::info!(
        "child-окно создано: hwnd={:?} видимо={visible} клиент={}x{} (запрошено {}x{})",
        hwnd.0,
        if got_rect { rect.right - rect.left } else { -1 },
        if got_rect { rect.bottom - rect.top } else { -1 },
        b.width,
        b.height
    );
    Ok(hwnd.0 as isize)
}

async fn create_child_window_on_main(
    app: &tauri::AppHandle,
    parent_raw: isize,
    b: MpvBounds,
) -> Result<isize, String> {
    on_main_thread(app, move || create_child_window_raw(parent_raw, b)).await?
}

/// Двигает окно плеера и КАЖДЫЙ РАЗ поднимает его поверх соседей.
///
/// Поднимать обязательно: вебвью WebView2 — такое же дочернее окно
/// главного окна, то есть сосед нашего по z-порядку. Стоит ему оказаться
/// выше (а он оказывается — например, после того как страница получила
/// фокус), и видео полностью перекрыто веб-слоем: на экране остаётся
/// чёрный прямоугольник HTML-плейсхолдера, при том что mpv исправно
/// декодирует и позиция воспроизведения идёт. Раньше здесь стоял
/// SWP_NOZORDER, то есть z-порядок сохранялся каким был.
async fn set_bounds_on_main(app: &tauri::AppHandle, hwnd_raw: isize, b: MpvBounds) -> Result<(), String> {
    on_main_thread(app, move || {
        unsafe {
            SetWindowPos(
                HWND(hwnd_raw as _),
                Some(HWND_TOP),
                b.x,
                b.y,
                b.width,
                b.height,
                SWP_NOACTIVATE,
            )
        }
        .map_err(|e| e.to_string())
    })
    .await?
}

async fn destroy_window_on_main(app: &tauri::AppHandle, hwnd_raw: isize) {
    let _ = on_main_thread(app, move || unsafe {
        let _ = DestroyWindow(HWND(hwnd_raw as _));
    })
    .await;
}

// ---------- состояние + IPC ----------

/// Поколение плеера: фоновая задача-читатель IPC переживает свой
/// MpvState (её `while let` крутится, пока жив пайп) и по его закрытию
/// должна убрать ИМЕННО своё состояние. Без этого счётчика быстрый цикл
/// «закрыли плеер — открыли новый» приводил бы к тому, что читатель
/// старого mpv сносит только что созданный новый.
static GENERATION: AtomicU64 = AtomicU64::new(0);

struct MpvState {
    generation: u64,
    hwnd: isize,
    child: Child,
    write_half: WriteHalf<NamedPipeClient>,
}

fn state() -> &'static AsyncMutex<Option<MpvState>> {
    static STATE: OnceLock<AsyncMutex<Option<MpvState>>> = OnceLock::new();
    STATE.get_or_init(|| AsyncMutex::new(None))
}

// mpv поднимает пайп-сервер не мгновенно после spawn — короткий поллинг
// подключения вместо гадания с фиксированной задержкой. Заодно ловим
// случай «процесс умер сразу» (битый бинарник, нет d3dcompiler_43.dll),
// чтобы не ждать все 5 секунд впустую и сказать об этом прямо.
async fn connect_with_retry(
    pipe_name: &str,
    child: &mut Child,
) -> Result<NamedPipeClient, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match ClientOptions::new().open(pipe_name) {
            Ok(client) => return Ok(client),
            Err(e) => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!(
                        "mpv завершился сразу после запуска (код {status}) — \
                         возможно, рядом с mpv.exe не хватает d3dcompiler_43.dll"
                    ));
                }
                if std::time::Instant::now() >= deadline {
                    return Err(format!("не удалось подключиться к mpv IPC за 5с: {e}"));
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

/// Аргументы запуска mpv. `--no-config`/`--load-scripts=no` — не
/// косметика: без них mpv читает `%APPDATA%\mpv\mpv.conf` пользователя, и
/// чужая строчка вроде `fullscreen=yes`, `vo=`, `profile=…` или сторонний
/// скрипт ломают встраивание молча и невоспроизводимо на чужой машине
/// (плеер «просто не работает у одного человека из студии»).
/// `--no-terminal` — mpv не пытается работать с консолью, которой у GUI-
/// приложения нет.
fn mpv_args(hwnd_raw: isize, pipe_name: &str) -> Vec<String> {
    vec![
        format!("--wid={hwnd_raw}"),
        "--no-config".into(),
        "--load-scripts=no".into(),
        "--no-terminal".into(),
        "--idle=yes".into(),
        // Окно рендера нужно сразу, ещё до loadfile — иначе первый кадр
        // появляется рывком вместе с созданием поверхности.
        "--force-window=yes".into(),
        "--keep-open=always".into(),
        "--no-osc".into(),
        "--no-input-default-bindings".into(),
        // Клавиатура/мышь внутри видео-окна нам не нужны: все органы
        // управления живут в HTML-части, а перехват клавиш нативным
        // окном отбирал бы их у интерфейса.
        "--input-vo-keyboard=no".into(),
        "--no-input-cursor".into(),
        "--cursor-autohide=no".into(),
        // Софтверное декодирование. Проверено на реальной жалобе
        // (hevc 1920x1080, current-vo=gpu-next, current-ao=wasapi — все
        // подсистемы поднялись штатно, hwdec-current=no): картинки не
        // было и с ним выключенным, так что декодирование тут ни при
        // чём — оставлено как есть, не аппаратное декодирование лишним
        // не будет, а включать его обратно незачем без явной причины.
        "--hwdec=no".into(),
        // Тот же случай показал: VO/AO инициализируются штатно (лог
        // печатает VO: [gpu-next] .. / AO: [wasapi] ..), а картинки всё
        // равно нет — значит дело не в декодировании, а в том, что
        // накладывается ПОВЕРХ уже нарисованного кадра. gpu-next
        // (VO по умолчанию с недавних версий mpv) рендерит через DXGI
        // flip-model swapchain — тот же класс поверхности, что и у
        // WebView2 (Tauri/wry хостит его тоже дочерним Win32-окном, см.
        // wry/src/webview2/mod.rs), а команда WebView2 сама подтверждает
        // в MicrosoftEdge/WebView2Feedback#708: «webview control seems
        // to always stay on top... no matter where it is in the visual
        // tree» — то есть обычный SetWindowPos-z-order (который правился
        // раньше) на него не действует, он рисует через свой собственный
        // DirectComposition-таргет.
        //
        // direct3d — старый, «Windows only» VO на классическом
        // Direct3D9-презентере (см. DOCS/man/vo.rst в исходниках mpv),
        // который использовался для встраивания в чужие окна ещё до
        // появления DXGI-based gpu/gpu-next и не создаёт flip-model
        // поверхность — кандидат на то, чтобы не конфликтовать с
        // WebView2 тем же способом. Список через запятую — формат
        // приоритета самого mpv (см. vo.rst: "If the list has a
        // trailing ',', mpv will fall back on drivers not contained in
        // the list"): если direct3d на какой-то машине не поднимется
        // вовсе, mpv сам откатится на gpu-next, а не оставит пользователя
        // без плеера.
        "--vo=direct3d,gpu-next,".into(),
        format!("--input-ipc-server={pipe_name}"),
    ]
}

/// Свойства, за которыми следим: фронтенд строит по ним таймлайн и
/// состояние кнопок. id важен — он приходит обратно в property-change.
const OBSERVED: &[(u32, &str)] = &[
    (1, "time-pos"),
    (2, "pause"),
    (3, "duration"),
    (4, "eof-reached"),
    (5, "volume"),
    (6, "mute"),
    (7, "speed"),
    // Список дорожек — чтобы панель могла показать «Аудио: RU / JP» и
    // «Субтитры: выкл / rus» вместо того, чтобы делать вид, что у файла
    // всегда ровно одна звуковая дорожка. У многоязычного релиза их
    // столько же, сколько языков дубляжа.
    (8, "track-list"),
];

/// Свойства, которые интересны только логу, а не интерфейсу. Нужны, чтобы
/// на жалобу «чёрный экран и нет звука» отвечал файл логов, а не догадки:
/// если `current-vo` пуст — не поднялся видеовыход, если пуст
/// `current-ao` — не открылось звуковое устройство (mpv по умолчанию
/// продолжает воспроизведение без звука и молчит об этом), а
/// `hwdec-current` показывает, программно ли идёт декодирование.
const DIAGNOSTIC: &[(u32, &str)] = &[
    (100, "current-vo"),
    (101, "current-ao"),
    (102, "hwdec-current"),
    (103, "video-codec"),
    (104, "audio-codec-name"),
    (105, "width"),
    (106, "height"),
    (107, "aid"),
    (108, "vid"),
    (109, "file-format"),
    (110, "idle-active"),
];

/// Создаёт child-окно + процесс mpv, если их ещё нет; если уже есть —
/// просто переставляет существующее окно (тот же путь, что
/// `mpv_set_bounds`, — вызывается и с явным `mpv_set_bounds` при ресайзе
/// плейсхолдера, и отсюда при повторном `mpv_create` на тот же файл).
/// Если прошлый экземпляр умер сам (битый файл, убитый процесс), его
/// остатки здесь же подчищаются и плеер поднимается заново — раньше
/// такое состояние делало панель «Обрезка» мёртвой до перезапуска
/// приложения.
pub async fn mpv_create(app: &tauri::AppHandle, bounds: MpvBounds) -> Result<(), String> {
    let mut guard = state().lock().await;

    if let Some(existing) = guard.as_mut() {
        let alive = !matches!(existing.child.try_wait(), Ok(Some(_)));
        if alive {
            let hwnd_raw = existing.hwnd;
            drop(guard);
            return set_bounds_on_main(app, hwnd_raw, bounds).await;
        }
        // Процесс умер — окно осталось висеть. Сносим и поднимаем заново.
        log::warn!("mpv_create: прошлый процесс mpv мёртв, пересоздаём плеер");
        let dead = guard.take().expect("проверено выше");
        destroy_window_on_main(app, dead.hwnd).await;
    }

    let parent_raw: isize = app
        .get_webview_window("main")
        .ok_or("окно main не найдено")?
        .hwnd()
        .map_err(|e| e.to_string())?
        .0 as isize;
    let hwnd_raw = create_child_window_on_main(app, parent_raw, bounds).await?;

    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    // Имя пайпа уникально не только по процессу, но и по поколению:
    // при пересоздании плеера старый mpv может ещё держать прежний пайп
    // пару миллисекунд, и новый клиент подключился бы к трупу.
    let pipe_name = format!(r"\\.\pipe\phoenix-mpv-{}-{generation}", std::process::id());
    let mpv = resolve_mpv();
    log::info!(
        "spawn {mpv} --wid={hwnd_raw} bounds={}x{}+{},{} gen={generation}",
        bounds.width, bounds.height, bounds.x, bounds.y
    );
    // hidden_command, а не голый Command — иначе на каждый запуск плеера
    // поверх интерфейса мигает чёрное консольное окно (ровно то, от чего
    // в audio_qc.rs защищены все вызовы ffmpeg).
    let mut child = hidden_command(mpv)
        .args(mpv_args(hwnd_raw, &pipe_name))
        .spawn()
        .map_err(|e| format!("mpv не найден или не запустился ({mpv}): {e}."))?;

    log::info!("spawned pid={:?}, подключаемся к пайпу {pipe_name}...", child.id());
    let client = match connect_with_retry(&pipe_name, &mut child).await {
        Ok(c) => c,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            drop(guard);
            destroy_window_on_main(app, hwnd_raw).await;
            log::error!("{e}");
            return Err(e);
        }
    };
    log::info!("пайп подключён");
    let (read_half, mut write_half) = tokio::io::split(client);

    // Подписка на позицию/паузу/громкость/скорость — раньше это давали
    // события <video> (timeupdate/play/pause), теперь их эмулирует
    // property-change из mpv.
    for (id, name) in OBSERVED.iter().chain(DIAGNOSTIC.iter()) {
        let line = format!("{{\"command\":[\"observe_property\",{id},\"{name}\"]}}\n");
        write_half
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("mpv IPC (observe_property {name}): {e}"))?;
    }
    // Свой лог mpv — в наш файл логов. Без этого mpv запущен с
    // --no-terminal и все его сообщения («не удалось открыть звуковое
    // устройство», «vo не инициализировался», «формат не поддержан»)
    // уходят в никуда, а пользователь видит чёрный экран без единого
    // объяснения — ровно тот случай, ради которого это и добавлено.
    write_half
        .write_all(b"{\"command\":[\"request_log_messages\",\"info\"]}\n")
        .await
        .map_err(|e| format!("mpv IPC (request_log_messages): {e}"))?;

    let app_events = app.clone();
    tokio::spawn(async move {
        use tauri::Emitter;
        let mut lines = BufReader::new(read_half).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v.get("event").and_then(|e| e.as_str()) {
                Some("property-change") => {
                    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
                    if DIAGNOSTIC.iter().any(|(_, n)| *n == name) {
                        // В лог — разбор жалобы начинается именно с них.
                        log::info!("[mpv] {name} = {data}");
                    }
                    // Наверх уходит всё: панель смотрит на current-vo и
                    // current-ao, чтобы сказать вслух «видеовыход не
                    // поднялся» / «звуковое устройство не открылось»
                    // вместо молчаливого чёрного прямоугольника.
                    let _ = app_events.emit("mpv-state", json!({ "name": name, "data": data }));
                }
                // Сообщения самого mpv. Уровень ниже warn валит в файл
                // слишком много (он подробно расписывает каждый кадр на
                // старте), поэтому info и выше пишем как есть, а
                // подробности отбрасываем.
                Some("log-message") => {
                    let level = v.get("level").and_then(|l| l.as_str()).unwrap_or("info");
                    let prefix = v.get("prefix").and_then(|p| p.as_str()).unwrap_or("mpv");
                    let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("").trim_end();
                    if text.is_empty() {
                        continue;
                    }
                    match level {
                        "fatal" | "error" => log::error!("[mpv/{prefix}] {text}"),
                        "warn" => log::warn!("[mpv/{prefix}] {text}"),
                        _ => log::info!("[mpv/{prefix}] {text}"),
                    }
                }
                // Ошибка открытия файла раньше выглядела как «плеер молча
                // не играет»: mpv жив, пайп цел, а видео нет.
                Some("end-file") if v.get("reason").and_then(|r| r.as_str()) == Some("error") => {
                    let err = v.get("file_error").and_then(|e| e.as_str()).unwrap_or("не удалось открыть файл");
                    log::error!("mpv end-file error: {err}");
                    let _ = app_events.emit("mpv-state", json!({ "name": "file-error", "data": err }));
                }
                _ => {}
            }
        }
        // Пайп закрылся (mpv умер сам, например файл битый) — снимаем
        // своё состояние, чтобы следующий mpv_create поднял плеер
        // заново, а не пытался говорить в мёртвый пайп, и сообщаем
        // фронтенду тем же каналом, чтобы не показывать замёршую кнопку
        // play вечно.
        log::warn!("пайп IPC закрылся — mpv, судя по всему, завершился сам (gen={generation})");
        let stale = {
            let mut guard = state().lock().await;
            match guard.as_ref() {
                Some(s) if s.generation == generation => guard.take(),
                _ => None,
            }
        };
        if let Some(mut s) = stale {
            let _ = s.child.kill();
            let _ = s.child.wait();
            destroy_window_on_main(&app_events, s.hwnd).await;
        }
        let _ = app_events.emit("mpv-state", json!({ "name": "exited", "data": true }));
    });

    *guard = Some(MpvState { generation, hwnd: hwnd_raw, child, write_half });
    Ok(())
}

pub async fn mpv_set_bounds(app: &tauri::AppHandle, bounds: MpvBounds) -> Result<(), String> {
    let hwnd_raw = {
        let guard = state().lock().await;
        guard.as_ref().ok_or("mpv не создан")?.hwnd
    };
    set_bounds_on_main(app, hwnd_raw, bounds).await
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

/// Проверки диапазонов вынесены в чистые функции — так они
/// юнит-тестируются без живого mpv и без асинхронного рантайма
/// (тот же приём, что analyze_samples в audio_qc.rs).
pub(crate) fn check_seek(seconds: f64) -> Result<f64, String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("Некорректная позиция перемотки.".into());
    }
    Ok(seconds)
}

pub(crate) fn check_volume(volume: f64) -> Result<f64, String> {
    if !volume.is_finite() || !(0.0..=150.0).contains(&volume) {
        return Err("Громкость должна быть от 0 до 150.".into());
    }
    Ok(volume)
}

pub(crate) fn check_speed(speed: f64) -> Result<f64, String> {
    if !speed.is_finite() || !(0.1..=4.0).contains(&speed) {
        return Err("Скорость должна быть от 0.1 до 4.0.".into());
    }
    Ok(speed)
}

pub async fn mpv_seek(seconds: f64) -> Result<(), String> {
    let seconds = check_seek(seconds)?;
    send_command(json!({ "command": ["seek", seconds, "absolute"] })).await
}

/// Громкость 0..150 — верх выше 100 % даёт сам mpv (программное
/// усиление); для проверки тихой дорожки на слух это иногда нужно.
pub async fn mpv_set_volume(volume: f64) -> Result<(), String> {
    let volume = check_volume(volume)?;
    send_command(json!({ "command": ["set_property", "volume", volume] })).await
}

pub async fn mpv_set_mute(mute: bool) -> Result<(), String> {
    send_command(json!({ "command": ["set_property", "mute", mute] })).await
}

/// Скорость воспроизведения без изменения тона (mpv по умолчанию держит
/// `audio-pitch-correction=yes`) — на укладке дубляжа медленный проход
/// по фразе нужен постоянно.
pub async fn mpv_set_speed(speed: f64) -> Result<(), String> {
    let speed = check_speed(speed)?;
    send_command(json!({ "command": ["set_property", "speed", speed] })).await
}

/// Шаг ровно на один кадр вперёд/назад — именно то, чем ставят точную
/// границу реплики; на глаз попасть в кадр перемоткой нельзя.
/// frame-back-step у mpv дороже по CPU (пересчёт от опорного кадра), но
/// это его штатная команда, своей альтернативы тут нет.
pub async fn mpv_frame_step(forward: bool) -> Result<(), String> {
    let cmd = if forward { "frame-step" } else { "frame-back-step" };
    send_command(json!({ "command": [cmd] })).await
}

/// Петля A-B — повтор куска между двумя метками. Для укладки дубляжа
/// это основной режим работы: реплику слушают по кругу, пока не лягут
/// в губы, а не перематывают каждый раз руками. `None` в обоих
/// аргументах снимает петлю.
pub async fn mpv_set_ab_loop(start: Option<f64>, end: Option<f64>) -> Result<(), String> {
    // "no" — как mpv обозначает «метка не задана»; передать null нельзя,
    // свойство строковое по своей природе.
    let a = match start {
        Some(v) => serde_json::json!(check_seek(v)?),
        None => serde_json::json!("no"),
    };
    let b = match end {
        Some(v) => serde_json::json!(check_seek(v)?),
        None => serde_json::json!("no"),
    };
    send_command(json!({ "command": ["set_property", "ab-loop-a", a] })).await?;
    send_command(json!({ "command": ["set_property", "ab-loop-b", b] })).await
}

/// Переключение дорожки: `kind` — "aid" (звук), "sid" (субтитры),
/// "vid" (картинка). `id` = -1 выключает дорожку совсем (например,
/// снять субтитры), иначе это номер дорожки из track-list.
pub async fn mpv_set_track(kind: &str, id: i64) -> Result<(), String> {
    let property = match kind {
        "audio" => "aid",
        "subtitle" => "sid",
        "video" => "vid",
        other => return Err(format!("Неизвестный тип дорожки: {other}")),
    };
    let value = if id < 0 { serde_json::json!("no") } else { serde_json::json!(id) };
    send_command(json!({ "command": ["set_property", property, value] })).await
}

/// Сохранить текущий кадр в файл. "video" — без наложенных субтитров и
/// экранного меню: студии нужен исходный кадр, а не скриншот плеера.
pub async fn mpv_screenshot(path: &str) -> Result<(), String> {
    send_command(json!({ "command": ["screenshot-to-file", path, "video"] })).await
}

/// Разрушает child-окно и завершает процесс mpv — вызывается и явно
/// (смена файла/закрытие модалки на JS-стороне), и должна быть безопасна
/// вызвать повторно (idempotent), если фронтенд позвал её на всякий
/// случай при закрытии, когда плеера и не было.
pub async fn mpv_close(app: &tauri::AppHandle) -> Result<(), String> {
    let taken = {
        let mut guard = state().lock().await;
        guard.take()
    };
    if let Some(mut s) = taken {
        // Сначала вежливо просим выйти (mpv успеет корректно отпустить
        // файл и устройство вывода), и только потом добиваем.
        let _ = s.write_half.write_all(b"{\"command\":[\"quit\"]}\n").await;
        let _ = s.child.kill();
        // wait() обязателен: без него дескриптор процесса остаётся у нас
        // до конца жизни приложения (на Windows — незакрытый handle,
        // на других ОС — зомби).
        let _ = s.child.wait();
        destroy_window_on_main(app, s.hwnd).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mpv_args_disable_user_config_and_terminal() {
        let args = mpv_args(1234, r"\\.\pipe\test");
        assert!(args.contains(&"--no-config".to_string()), "чужой mpv.conf ломает встраивание: {args:?}");
        assert!(args.contains(&"--load-scripts=no".to_string()));
        assert!(args.contains(&"--no-terminal".to_string()));
        assert!(args.contains(&"--wid=1234".to_string()));
        assert!(args.iter().any(|a| a.starts_with("--input-ipc-server=")));
    }

    #[test]
    fn hardware_decoding_stays_off() {
        // Проверено на реальной жалобе, что дело не в hwdec (см.
        // комментарий в mpv_args) — оставлено выключенным как безопасное
        // значение по умолчанию, не потому что доказано, что аппаратное
        // декодирование ломает картинку.
        let args = mpv_args(1, "p");
        assert!(args.contains(&"--hwdec=no".to_string()), "{args:?}");
        assert!(!args.iter().any(|a| a.starts_with("--hwdec=auto")), "{args:?}");
    }

    #[test]
    fn video_output_prefers_direct3d_with_fallback_to_gpu_next() {
        // direct3d — не DXGI flip-model VO, в отличие от gpu-next;
        // gpu-next остаётся запасным вариантом через запятую (формат
        // приоритета mpv, см. vo.rst), а не единственным выбором без
        // отката.
        let args = mpv_args(1, "p");
        assert!(
            args.contains(&"--vo=direct3d,gpu-next,".to_string()),
            "должен быть список с приоритетом direct3d и откатом на gpu-next: {args:?}"
        );
    }

    #[test]
    fn diagnostic_properties_do_not_clash_with_ui_ones() {
        // Оба списка уходят в observe_property одним проходом, и
        // совпадение id означало бы, что одно свойство молча
        // перезаписывает другое.
        for (id, name) in DIAGNOSTIC {
            assert!(
                !OBSERVED.iter().any(|(oid, _)| oid == id),
                "id {id} ({name}) уже занят в OBSERVED"
            );
        }
        // current-vo и current-ao — то, по чему панель отличает «играет»
        // от «декодирует в никуда»; без них диагностика теряет смысл.
        assert!(DIAGNOSTIC.iter().any(|(_, n)| *n == "current-vo"));
        assert!(DIAGNOSTIC.iter().any(|(_, n)| *n == "current-ao"));
    }

    #[test]
    fn range_checks_reject_out_of_range_values() {
        assert!(check_volume(-1.0).is_err());
        assert!(check_volume(1000.0).is_err());
        assert!(check_volume(f64::NAN).is_err());
        assert_eq!(check_volume(100.0), Ok(100.0));

        assert!(check_speed(0.0).is_err());
        assert!(check_speed(99.0).is_err());
        assert_eq!(check_speed(1.0), Ok(1.0));

        assert!(check_seek(f64::NAN).is_err());
        assert!(check_seek(f64::INFINITY).is_err());
        assert!(check_seek(-5.0).is_err());
        assert_eq!(check_seek(0.0), Ok(0.0));
    }
}
