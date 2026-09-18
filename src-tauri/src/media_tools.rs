//! «Инструменты ffmpeg» — библиотека операций (обрезка/трим без
//! перекодирования, конвертация, извлечение/нормализация звука, склейка),
//! открытая кнопкой «🎬» в шапке рядом с QC звука (см. audio_qc.rs — тот же
//! ffmpeg-субпроцесс, но там только анализ; здесь — реальная перезапись
//! файлов на диск).
//!
//! Резолв бинарников (ffmpeg/ffprobe: bundled рядом с .exe, иначе PATH) и
//! обёртка Command с подавлением консольного окна на Windows —
//! переиспользуются из audio_qc.rs (bundled_binary_path/binary_runs/
//! resolve_binary_uncached/ffmpeg_command), дублировать эту логику здесь
//! незачем — она не специфична для QC.

use crate::audio_qc::{ffmpeg_command, hidden_command, resolve_binary_uncached, resolve_ffmpeg};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

pub(crate) fn resolve_ffprobe() -> &'static str {
    static RESOLVED: OnceLock<String> = OnceLock::new();
    RESOLVED.get_or_init(|| resolve_binary_uncached("ffprobe", "ffprobe.exe")).as_str()
}

// ---------- probe_media ----------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub codec: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub bit_rate: Option<u64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    pub container: String,
    pub video: Option<StreamInfo>,
    pub audio: Option<StreamInfo>,
}

/// `ffprobe -show_format -show_streams -of json` — тот же принцип
/// декодирования "любого файла" без знания заранее его контейнера/кодека,
/// что и decode_pcm в audio_qc.rs, но здесь нужны метаданные, а не сами
/// сэмплы, поэтому ffprobe, а не ffmpeg.
pub fn probe_media(path: &str) -> Result<MediaInfo, String> {
    let ffprobe = resolve_ffprobe();
    let output = ffmpeg_command(ffprobe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe не найден или не запустился ({ffprobe}): {e}."))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe не смог прочитать файл: {}", err.trim()));
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Не удалось разобрать вывод ffprobe: {e}"))?;

    let duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let container = json
        .get("format")
        .and_then(|f| f.get("format_name"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    let mut info = MediaInfo { duration, container, video: None, audio: None };
    if let Some(streams) = json.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let codec_type = s.get("codec_type").and_then(|v| v.as_str()).unwrap_or("");
            let codec = s.get("codec_name").and_then(|v| v.as_str()).unwrap_or("?").to_string();
            match codec_type {
                "video" if info.video.is_none() => {
                    // avg_frame_rate приходит строкой вида "25/1" или "0/0"
                    // (нет применимого значения, напр. у отдельных кадров) —
                    // раскладываем сами, серде тут не поможет.
                    let fps = s
                        .get("avg_frame_rate")
                        .and_then(|v| v.as_str())
                        .and_then(|s| {
                            let mut parts = s.split('/');
                            let num: f64 = parts.next()?.parse().ok()?;
                            let den: f64 = parts.next()?.parse().ok()?;
                            (den > 0.0).then_some(num / den)
                        });
                    info.video = Some(StreamInfo {
                        codec,
                        width: s.get("width").and_then(|v| v.as_u64()).map(|v| v as u32),
                        height: s.get("height").and_then(|v| v.as_u64()).map(|v| v as u32),
                        fps,
                        ..Default::default()
                    });
                }
                "audio" if info.audio.is_none() => {
                    info.audio = Some(StreamInfo {
                        codec,
                        channels: s.get("channels").and_then(|v| v.as_u64()).map(|v| v as u32),
                        sample_rate: s
                            .get("sample_rate")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u32>().ok()),
                        bit_rate: s
                            .get("bit_rate")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u64>().ok()),
                        ..Default::default()
                    });
                }
                _ => {}
            }
        }
    }
    Ok(info)
}

// ---------- probe_keyframes ----------

/// Секунды, на которых лежат опорные кадры видеодорожки — нужны фронтенду
/// для засечек на таймлайне и для "подъезда" начала сегмента к ближайшему
/// предыдущему keyframe перед lossless-резкой (см. cut_media ниже:
/// без перекодирования начать можно только с опорного кадра, иначе первые
/// кадры результата будут нечитаемы — картинка "поплывёт" до следующего
/// I-кадра). `-skip_frame nokey` — декодирует только опорные кадры,
/// на длинном видео это разы быстрее полного прохода.
pub fn probe_keyframes(path: &str) -> Result<Vec<f64>, String> {
    let ffprobe = resolve_ffprobe();
    let output = ffmpeg_command(ffprobe)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-skip_frame", "nokey",
            "-show_entries", "frame=pts_time",
            "-of", "csv=p=0",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe не найден или не запустился ({ffprobe}): {e}."))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe не смог найти опорные кадры: {}", err.trim()));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().filter_map(|l| l.trim().parse::<f64>().ok()).collect())
}

/// Ближайший опорный кадр НЕ ПОЗЖЕ запрошенного времени — резать раньше
/// него нельзя (кадров ещё нет), позже — можно, но тогда это уже не
/// запрошенная точка. Если кадров нет вовсе (аудио без видео, или список
/// пуст) — отдаём исходное время как есть, вызывающий код просто режет
/// без привязки к kadram.
fn snap_to_keyframe(requested: f64, keyframes: &[f64]) -> f64 {
    keyframes
        .iter()
        .copied()
        .filter(|&k| k <= requested)
        .fold(None, |acc: Option<f64>, k| Some(acc.map_or(k, |a| a.max(k))))
        .unwrap_or(requested)
}

// ---------- register_media_file (asset-protocol допуск) ----------

/// Единственный мост между выбранным пользователем файлом и вебвью:
/// разрешает asset-протоколу (см. tauri.conf.json: security.assetProtocol,
/// Cargo.toml: фича protocol-asset) отдавать конкретно этот путь, чтобы
/// фронтенд мог поставить его в <video src> через convertFileSrc(). Тот же
/// принцип допуска "только то, что пользователь явно выбрал сам", что и у
/// DroppedFiles в main.rs — просто источник доверия другой (openDialog,
/// не drag&drop), поэтому и список отдельный, не общий с DroppedFiles.
pub fn register_media_file(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| format!("Не удалось открыть файл для предпросмотра: {e}"))
}

// ---------- cut_media ----------

#[derive(Deserialize)]
pub struct CutSegment {
    pub start: f64,
    pub end: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutResult {
    /// Пути отдельных файлов-сегментов — пусто, если экспортировали
    /// только склейку (keep_separate=false).
    pub segment_paths: Vec<String>,
    /// Путь склеенного файла — None, если склейку не просили (merge=false).
    pub merged_path: Option<String>,
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "mp4".to_string())
}

