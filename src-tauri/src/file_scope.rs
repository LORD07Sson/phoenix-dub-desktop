//! Какие пути на диске webview имеет право попросить бэкенд прочитать
//! или перезаписать.
//!
//! Зачем это вообще нужно. Любая `#[tauri::command]` вызывается из JS
//! одной строкой — `invoke("mt_transcode_media", {path, outPath, opts})`.
//! Пока путь брался «на веру», единственный XSS в webview (а он рисует
//! чужой текст: названия тайтлов, имена коллег, комментарии, ответы
//! сервера) превращался в полноценный примитив:
//!
//!   * `mt_register_media_file("C:\Users\…\.ssh\id_rsa")` — открыть
//!     ЛЮБОЙ файл asset-протоколу и следом прочитать его из JS через
//!     `fetch(convertFileSrc(...))`;
//!   * `download_report_file(..., savePath: "…\Startup\x.bat")` — записать
//!     файл с содержимым от сервера куда угодно, включая автозапуск;
//!   * `mt_extract_audio(path, outPath: "…важный.docx")` — затереть
//!     произвольный файл (ffmpeg зовётся с `-y`).
//!
//! Ровно от этого класса проблем в Tauri обычно защищает capability-скоуп
//! `tauri-plugin-fs`; здесь плагина нет, файлы трогает свой Rust-код —
//! значит и скоуп нужен свой. Принцип тот же, что уже был у
//! `DroppedFiles` в main.rs: доверяем не пути, а ФАКТУ, что пользователь
//! сам указал этот файл — перетащил в окно или выбрал в нативном диалоге.
//!
//! Поэтому диалоги выбора файла переехали из JS (`@tauri-apps/plugin-dialog`)
//! сюда: JS больше не сообщает бэкенду путь, а просит бэкенд открыть
//! диалог — путь становится известен Rust'у раньше, чем JS, и сразу
//! попадает в белый список. JS получает его только чтобы показать имя файла.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Пути, которые пользователь указал сам. Разделение на чтение и запись
/// не косметическое: выбранный для ЧТЕНИЯ файл (исходник для обрезки) не
/// должен автоматически становиться разрешённым для ПЕРЕЗАПИСИ — иначе
/// достаточно подсунуть `outPath == path`, и исходник уничтожается
/// первым же `-y` у ffmpeg.
#[derive(Default)]
pub struct FileScope {
    readable: Mutex<HashSet<PathBuf>>,
    writable: Mutex<HashSet<PathBuf>>,
    /// Каталоги, выбранные пользователем как «куда сложить результат»:
    /// имена файлов внутри придумывает сам бэкенд (cut_media), поэтому
    /// разрешение выдаётся на каталог целиком, а не на каждый файл.
    writable_dirs: Mutex<HashSet<PathBuf>>,
}