/// Lossless "keyframe cut" — тот же режим, что у LosslessCut по умолчанию:
/// без перекодирования (-c copy), поэтому мгновенно и без потери качества,
/// но начало каждого сегмента подъезжает к ближайшему опорному кадру
/// (см. snap_to_keyframe) — точность до кадра здесь не гарантируется,
/// это осознанный компромисс ("smart cut" с перекодированием граничных
/// GOP — отдельная, намного более сложная фича, не в этой версии).
///
/// `keep_separate` и `merge` не взаимоисключающие — можно попросить и то,
/// и другое сразу: сначала режем каждый сегмент в out_dir, затем (если
/// merge) склеиваем эти же файлы вторым проходом через concat-demuxer,
/// и в конце удаляем промежуточные файлы, если их не просили оставить.
pub fn cut_media(
    progress: &Progress,
    path: &str,
    segments: &[CutSegment],
    out_dir: &str,
    keep_separate: bool,
    merge: bool,
) -> Result<CutResult, String> {
    if segments.is_empty() {
        return Err("Не выбрано ни одного сегмента.".into());
    }
    for s in segments {
        if !(s.start.is_finite() && s.end.is_finite() && s.start >= 0.0 && s.end > s.start) {
            return Err("Некорректный диапазон сегмента.".into());
        }
    }

    let keyframes = probe_keyframes(path).unwrap_or_default();
    let ext = ext_of(path);
    let stem = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cut".to_string());
    let out_dir = PathBuf::from(out_dir);

    // Доля шкалы прогресса на нарезку: если следом ещё склейка, ей
    // оставляем последние 15 % — иначе полоса «доезжает» до конца и потом
    // необъяснимо стоит на месте весь второй проход.
    let cut_span = if merge { 0.85 } else { 1.0 };
    let per_segment = cut_span / segments.len() as f64;

    let mut segment_paths = Vec::with_capacity(segments.len());
    for (i, s) in segments.iter().enumerate() {
        let snapped_start = snap_to_keyframe(s.start, &keyframes);
        let duration = s.end - snapped_start;
        let out_path = out_dir.join(format!("{stem}_cut{}.{ext}", i + 1));
        let args = vec![
            "-v".to_string(), "error".into(),
            "-y".into(),
            "-ss".into(), format!("{snapped_start:.3}"),
            "-i".into(), path.to_string(),
            "-t".into(), format!("{duration:.3}"),
            "-c".into(), "copy".into(),
        ];
        run_ffmpeg(
            progress,
            &args,
            &out_path,
            Stage {
                label: format!("Сегмент {} из {}", i + 1, segments.len()),
                base: per_segment * i as f64,
                span: per_segment,
                duration,
            },
        )
        .map_err(|e| format!("Сегмент {}: {e}", i + 1))?;
        segment_paths.push(out_path.to_string_lossy().into_owned());
    }

    let merged_path = if merge {
        let list = ConcatList::write(&segment_paths)?;
        let merged_path = out_dir.join(format!("{stem}_merged.{ext}"));
        let args = vec![
            "-v".to_string(), "error".into(),
            "-y".into(),
            "-f".into(), "concat".into(),
            "-safe".into(), "0".into(),
            "-i".into(), list.path.to_string_lossy().into_owned(),
            "-c".into(), "copy".into(),
        ];
        let total: f64 = segments.iter().map(|s| s.end - s.start).sum();
        run_ffmpeg(
            progress,
            &args,
            &merged_path,
            Stage { label: "Склейка сегментов".into(), base: cut_span, span: 1.0 - cut_span, duration: total },
        )
        .map_err(|e| format!("Склейка: {e}"))?;
        Some(merged_path.to_string_lossy().into_owned())
    } else {
        None
    };

    if !keep_separate {
        for p in &segment_paths {
            let _ = std::fs::remove_file(p);
        }
        segment_paths.clear();
    }

    Ok(CutResult { segment_paths, merged_path })
}

/// Список файлов для concat-демуксера. Раньше он писался в общий temp с
/// предсказуемым именем (`phoenix_concat_<pid>.txt`) — на машине с
/// несколькими пользователями это классический symlink-подставой путь, а
/// два параллельных запуска затирали список друг другу. Теперь — свой
/// каталог со случайным именем, и он же убирается за собой в Drop, даже
/// если операция упала или её отменили на середине.
struct ConcatList {
    path: PathBuf,
    dir: PathBuf,
}

impl ConcatList {
    fn write(paths: &[String]) -> Result<Self, String> {
        // Источник «случайности» без лишней зависимости: наносекунды от
        // старта эпохи + pid. Криптостойкость тут не нужна — нужна
        // невозможность угадать имя заранее и уникальность между
        // параллельными запусками.
        let unique = format!(
            "{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let dir = std::env::temp_dir().join(format!("phoenix_concat_{unique}"));
        std::fs::create_dir(&dir)
            .map_err(|e| format!("Не удалось подготовить список склейки: {e}"))?;
        let path = dir.join("list.txt");
        let body = paths
            .iter()
            // concat-демуксер: путь в одинарных кавычках, апостроф внутри
            // экранируется как '\'' (стандартная схема самого ffmpeg для
            // этого формата, не наша самодеятельность).
            .map(|p| format!("file '{}'\n", p.replace('\'', "'\\''")))
            .collect::<String>();
        std::fs::write(&path, body)
            .map_err(|e| format!("Не удалось подготовить список склейки: {e}"))?;
        Ok(Self { path, dir })
    }
}

impl Drop for ConcatList {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ---------- валидация параметров ----------
// Значения из TranscodeOpts/ExtractAudioOpts уезжают в argv ffmpeg.
// Инъекции команд тут нет по конструкции (Command::args — это argv, не
// строка для шелла), но «свободная строка» всё равно плохая идея: она
// либо даёт невнятную ошибку ffmpeg вместо понятного сообщения, либо
// подсовывает кодек/фильтр, которого мы не тестировали. Поэтому —
// закрытые списки и строгий формат битрейта.

const VIDEO_CODECS: &[&str] = &["copy", "libx264", "libx265", "libvpx-vp9", "libaom-av1", "mpeg4", "prores_ks"];
const AUDIO_CODECS: &[&str] = &["copy", "aac", "mp3", "libmp3lame", "flac", "libopus", "pcm_s16le", "pcm_s24le", "ac3"];

fn check_codec(value: &str, allowed: &[&str], kind: &str) -> Result<String, String> {
    if allowed.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(format!("Неизвестный {kind}-кодек: {value}"))
    }
}

/// Битрейт в записи самого ffmpeg: «128k», «2M», «4500000». Всё
/// остальное (включая попытку передать сюда ещё один аргумент) — отказ.
fn check_bitrate(value: &str) -> Result<String, String> {
    let v = value.trim();
    let (digits, suffix) = match v.strip_suffix(['k', 'K', 'm', 'M']) {
        Some(d) => (d, true),
        None => (v, false),
    };
    let ok = !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit() || c == '.')
        && digits.parse::<f64>().map(|n| n > 0.0).unwrap_or(false);
    if ok {
        Ok(if suffix { v.to_string() } else { digits.to_string() })
    } else {
        Err(format!("Некорректный битрейт: {value} (ожидается, например, 128k или 2M)"))
    }
}

/// Разумный потолок: 16K по большей стороне. Дело не в безопасности, а
/// в том, что опечатка в поле («19200» вместо «1920») иначе уходит в
/// ffmpeg и выливается в час работы и гигабайты на диске.
fn check_dimension(value: u32, name: &str) -> Result<u32, String> {
    if (1..=16384).contains(&value) {
        Ok(value)
    } else {
        Err(format!("{name} должна быть от 1 до 16384 пикселей."))
    }
}

// ---------- transcode_media ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscodeOpts {
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub video_bitrate: Option<String>, // "2M", "800k" — как принимает сам ffmpeg
    pub audio_bitrate: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub crf: Option<u32>,
}

/// Обычное перекодирование (в отличие от cut_media — здесь качество и
/// формат меняются осознанно, поэтому -c copy не подходит по определению).
/// Готовые пресеты ("MP4 для YouTube", "сжать для Telegram" и т.п.) живут
/// во фронтенде как заранее заполненные TranscodeOpts — здесь только
/// сборка ffmpeg-аргументов из того, что реально попросили, без своих
/// значений по умолчанию, кроме тех, что понятны без пресета (например,
/// codec, если он не выбран, разумно оставить ffmpeg решать по расширению
/// out_path — поэтому явные -c:v/-c:a пишутся только когда поле задано).
pub fn transcode_media(progress: &Progress, path: &str, out_path: &str, opts: &TranscodeOpts) -> Result<(), String> {
    // duration_hint — для расчёта доли выполнения в run_ffmpeg
    // (out_time_ms / duration); если пробинг не удался (повреждённый файл
    // и т.п.), просто не будет промежуточных обновлений прогресса — сама
    // операция всё равно продолжится и завершится нормально.
    let duration_hint = probe_media(path).map(|m| m.duration).unwrap_or(0.0);
    let args = transcode_args(path, out_path, opts)?;
    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage { label: "Перекодирование".into(), base: 0.0, span: 1.0, duration: duration_hint },
    )
}

/// Сборка argv вынесена отдельно от запуска — её можно проверить
/// юнит-тестом без ffmpeg (тот же приём, что analyze_samples в audio_qc.rs).
fn transcode_args(path: &str, out_path: &str, opts: &TranscodeOpts) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-y".into(), "-i".into(), path.into()];

    match (opts.width, opts.height) {
        (Some(w), Some(h)) => {
            let (w, h) = (check_dimension(w, "Ширина")?, check_dimension(h, "Высота")?);
            args.extend(["-vf".into(), format!("scale={w}:{h}")]);
        }
        (Some(w), None) => {
            let w = check_dimension(w, "Ширина")?;
            args.extend(["-vf".into(), format!("scale={w}:-2")]);
        }
        (None, Some(h)) => {
            let h = check_dimension(h, "Высота")?;
            args.extend(["-vf".into(), format!("scale=-2:{h}")]);
        }
        (None, None) => {}
    }

    let video_codec = opts
        .video_codec
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| check_codec(c, VIDEO_CODECS, "видео"))
        .transpose()?;
    if let Some(vc) = &video_codec {
        args.extend(["-c:v".into(), vc.clone()]);
        // H.264 в 10 бит или 4:2:2 (типичный исходник с камеры/ProRes)
        // формально валиден, но не играет ни в браузерах, ни в
        // телефонах, ни в половине плееров — а «универсальный MP4»
        // ровно за тем и выбирают, чтобы файл открылся у кого угодно.
        // Явный yuv420p убирает этот класс «файл собрался, но чёрный
        // экран у заказчика».
        if vc == "libx264" {
            args.extend(["-pix_fmt".into(), "yuv420p".into()]);
        }
    }
    if let Some(vb) = opts.video_bitrate.as_deref().filter(|v| !v.is_empty()) {
        args.extend(["-b:v".into(), check_bitrate(vb)?]);
    }
    if let Some(crf) = opts.crf {
        if crf > 63 {
            return Err("CRF должен быть от 0 до 63.".into());
        }
        args.extend(["-crf".into(), crf.to_string()]);
    }

    let audio_codec = opts
        .audio_codec
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| check_codec(c, AUDIO_CODECS, "аудио"))
        .transpose()?;
    if let Some(ac) = &audio_codec {
        args.extend(["-c:a".into(), ac.clone()]);
    }
    if let Some(ab) = opts.audio_bitrate.as_deref().filter(|v| !v.is_empty()) {
        args.extend(["-b:a".into(), check_bitrate(ab)?]);
    }

    // faststart переносит индекс (moov) в начало файла: без него mp4
    // начинает играть в браузере/телеграме только после полной загрузки.
    // Стоит один дополнительный проход по уже готовому файлу, на выходе
    // — единственный формат, который у студии реально уходит наружу.
    if matches!(ext_of(out_path).as_str(), "mp4" | "m4v" | "mov") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    Ok(args)
}

// ---------- extract_audio ----------

#[derive(Deserialize)]
pub struct ExtractAudioOpts {
    pub codec: String, // "copy" | "mp3" | "aac" | ...
    pub bitrate: Option<String>,
    pub normalize: bool,
}

/// Измеренные первым проходом loudnorm параметры дорожки.
#[derive(Debug, PartialEq)]
struct LoudnormMeasurement {
    input_i: String,
    input_tp: String,
    input_lra: String,
    input_thresh: String,
    target_offset: String,
}

/// Первый проход loudnorm: ffmpeg считает реальную громкость дорожки и
/// печатает её JSON-ом в stderr. Без этого прохода фильтр работает в
/// однопроходном режиме — он динамический, «на лету» подтягивает тихие
/// места и приминает громкие, то есть меняет динамику речи. Для дубляжа
/// это слышно: ровный по R128 файл, но с «дышащим» фоном. Двухпроходный
/// режим применяет ОДИН постоянный коэффициент, динамика дубля остаётся
/// как записали.
fn measure_loudness(path: &str) -> Option<LoudnormMeasurement> {
    let ffmpeg = resolve_ffmpeg();
    let output = ffmpeg_command(ffmpeg)
        .args([
            "-v", "error",
            "-i", path,
            "-vn",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
            "-f", "null",
            "-",
        ])
        .output()
        .ok()?;
    parse_loudnorm_json(&String::from_utf8_lossy(&output.stderr))
}

/// JSON лежит в хвосте stderr вперемешку с прочим выводом — берём
/// последнюю пару фигурных скобок, а не весь поток.
fn parse_loudnorm_json(stderr: &str) -> Option<LoudnormMeasurement> {
    let start = stderr.rfind('{')?;
    let end = stderr[start..].find('}')? + start + 1;
    let v: serde_json::Value = serde_json::from_str(&stderr[start..end]).ok()?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Some(LoudnormMeasurement {
        input_i: get("input_i")?,
        input_tp: get("input_tp")?,
        input_lra: get("input_lra")?,
        input_thresh: get("input_thresh")?,
        target_offset: get("target_offset")?,
    })
}

fn loudnorm_filter(measured: Option<&LoudnormMeasurement>) -> String {
    match measured {
        Some(m) => format!(
            "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true",
            m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset
        ),
        // Первый проход не удался (например, файл без звука вовсе) —
        // лучше однопроходная нормализация, чем никакой.
        None => "loudnorm=I=-16:TP=-1.5:LRA=11".to_string(),
    }
}