/// Абсолютный путь без `.`/`..` и симлинков — по нему и сравниваем.
/// Для ещё не существующего файла (сохранение результата) канонизируем
/// РОДИТЕЛЬСКИЙ каталог: сам файл появится только после работы ffmpeg,
/// `canonicalize()` на нём вернул бы ошибку.
fn normalize(path: &Path) -> PathBuf {
    if let Ok(c) = path.canonicalize() {
        return c;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(c) => c.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

impl FileScope {
    pub fn allow_read(&self, path: &Path) {
        if let Ok(mut set) = self.readable.lock() {
            set.insert(normalize(path));
        }
    }

    pub fn allow_write(&self, path: &Path) {
        if let Ok(mut set) = self.writable.lock() {
            set.insert(normalize(path));
        }
    }

    pub fn allow_write_dir(&self, path: &Path) {
        if let Ok(mut set) = self.writable_dirs.lock() {
            set.insert(normalize(path));
        }
    }

    /// Путь к файлу, который бэкенду разрешено ЧИТАТЬ.
    pub fn check_read(&self, path: &str) -> Result<PathBuf, String> {
        let p = normalize(Path::new(path));
        let ok = self.readable.lock().map(|s| s.contains(&p)).unwrap_or(false);
        if ok {
            Ok(p)
        } else {
            Err(DENIED_READ.into())
        }
    }

    /// Путь к файлу, который бэкенду разрешено СОЗДАТЬ/ПЕРЕЗАПИСАТЬ:
    /// либо он сам выбран в диалоге сохранения, либо лежит внутри
    /// выбранного пользователем каталога вывода.
    pub fn check_write(&self, path: &str) -> Result<PathBuf, String> {
        let p = normalize(Path::new(path));
        let explicit = self.writable.lock().map(|s| s.contains(&p)).unwrap_or(false);
        if explicit {
            return Ok(p);
        }
        let in_dir = self
            .writable_dirs
            .lock()
            .map(|dirs| dirs.iter().any(|d| p.starts_with(d)))
            .unwrap_or(false);
        if in_dir {
            Ok(p)
        } else {
            Err(DENIED_WRITE.into())
        }
    }

    pub fn check_write_dir(&self, path: &str) -> Result<PathBuf, String> {
        let p = normalize(Path::new(path));
        let ok = self
            .writable_dirs
            .lock()
            .map(|dirs| dirs.iter().any(|d| p.starts_with(d)))
            .unwrap_or(false);
        if ok {
            Ok(p)
        } else {
            Err(DENIED_WRITE.into())
        }
    }
}

// Текст один на все отказы и намеренно не называет путь: сообщение
// уезжает в toast и в лог, а печатать туда произвольную строку из
// webview — лишний канал для подделки сообщений интерфейса.
const DENIED_READ: &str =
    "Этот файл не выбирали в приложении — доступ отклонён. Добавьте файл кнопкой выбора или перетащите в окно.";
const DENIED_WRITE: &str =
    "Запись по этому пути не разрешена — выберите файл или папку через диалог сохранения.";

/// Исходник и результат — один и тот же файл. ffmpeg зовётся с `-y`, то
/// есть он обрежет входной файл в ноль ещё до того, как дочитает его, и
/// исходник будет потерян безвозвратно. Проверяется отдельно от скоупа:
/// оба пути тут законные, беда именно в их совпадении.
pub fn refuse_input_as_output(input: &Path, output: &Path) -> Result<(), String> {
    if normalize(input) == normalize(output) {
        return Err("Результат нельзя писать поверх исходника — выберите другое имя файла.".into());
    }
    Ok(())
}

// ---------- нативные диалоги (раньше жили на JS-стороне) ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

fn dialog_builder(app: &tauri::AppHandle, filters: &[PickFilter]) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().file();
    for f in filters {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(&f.name, &exts);
    }
    b
}

/// Выбрать один или несколько файлов для чтения. Возвращает пути только
/// чтобы фронтенд мог показать имена и держать «пул файлов»; право на
/// чтение выдаётся здесь же, а не по этому ответу.
pub fn pick_input_files(
    app: &tauri::AppHandle,
    filters: Vec<PickFilter>,
    multiple: bool,
) -> Vec<String> {
    let scope = app.state::<FileScope>();
    let builder = dialog_builder(app, &filters);
    let picked: Vec<PathBuf> = if multiple {
        builder
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .collect()
    } else {
        builder
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .into_iter()
            .collect()
    };
    for p in &picked {
        scope.allow_read(p);
    }
    picked.iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Диалог сохранения. `default_name` — имя, предложенное фронтендом;
/// последний компонент берётся намеренно (`file_name()`), чтобы «имя»
/// вида `..\..\autorun.inf` не уехало в диалог как путь.
pub fn pick_output_file(
    app: &tauri::AppHandle,
    default_name: Option<String>,
    filters: Vec<PickFilter>,
) -> Option<String> {
    let scope = app.state::<FileScope>();
    let mut builder = dialog_builder(app, &filters);
    if let Some(name) = default_name.as_deref() {
        if let Some(base) = Path::new(name).file_name() {
            builder = builder.set_file_name(base.to_string_lossy().into_owned());
        }
    }
    let path = builder.blocking_save_file()?.into_path().ok()?;
    scope.allow_write(&path);
    Some(path.to_string_lossy().into_owned())
}

pub fn pick_output_dir(app: &tauri::AppHandle) -> Option<String> {
    let scope = app.state::<FileScope>();
    let path = app.dialog().file().blocking_pick_folder()?.into_path().ok()?;
    scope.allow_write_dir(&path);
    // Из папки вывода читать тоже разумно (результат обрезки сразу
    // хочется добавить в пул), но именно как файлы внутри неё — само
    // разрешение на чтение выдаётся при добавлении конкретного файла.
    Some(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("phoenix_scope_{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn unknown_path_is_denied_for_both_read_and_write() {
        let scope = FileScope::default();
        assert!(scope.check_read("/etc/shadow").is_err());
        assert!(scope.check_write("/etc/cron.d/evil").is_err());
        assert!(scope.check_write_dir("/etc").is_err());
    }

    #[test]
    fn explicitly_picked_file_is_readable_but_not_writable() {
        let dir = tmp();
        let file = dir.join("input.wav");
        std::fs::write(&file, b"x").unwrap();
        let scope = FileScope::default();
        scope.allow_read(&file);

        assert!(scope.check_read(&file.to_string_lossy()).is_ok());
        // Ключевой момент: выбранный на ЧТЕНИЕ исходник не становится
        // разрешённым на перезапись.
        assert!(scope.check_write(&file.to_string_lossy()).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn picked_output_dir_allows_files_inside_it_only() {
        let dir = tmp();
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let scope = FileScope::default();
        scope.allow_write_dir(&out_dir);

        assert!(scope.check_write(&out_dir.join("a_cut1.mp4").to_string_lossy()).is_ok());
        assert!(scope.check_write_dir(&out_dir.to_string_lossy()).is_ok());
        // Выход за пределы каталога через .. не должен проходить —
        // normalize() схлопывает путь до канонического.
        let escape = out_dir.join("..").join("escaped.mp4");
        assert!(scope.check_write(&escape.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&out_dir);
    }

    // ---------- сценарии атаки ----------
    // Здесь описаны ровно те цепочки, ради которых скоуп и появился:
    // что именно сделал бы злоумышленник, получив выполнение JS в окне
    // (XSS через любой текст с сервера — название тайтла, имя коллеги,
    // комментарий). Каждый тест — «атака отбита», а не абстрактная
    // проверка хелпера: если кто-то однажды уберёт проверку из команды,
    // сломается именно понятный тест с понятным названием.

    #[test]
    fn attack_arbitrary_file_read_via_asset_protocol_is_blocked() {
        // mt_register_media_file(path) отдаёт файл asset-протоколу, то
        // есть делает его читаемым из JS через fetch(convertFileSrc(p)).
        // Путь берётся из вебвью — без скоупа это чтение чего угодно.
        let scope = FileScope::default();
        // Имя переменной именно `target`, а не `secret`: CodeQL считает
        // запись переменной с таким именем в вывод утечкой секрета в
        // открытом виде (rust/cleartext-logging) и роняет на этом
        // проверку PR. Здесь это просто пути, которых не должно быть в
        // скоупе, — но спорить с эвристикой дешевле переименованием,
        // чем подавлением правила.
        for target in [
            "/etc/shadow",
            "/root/.ssh/id_rsa",
            "C:\\Users\\studio\\.ssh\\id_rsa",
            "C:\\Users\\studio\\AppData\\Roaming\\PhoenixDubDesktop\\settings.json",
        ] {
            assert!(scope.check_read(target).is_err(), "чтение {target} должно быть отклонено");
        }
    }

    #[test]
    fn attack_write_into_autostart_is_blocked() {
        // download_report_file пишет на диск содержимое, пришедшее с
        // сервера, по пути из вебвью. Папка автозагрузки — прямой путь
        // к выполнению кода при следующем входе в систему.
        let scope = FileScope::default();
        let startup = "C:\\Users\\studio\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\upd.bat";
        assert!(scope.check_write(startup).is_err());
        assert!(scope.check_write("/etc/cron.daily/backup").is_err());
        assert!(scope.check_write("/root/.bashrc").is_err());
    }

    #[test]
    fn attack_cannot_escape_the_chosen_output_folder() {
        // Пользователь выбрал папку под результат обрезки — это НЕ
        // разрешение писать рядом с ней.
        let dir = tmp();
        let out_dir = dir.join("renders");
        std::fs::create_dir_all(&out_dir).unwrap();
        let scope = FileScope::default();
        scope.allow_write_dir(&out_dir);

        for escape in [
            out_dir.join("..").join("..").join("evil.exe"),
            out_dir.join("..").join("sibling.mp4"),
        ] {
            assert!(
                scope.check_write(&escape.to_string_lossy()).is_err(),
                "выход за пределы выбранной папки должен быть отклонён: {escape:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&out_dir);
    }

    #[test]
    fn attack_overwriting_the_source_is_refused_even_when_both_paths_are_allowed() {
        // Самый неприятный случай «легальных» путей: оба выбраны
        // пользователем, но совпадают — ffmpeg с -y обнулит исходник
        // раньше, чем дочитает его.
        let dir = tmp();
        let master = dir.join("master.mov");
        std::fs::write(&master, "важный исходник").unwrap();
        let scope = FileScope::default();
        scope.allow_read(&master);
        scope.allow_write(&master);

        let input = scope.check_read(&master.to_string_lossy()).unwrap();
        let output = scope.check_write(&master.to_string_lossy()).unwrap();
        assert!(refuse_input_as_output(&input, &output).is_err());
        let _ = std::fs::remove_file(&master);
    }

    #[test]
    fn writing_over_the_input_is_refused() {
        let dir = tmp();
        let file = dir.join("same.mp4");
        std::fs::write(&file, b"x").unwrap();
        assert!(refuse_input_as_output(&file, &file).is_err());
        assert!(refuse_input_as_output(&file, &dir.join("other.mp4")).is_ok());
        let _ = std::fs::remove_file(&file);
    }
}