/// -vn — выкидываем видеодорожку (если она есть, для аудиофайла это
/// no-op). normalize — loudnorm (EBU R128) в два прохода, см.
/// measure_loudness; несовместим с codec="copy" (фильтры требуют
/// декодирования), поэтому при normalize=true copy откатывается на
/// "aac", а не молча игнорирует фильтр.
pub fn extract_audio(progress: &Progress, path: &str, out_path: &str, opts: &ExtractAudioOpts) -> Result<(), String> {
    let codec = if opts.normalize && opts.codec == "copy" { "aac" } else { opts.codec.as_str() };
    let codec = check_codec(codec, AUDIO_CODECS, "аудио")?;
    let bitrate = opts
        .bitrate
        .as_deref()
        .filter(|b| !b.is_empty())
        .map(check_bitrate)
        .transpose()?;

    let duration_hint = probe_media(path).map(|m| m.duration).unwrap_or(0.0);
    // Измерение — это ещё один полный проход по файлу, то есть примерно
    // половина всего времени операции; отражаем это в шкале, иначе
    // полоса стоит на нуле всю первую половину.
    let (measure_span, encode_base) = if opts.normalize { (0.45, 0.45) } else { (0.0, 0.0) };
    let measured = if opts.normalize {
        progress.report(0.0, "Измеряю громкость (EBU R128)");
        let m = measure_loudness(path);
        progress.report(measure_span, "Измеряю громкость (EBU R128)");
        if m.is_none() {
            log::warn!("loudnorm: первый проход не дал измерений, используем однопроходный режим");
        }
        m
    } else {
        None
    };

    let mut args: Vec<String> = vec![
        "-v".into(), "error".into(), "-y".into(), "-i".into(), path.into(), "-vn".into(),
        "-c:a".into(), codec,
    ];
    if let Some(b) = bitrate {
        args.extend(["-b:a".into(), b]);
    }
    if opts.normalize {
        args.extend(["-af".into(), loudnorm_filter(measured.as_ref())]);
    }

    run_ffmpeg(
        progress,
        &args,
        Path::new(out_path),
        Stage {
            label: if opts.normalize { "Нормализация и кодирование".into() } else { "Извлечение звука".into() },
            base: encode_base,
            span: 1.0 - encode_base,
            duration: duration_hint,
        },
    )
}

// ---------- concat_media ----------

/// Совпадают ли входы настолько, что можно склеить их без перекодирования
/// (-c copy через concat-demuxer) — тот же критерий, которым руководствуется
/// сам ffmpeg (concat-demuxer требует идентичных кодеков/параметров у всех
/// входов, иначе результат бьётся или вовсе не собирается): совпадающие
/// video-кодек+разрешение и совпадающий audio-кодек. Если у файла нет
/// видео или нет аудио — сравниваем только то, что есть у всех.
fn same_codecs(infos: &[MediaInfo]) -> bool {
    let first = match infos.first() {
        Some(f) => f,
        None => return false,
    };
    infos.iter().all(|m| {
        let video_ok = match (&m.video, &first.video) {
            (Some(a), Some(b)) => a.codec == b.codec && a.width == b.width && a.height == b.height,
            (None, None) => true,
            _ => false,
        };
        let audio_ok = match (&m.audio, &first.audio) {
            (Some(a), Some(b)) => a.codec == b.codec,
            (None, None) => true,
            _ => false,
        };
        video_ok && audio_ok
    })
}

/// Возвращает, каким путём прошла склейка — "copy" (быстро, без потерь)
/// или "reencode" (потребовалось перекодирование из-за разных кодеков у
/// входов) — фронтенд показывает это пользователю, а не гадает молча.
pub fn concat_media(progress: &Progress, paths: &[String], out_path: &str) -> Result<String, String> {
    if paths.len() < 2 {
        return Err("Нужно как минимум два файла для склейки.".into());
    }
    let infos: Vec<MediaInfo> = paths
        .iter()
        .map(|p| probe_media(p))
        .collect::<Result<_, _>>()?;
    let total: f64 = infos.iter().map(|i| i.duration).sum();
    let can_copy = same_codecs(&infos);

    if can_copy {
        let list = ConcatList::write(paths)?;
        let args = vec![
            "-v".to_string(), "error".into(),
            "-y".into(),
            "-f".into(), "concat".into(),
            "-safe".into(), "0".into(),
            "-i".into(), list.path.to_string_lossy().into_owned(),
            "-c".into(), "copy".into(),
        ];
        run_ffmpeg(
            progress,
            &args,
            Path::new(out_path),
            Stage { label: "Склейка без перекодирования".into(), base: 0.0, span: 1.0, duration: total },
        )?;
        Ok("copy".to_string())
    } else {
        // filter_complex concat — универсальный путь для разнородных
        // входов, но требует перекодирования: у каждого входа по одному
        // видео- и аудио-потоку ([i:v:0][i:a:0]...concat=n=N:v=1:a=1).
        // Он же требует, чтобы видео/аудио были у КАЖДОГО входа —
        // иначе ffmpeg падает с невнятным "Stream specifier ... matches
        // no streams", и раньше это доезжало до пользователя как есть.
        if infos.iter().any(|i| i.video.is_none()) || infos.iter().any(|i| i.audio.is_none()) {
            return Err(
                "Склейка с перекодированием требует, чтобы у всех файлов были и видео-, и аудио-дорожка. \
                 Уберите файлы без звука (или без картинки) из списка."
                    .into(),
            );
        }
        let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-y".into()];
        for p in paths {
            args.extend(["-i".into(), p.clone()]);
        }
        let filter = (0..paths.len())
            .map(|i| format!("[{i}:v:0][{i}:a:0]"))
            .collect::<String>()
            + &format!("concat=n={}:v=1:a=1[v][a]", paths.len());
        args.extend([
            "-filter_complex".into(), filter,
            "-map".into(), "[v]".into(),
            "-map".into(), "[a]".into(),
        ]);
        run_ffmpeg(
            progress,
            &args,
            Path::new(out_path),
            Stage { label: "Склейка с перекодированием".into(), base: 0.0, span: 1.0, duration: total },
        )?;
        Ok("reencode".to_string())
    }
}

// ---------- mux_media ----------
// Муксинг — собрать несколько отдельных дорожек (видео + несколько
// дублей аудио + субтитры, каждая уже свой файл) в один контейнер с
// подписанными языком/названием/флагом "по умолчанию" на дорожку —
// ровно то, чем в студии закрывают "видео отдельно, дубляж на разных
// языках отдельными файлами" перед раздачей зрителю. См. интерфейс-
// референс пользователя (Leo MultiTools) — секции Видео/Аудио/Субтитры,
// у каждой дорожки язык + имя + переключатель "по умолч.".

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxTrack {
    pub path: String,
    pub kind: String, // "video" | "audio" | "subtitle"
    pub language: Option<String>,
    pub title: Option<String>,
    pub is_default: bool,
}

/// Каждая дорожка — свой `-i` (проще и надёжнее, чем угадывать номер
/// потока внутри уже готового мультидорожечного файла: студия и так
/// хранит каждый дубляж/сабы отдельным файлом, см. референс), поэтому
/// `-map {i}:0` — просто первый (и обычно единственный) поток входа i.
/// `-c copy` — без перекодирования: муксинг меняет только контейнер и
/// метаданные, не сам сигнал. language/title/disposition пишутся через
/// `-metadata:s:{v|a|s}:{N}`/`-disposition:{v|a|s}:{N}` с отдельным
/// счётчиком N на каждый тип потока (нумерация потоков одного типа в
/// выходном файле, не общий индекс среди всех -map).
pub fn mux_media(tracks: &[MuxTrack], out_path: &str) -> Result<(), String> {
    if tracks.is_empty() {
        return Err("Не выбрано ни одной дорожки для муксинга.".into());
    }
    let ffmpeg = resolve_ffmpeg();
    let mut cmd = ffmpeg_command(ffmpeg);
    cmd.args(["-v", "error", "-y"]);
    for t in tracks {
        cmd.args(["-i", &t.path]);
    }
    for i in 0..tracks.len() {
        cmd.args(["-map", &format!("{i}:0")]);
    }
    cmd.args(["-c", "copy"]);
    // SRT/ASS в MP4 скопировать нельзя — контейнер их не держит, и
    // ffmpeg падает с "Subtitle codec 94213 not supported"; в MP4 нужен
    // свой формат субтитров (mov_text). Раньше пользователь получал эту
    // строку как есть и не понимал, что делать.
    let out_ext = ext_of(out_path);
    let has_subtitles = tracks.iter().any(|t| t.kind == "subtitle");
    if has_subtitles && matches!(out_ext.as_str(), "mp4" | "m4v" | "mov") {
        cmd.args(["-c:s", "mov_text"]);
    }

    let mut counters: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for t in tracks {
        let type_code = match t.kind.as_str() {
            "video" => "v",
            "audio" => "a",
            "subtitle" => "s",
            other => return Err(format!("Неизвестный тип дорожки: {other}")),
        };
        let idx = *counters.entry(type_code).or_insert(0);
        if let Some(lang) = t.language.as_deref().filter(|l| !l.is_empty()) {
            cmd.args([format!("-metadata:s:{type_code}:{idx}"), format!("language={lang}")]);
        }
        if let Some(title) = t.title.as_deref().filter(|s| !s.is_empty()) {
            cmd.args([format!("-metadata:s:{type_code}:{idx}"), format!("title={title}")]);
        }
        cmd.args([
            format!("-disposition:{type_code}:{idx}"),
            if t.is_default { "default".to_string() } else { "0".to_string() },
        ]);
        counters.insert(type_code, idx + 1);
    }
    cmd.arg(out_path);

    let output = cmd.output().map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg не смог смуксить файлы: {}", err.trim()));
    }
    Ok(())
}

// ---------- запуск ffmpeg: прогресс и отмена ----------

/// Куда на общей шкале 0..1 ложится конкретный запуск ffmpeg. Операция
/// может состоять из нескольких проходов (нарезка N сегментов + склейка;
/// измерение громкости + кодирование) — пользователю нужна ОДНА полоса,
/// а не мигающая от нуля на каждом проходе.
pub(crate) struct Stage {
    pub label: String,
    pub base: f64,
    pub span: f64,
    /// Длительность материала этого прохода в секундах; 0 — прогресс не
    /// считается (файл не удалось пробить ffprobe), полоса просто стоит
    /// на начале диапазона до конца прохода.
    pub duration: f64,
}

/// Куда модуль сообщает о ходе работы. Намеренно НЕ `tauri::AppHandle`:
/// операции ffmpeg сами по себе к окну приложения отношения не имеют, а
/// с этим типом они целиком проверяются интеграционными тестами ниже —
/// без запуска Tauri. Событие в вебвью шлёт вызывающая сторона
/// (main.rs), передавая сюда замыкание.
pub struct Progress<'a>(pub &'a (dyn Fn(f64, &str) + Sync));

impl Progress<'_> {
    fn report(&self, fraction: f64, label: &str) {
        (self.0)(fraction.clamp(0.0, 1.0), label);
    }
    /// Прогресс никуда не идёт. Нужен только тестам ниже (в приложении
    /// у каждой операции есть окно, куда его слать), поэтому cfg(test) —
    /// иначе обычная сборка ругается на неиспользуемую функцию.
    #[cfg(test)]
    pub fn silent() -> Progress<'static> {
        Progress(&|_, _| {})
    }
}

/// Текущий ffmpeg-процесс — один на приложение (панель инструментов не
/// даёт запустить вторую операцию, пока идёт первая). Держим его здесь,
/// чтобы кнопка «Отмена» из интерфейса могла до него дотянуться.
fn current_job() -> &'static std::sync::Mutex<Option<std::sync::Arc<std::sync::Mutex<Child>>>> {
    static JOB: OnceLock<std::sync::Mutex<Option<std::sync::Arc<std::sync::Mutex<Child>>>>> = OnceLock::new();
    JOB.get_or_init(|| std::sync::Mutex::new(None))
}

/// Отмену отличаем от настоящей ошибки: убитый ffmpeg возвращает
/// ненулевой код выхода, и без этого флага пользователь видел бы
/// «ffmpeg завершился с ошибкой» на собственное нажатие «Отмена».
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn cancel_current_job() -> Result<(), String> {
    let guard = current_job().lock().map_err(|_| "внутренняя ошибка блокировки")?;
    match guard.as_ref() {
        Some(child) => {
            CANCEL_REQUESTED.store(true, Ordering::SeqCst);
            if let Ok(mut c) = child.lock() {
                let _ = c.kill();
            }
            log::info!("операция ffmpeg отменена пользователем");
            Ok(())
        }
        None => Err("Сейчас нечего отменять — операция уже завершилась.".into()),
    }
}

/// Строка вида `ключ=значение` из `-progress`, а не текст ошибки.
/// Ошибки ffmpeg с `-v error` всегда начинаются либо с `[`, либо с
/// заглавной буквы — под этот шаблон они не попадают. Без фильтра весь
/// поток прогресса (frame=, fps=, speed=, progress=continue — по
/// двенадцать строк в секунду) подмешивался в текст ошибки, и настоящая
/// причина тонула в нём.
fn is_progress_line(line: &str) -> bool {
    match line.split_once('=') {
        Some((key, _)) => {
            !key.is_empty() && key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        }
        None => false,
    }
}

/// Запускает ffmpeg с `-progress pipe:2` (пишет ключ=значение построчно в
/// stderr) и на каждой строке `out_time_ms=` шлёт событие
/// `mediatool-progress`. Он же:
///   * регистрирует процесс, чтобы его можно было убить кнопкой «Отмена»;
///   * убирает за собой недописанный выходной файл — иначе после ошибки
///     или отмены на диске остаётся битый файл с правильным именем, и
///     его легко принять за готовый результат.
pub(crate) fn run_ffmpeg(
    progress: &Progress,
    args: &[String],
    out_path: &Path,
    stage: Stage,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg();
    // Существовал ли файл ДО запуска: если да, удалять его при ошибке
    // нельзя — это чужой файл, который пользователь выбрал сам (ffmpeg
    // с -y его, к сожалению, уже перезаписал, но убирать ещё и имя —
    // делать хуже).
    let existed_before = out_path.exists();

    let mut child = hidden_command(ffmpeg)
        .args(args)
        .args(["-progress", "pipe:2", "-nostats"])
        .arg(out_path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;

    let stderr = child.stderr.take().ok_or("не удалось получить поток ошибок ffmpeg")?;
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
    let handle = std::sync::Arc::new(std::sync::Mutex::new(child));
    if let Ok(mut slot) = current_job().lock() {
        *slot = Some(handle.clone());
    }

    progress.report(stage.base, &stage.label);
    let mut stderr_text = String::new();
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_ms=").and_then(|v| v.trim().parse::<f64>().ok()) {
            // Название поля у ffmpeg историческое: значение в
            // МИКРОсекундах, а не в миллисекундах (рядом лежит
            // out_time_us ровно с тем же числом).
            if stage.duration > 0.0 {
                let frac = ((us / 1_000_000.0) / stage.duration).clamp(0.0, 1.0);
                progress.report(stage.base + frac * stage.span, &stage.label);
            }
        } else if !is_progress_line(&line) {
            // Ошибка на повреждённом файле умеет быть многотысячной —
            // в сообщение пользователю столько не нужно, а в лог уедет
            // всё равно первая строка, она и информативна.
            if stderr_text.len() < 4000 {
                stderr_text.push_str(&line);
                stderr_text.push('\n');
            }
        }
    }

    let status = {
        let mut c = handle.lock().map_err(|_| "внутренняя ошибка блокировки")?;
        c.wait().map_err(|e| format!("ffmpeg завершился с ошибкой ожидания: {e}"))?
    };
    if let Ok(mut slot) = current_job().lock() {
        *slot = None;
    }

    let cancelled = CANCEL_REQUESTED.swap(false, Ordering::SeqCst);
    if cancelled {
        if !existed_before {
            let _ = std::fs::remove_file(out_path);
        }
        return Err("Операция отменена.".into());
    }
    if !status.success() {
        if !existed_before {
            let _ = std::fs::remove_file(out_path);
        }
        return Err(format!("ffmpeg завершился с ошибкой: {}", stderr_text.trim()));
    }
    progress.report(stage.base + stage.span, &stage.label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn ffmpeg_available() -> bool {
        Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    // ---------- чистые функции без ffmpeg ----------

    #[test]
    fn snap_to_keyframe_picks_nearest_not_after_requested() {
        let kf = vec![0.0, 2.0, 4.0, 6.0];
        assert_eq!(snap_to_keyframe(5.0, &kf), 4.0);
        assert_eq!(snap_to_keyframe(2.0, &kf), 2.0);
        assert_eq!(snap_to_keyframe(0.5, &kf), 0.0);
    }

    #[test]
    fn snap_to_keyframe_falls_back_to_requested_when_no_earlier_keyframe() {
        let kf = vec![10.0, 20.0];
        assert_eq!(snap_to_keyframe(5.0, &kf), 5.0);
    }

    #[test]
    fn snap_to_keyframe_falls_back_to_requested_when_list_empty() {
        assert_eq!(snap_to_keyframe(3.5, &[]), 3.5);
    }

    #[test]
    fn ext_of_reads_extension_or_defaults_to_mp4() {
        assert_eq!(ext_of("/tmp/clip.mkv"), "mkv");
        assert_eq!(ext_of("/tmp/noext"), "mp4");
    }

    #[test]
    fn same_codecs_true_for_identical_streams() {
        let a = MediaInfo {
            duration: 1.0,
            container: "mov,mp4".into(),
            video: Some(StreamInfo { codec: "h264".into(), width: Some(1920), height: Some(1080), ..Default::default() }),
            audio: Some(StreamInfo { codec: "aac".into(), ..Default::default() }),
        };
        let b = MediaInfo {
            duration: 2.0, // длительность не участвует в сравнении кодеков
            container: "mov,mp4".into(),
            video: Some(StreamInfo { codec: "h264".into(), width: Some(1920), height: Some(1080), ..Default::default() }),
            audio: Some(StreamInfo { codec: "aac".into(), ..Default::default() }),
        };
        assert!(same_codecs(&[a, b]));
    }

    #[test]
    fn same_codecs_false_for_mismatched_resolution() {
        let a = MediaInfo {
            duration: 1.0,
            container: "mov,mp4".into(),
            video: Some(StreamInfo { codec: "h264".into(), width: Some(1920), height: Some(1080), ..Default::default() }),
            audio: None,
        };
        let b = MediaInfo {
            duration: 1.0,
            container: "mov,mp4".into(),
            video: Some(StreamInfo { codec: "h264".into(), width: Some(1280), height: Some(720), ..Default::default() }),
            audio: None,
        };
        assert!(!same_codecs(&[a, b]));
    }

    #[test]
    fn same_codecs_empty_list_is_false() {
        assert!(!same_codecs(&[]));
    }

    // ---------- валидация параметров ----------

    #[test]
    fn bitrate_accepts_ffmpeg_notation_and_rejects_everything_else() {
        assert_eq!(check_bitrate("128k").unwrap(), "128k");
        assert_eq!(check_bitrate("2M").unwrap(), "2M");
        assert_eq!(check_bitrate(" 4500000 ").unwrap(), "4500000");
        assert!(check_bitrate("").is_err());
        assert!(check_bitrate("0").is_err());
        assert!(check_bitrate("128k -f null").is_err());
        assert!(check_bitrate("-b:v").is_err());
        assert!(check_bitrate("много").is_err());
    }

    #[test]
    fn codec_must_come_from_the_known_list() {
        assert!(check_codec("libx264", VIDEO_CODECS, "видео").is_ok());
        assert!(check_codec("aac", AUDIO_CODECS, "аудио").is_ok());
        assert!(check_codec("libx264", AUDIO_CODECS, "аудио").is_err());
        assert!(check_codec("-y", VIDEO_CODECS, "видео").is_err());
    }

    #[test]
    fn transcode_args_force_compatible_pixel_format_for_h264() {
        let opts = TranscodeOpts {
            video_codec: Some("libx264".into()),
            audio_codec: Some("aac".into()),
            video_bitrate: None,
            audio_bitrate: Some("128k".into()),
            width: None,
            height: Some(720),
            crf: Some(23),
        };
        let args = transcode_args("in.mov", "out.mp4", &opts).expect("валидные параметры");
        assert!(args.windows(2).any(|w| w == ["-pix_fmt", "yuv420p"]), "{args:?}");
        assert!(args.windows(2).any(|w| w == ["-vf", "scale=-2:720"]), "{args:?}");
        // faststart — только для контейнеров, где он вообще имеет смысл.
        assert!(args.windows(2).any(|w| w == ["-movflags", "+faststart"]), "{args:?}");
        let webm = transcode_args("in.mov", "out.webm", &opts).unwrap();
        assert!(!webm.iter().any(|a| a == "+faststart"), "{webm:?}");
    }

    #[test]
    fn transcode_args_reject_garbage_from_the_form() {
        let bad_codec = TranscodeOpts {
            video_codec: Some("; rm -rf /".into()),
            audio_codec: None, video_bitrate: None, audio_bitrate: None,
            width: None, height: None, crf: None,
        };
        assert!(transcode_args("in.mp4", "out.mp4", &bad_codec).is_err());

        let bad_size = TranscodeOpts {
            video_codec: None, audio_codec: None, video_bitrate: None, audio_bitrate: None,
            width: Some(999_999), height: None, crf: None,
        };
        assert!(transcode_args("in.mp4", "out.mp4", &bad_size).is_err());

        let bad_crf = TranscodeOpts {
            video_codec: None, audio_codec: None, video_bitrate: None, audio_bitrate: None,
            width: None, height: None, crf: Some(200),
        };
        assert!(transcode_args("in.mp4", "out.mp4", &bad_crf).is_err());
    }

    #[test]
    fn progress_lines_are_told_apart_from_real_errors() {
        assert!(is_progress_line("frame=125"));
        assert!(is_progress_line("out_time_ms=4992290"));
        assert!(is_progress_line("progress=continue"));
        assert!(is_progress_line("stream_0_0_q=-1.0"));
        assert!(!is_progress_line("[vost#0:0 @ 0x55] Unknown encoder 'NOSUCHCODEC'"));
        assert!(!is_progress_line("Error opening output file out.mp4."));
        assert!(!is_progress_line("Conversion failed!"));
    }

    #[test]
    fn loudnorm_measurement_is_read_from_ffmpeg_stderr() {
        // Формат ровно такой, каким его печатает сам ffmpeg
        // (loudnorm=print_format=json) — с предшествующим шумом в потоке.
        let stderr = r#"[Parsed_loudnorm_0 @ 0x55] 
{
	"input_i" : "-27.61",
	"input_tp" : "-9.32",
	"input_lra" : "5.20",
	"input_thresh" : "-37.88",
	"output_i" : "-16.02",
	"target_offset" : "0.29"
}
"#;
        let m = parse_loudnorm_json(stderr).expect("JSON должен разобраться");
        assert_eq!(m.input_i, "-27.61");
        assert_eq!(m.target_offset, "0.29");
        let filter = loudnorm_filter(Some(&m));
        assert!(filter.contains("measured_I=-27.61"), "{filter}");
        assert!(filter.contains("linear=true"), "{filter}");
        // Без измерений — однопроходный вариант, но не паника и не пустая строка.
        assert_eq!(loudnorm_filter(None), "loudnorm=I=-16:TP=-1.5:LRA=11");
        assert!(parse_loudnorm_json("совсем не json").is_none());
    }

    // ---------- интеграционные (нужен реальный ffmpeg/ffprobe в PATH) ----------
    // Тот же приём, что у export_clip_produces_wav_of_requested_duration в
    // audio_qc.rs: пропускаем, а не падаем, если на машине, где гоняют
    // тесты, ffmpeg не установлен вовсе.

    fn make_test_video(dir: &std::path::Path, name: &str, seconds: u32) -> String {
        let out = dir.join(name);
        let output = Command::new("ffmpeg")
            .args([
                "-v", "error", "-y",
                "-f", "lavfi", "-i", &format!("testsrc=duration={seconds}:size=320x240:rate=25"),
                "-f", "lavfi", "-i", &format!("sine=frequency=440:duration={seconds}"),
                "-c:v", "libx264", "-g", "25", "-c:a", "aac",
            ])
            .arg(&out)
            .output()
            .expect("не удалось сгенерировать тестовое видео");
        assert!(output.status.success(), "ffmpeg testsrc: {}", String::from_utf8_lossy(&output.stderr));
        out.to_string_lossy().into_owned()
    }

    #[test]
    fn probe_media_reads_duration_and_streams() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let src = make_test_video(&dir, "phoenix_mt_probe.mp4", 3);
        let info = probe_media(&src).expect("probe_media не должен падать на валидном файле");
        assert!((info.duration - 3.0).abs() < 0.2, "duration ~3s, получили {}", info.duration);
        assert_eq!(info.video.as_ref().unwrap().width, Some(320));
        assert_eq!(info.audio.as_ref().unwrap().codec, "aac");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn probe_keyframes_returns_at_least_one_point_at_start() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let src = make_test_video(&dir, "phoenix_mt_kf.mp4", 3);
        let kf = probe_keyframes(&src).expect("probe_keyframes не должен падать");
        // Не проверяем конкретное значение первой метки — оно зависит от
        // container/muxer edit-list деталей (может быть не 0.0 даже для
        // самого первого кадра потока), важно только что список не пуст
        // и упорядочен по возрастанию (snap_to_keyframe на этом опирается).
        assert!(!kf.is_empty(), "у 3-секундного видео с GOP=25 должен быть хотя бы один keyframe");
        let mut sorted = kf.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(kf, sorted, "ffprobe должен отдавать кадры по возрастанию времени");
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cut_media_rejects_empty_or_invalid_segments() {
        assert!(cut_media(&Progress::silent(), "whatever.mp4", &[], "/tmp", true, false).is_err());
        let bad = vec![CutSegment { start: 2.0, end: 1.0 }];
        assert!(cut_media(&Progress::silent(), "whatever.mp4", &bad, "/tmp", true, false).is_err());
    }

    #[test]
    fn cut_media_produces_separate_and_merged_outputs() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let src = make_test_video(&dir, "phoenix_mt_cut.mp4", 6);
        let segments = vec![
            CutSegment { start: 0.0, end: 2.0 },
            CutSegment { start: 3.0, end: 5.0 },
        ];
        let result = cut_media(&Progress::silent(), &src, &segments, &dir.to_string_lossy(), true, true)
            .expect("cut_media не должен падать на валидном входе");
        assert_eq!(result.segment_paths.len(), 2, "оба сегмента должны остаться (keep_separate=true)");
        assert!(result.merged_path.is_some(), "merge=true должен дать склеенный файл");
        for p in &result.segment_paths {
            assert!(std::path::Path::new(p).is_file());
            let _ = std::fs::remove_file(p);
        }
        let merged = result.merged_path.unwrap();
        let merged_info = probe_media(&merged).expect("склеенный файл должен читаться probe_media");
        // 2с + 2с сегментов (0-2 и 3-5) склеены подряд — итог около 4с.
        assert!((merged_info.duration - 4.0).abs() < 0.5, "ожидали ~4с, получили {}", merged_info.duration);
        let _ = std::fs::remove_file(&merged);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn cut_media_can_discard_separate_files_when_only_merge_requested() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let src = make_test_video(&dir, "phoenix_mt_cut_mergeonly.mp4", 4);
        let segments = vec![CutSegment { start: 0.0, end: 1.0 }, CutSegment { start: 2.0, end: 3.0 }];
        let result = cut_media(&Progress::silent(), &src, &segments, &dir.to_string_lossy(), false, true)
            .expect("cut_media не должен падать");
        assert!(result.segment_paths.is_empty(), "keep_separate=false — отдельных файлов быть не должно");
        assert!(result.merged_path.is_some());
        let merged = result.merged_path.unwrap();
        assert!(std::path::Path::new(&merged).is_file());
        let _ = std::fs::remove_file(&merged);
        let _ = std::fs::remove_file(&src);
    }

    #[test]
    fn extract_audio_produces_playable_audio_only_file() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let src = make_test_video(&dir, "phoenix_mt_audio.mp4", 2);
        let out = dir.join("phoenix_mt_audio_out.aac").to_string_lossy().into_owned();
        let opts = ExtractAudioOpts { codec: "aac".into(), bitrate: Some("128k".into()), normalize: false };
        extract_audio(&Progress::silent(), &src, &out, &opts).expect("extract_audio не должен падать");
        let info = probe_media(&out).expect("результат должен читаться probe_media");
        assert!(info.audio.is_some());
        assert!(info.video.is_none(), "видео-потока в результате быть не должно (-vn)");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn concat_media_rejects_single_file() {
        assert!(concat_media(&Progress::silent(), &["only-one.mp4".to_string()], "/tmp/out.mp4").is_err());
    }

    #[test]
    fn concat_media_uses_fast_copy_path_for_matching_inputs() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let a = make_test_video(&dir, "phoenix_mt_concat_a.mp4", 2);
        let b = make_test_video(&dir, "phoenix_mt_concat_b.mp4", 2);
        let out = dir.join("phoenix_mt_concat_out.mp4").to_string_lossy().into_owned();
        let mode = concat_media(&Progress::silent(), &[a.clone(), b.clone()], &out).expect("concat_media не должен падать");
        assert_eq!(mode, "copy", "одинаковые кодеки/разрешение — должен пойти быстрый путь");
        let info = probe_media(&out).expect("результат должен читаться");
        assert!((info.duration - 4.0).abs() < 0.5, "2с+2с ~ 4с, получили {}", info.duration);
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn cancel_kills_the_job_and_removes_the_half_written_file() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let src = make_test_video(&dir, "phoenix_mt_cancel_src.mp4", 30);
        let out = dir.join("phoenix_mt_cancel_out.mp4");
        let _ = std::fs::remove_file(&out);

        // Отмену шлём из другого потока, как это делает кнопка в
        // интерфейсе: сама операция в это время блокирует свой поток.
        let canceller = std::thread::spawn(|| {
            // Дать ffmpeg реально стартовать — до spawn отменять нечего.
            for _ in 0..100 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if cancel_current_job().is_ok() {
                    return true;
                }
            }
            false
        });

        // Заведомо медленное кодирование, чтобы успеть отменить.
        let opts = TranscodeOpts {
            video_codec: Some("libx264".into()),
            audio_codec: Some("aac".into()),
            video_bitrate: None,
            audio_bitrate: None,
            width: Some(1920),
            height: Some(1080),
            crf: Some(0),
        };
        let result = transcode_media(&Progress::silent(), &src, &out.to_string_lossy(), &opts);
        let cancelled_in_time = canceller.join().unwrap();

        if cancelled_in_time {
            let err = result.expect_err("отменённая операция не должна считаться успешной");
            assert!(err.contains("отменена"), "отмена не должна выглядеть как ошибка ffmpeg: {err}");
            assert!(!out.exists(), "недописанный файл должен быть убран, а не выдан за результат");
        } else {
            eprintln!("не успели отменить (машина слишком быстрая) — проверять нечего");
        }
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn cancel_without_a_running_job_is_an_explicit_error() {
        assert!(cancel_current_job().is_err());
    }

    #[test]
    fn mux_media_rejects_empty_tracks() {
        assert!(mux_media(&[], "/tmp/out.mkv").is_err());
    }

    #[test]
    fn mux_media_rejects_unknown_kind() {
        let tracks = vec![MuxTrack {
            path: "whatever.mp4".into(),
            kind: "banana".into(),
            language: None,
            title: None,
            is_default: false,
        }];
        assert!(mux_media(&tracks, "/tmp/out.mkv").is_err());
    }

    fn make_test_audio(dir: &std::path::Path, name: &str, seconds: u32) -> String {
        let out = dir.join(name);
        let output = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("sine=frequency=440:duration={seconds}"), "-c:a", "aac"])
            .arg(&out)
            .output()
            .expect("не удалось сгенерировать тестовое аудио");
        assert!(output.status.success(), "ffmpeg sine: {}", String::from_utf8_lossy(&output.stderr));
        out.to_string_lossy().into_owned()
    }

    #[test]
    fn mux_media_combines_video_and_audio_with_language_and_default() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let video = make_test_video(&dir, "phoenix_mt_mux_video.mp4", 2);
        let audio_ru = make_test_audio(&dir, "phoenix_mt_mux_audio_ru.aac", 2);
        let audio_en = make_test_audio(&dir, "phoenix_mt_mux_audio_en.aac", 2);
        let out = dir.join("phoenix_mt_mux_out.mkv").to_string_lossy().into_owned();

        let tracks = vec![
            MuxTrack { path: video.clone(), kind: "video".into(), language: None, title: None, is_default: true },
            MuxTrack { path: audio_ru.clone(), kind: "audio".into(), language: Some("rus".into()), title: Some("DUB - Тест".into()), is_default: true },
            MuxTrack { path: audio_en.clone(), kind: "audio".into(), language: Some("eng".into()), title: Some("DUB - Test".into()), is_default: false },
        ];
        mux_media(&tracks, &out).expect("mux_media не должен падать на валидном входе");

        let info = probe_media(&out).expect("результат должен читаться probe_media");
        assert!(info.video.is_some(), "видео-поток должен быть в результате");
        assert!(info.audio.is_some(), "хотя бы один аудио-поток должен быть в результате");

        // Число аудио-потоков и их language/disposition — probe_media
        // отдаёт только первый поток каждого типа, для точной проверки
        // метаданных читаем ffprobe напрямую тем же приёмом, что и сам
        // probe_media (JSON), без расширения MediaInfo ради одного теста.
        let ffprobe_out = Command::new(resolve_ffprobe())
            .args(["-v", "error", "-select_streams", "a", "-show_entries", "stream_tags=language,title:stream_disposition=default", "-of", "json"])
            .arg(&out)
            .output()
            .expect("ffprobe должен запуститься");
        let json: serde_json::Value = serde_json::from_slice(&ffprobe_out.stdout).expect("ffprobe должен отдать валидный JSON");
        let streams = json["streams"].as_array().expect("streams должен быть массивом");
        assert_eq!(streams.len(), 2, "должно быть ровно два аудио-потока");
        assert_eq!(streams[0]["tags"]["language"], "rus");
        assert_eq!(streams[0]["disposition"]["default"], 1);
        assert_eq!(streams[1]["tags"]["language"], "eng");
        assert_eq!(streams[1]["disposition"]["default"], 0);

        let _ = std::fs::remove_file(&video);
        let _ = std::fs::remove_file(&audio_ru);
        let _ = std::fs::remove_file(&audio_en);
        let _ = std::fs::remove_file(&out);
    }
}
