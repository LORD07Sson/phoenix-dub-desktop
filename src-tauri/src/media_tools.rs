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

use crate::audio_qc::{ffmpeg_command, resolve_binary_uncached, resolve_ffmpeg};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
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
    let ffmpeg = resolve_ffmpeg();
    let ext = ext_of(path);
    let stem = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cut".to_string());
    let out_dir = PathBuf::from(out_dir);

    let mut segment_paths = Vec::with_capacity(segments.len());
    for (i, s) in segments.iter().enumerate() {
        let snapped_start = snap_to_keyframe(s.start, &keyframes);
        let duration = s.end - snapped_start;
        let out_path = out_dir.join(format!("{stem}_cut{}.{ext}", i + 1));
        let output = ffmpeg_command(ffmpeg)
            .args([
                "-v", "error",
                "-y",
                "-ss", &format!("{snapped_start:.3}"),
                "-i", path,
                "-t", &format!("{duration:.3}"),
                "-c", "copy",
            ])
            .arg(&out_path)
            .output()
            .map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg не смог вырезать сегмент {}: {}", i + 1, err.trim()));
        }
        segment_paths.push(out_path.to_string_lossy().into_owned());
    }

    let merged_path = if merge {
        let list_path = std::env::temp_dir().join(format!(
            "phoenix_cut_concat_{}.txt",
            std::process::id()
        ));
        let list_body = segment_paths
            .iter()
            // concat-demuxer формат — путь в одинарных кавычках, апостроф
            // внутри пути экранируется как '\'' (стандартная escape-схема
            // самого ffmpeg для этого формата, не наша самодеятельность).
            .map(|p| format!("file '{}'\n", p.replace('\'', "'\\''")))
            .collect::<String>();
        std::fs::write(&list_path, list_body)
            .map_err(|e| format!("Не удалось подготовить список склейки: {e}"))?;

        let merged_path = out_dir.join(format!("{stem}_merged.{ext}"));
        let output = ffmpeg_command(ffmpeg)
            .args(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
            .arg(&list_path)
            .args(["-c", "copy"])
            .arg(&merged_path)
            .output();
        let _ = std::fs::remove_file(&list_path);
        let output = output.map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg не смог склеить сегменты: {}", err.trim()));
        }
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
pub fn transcode_media(app: &tauri::AppHandle, path: &str, out_path: &str, opts: &TranscodeOpts) -> Result<(), String> {
    // duration_hint — для расчёта доли выполнения в run_ffmpeg_with_progress
    // (out_time_ms / duration); если пробинг не удался (повреждённый файл
    // и т.п.), просто не будет промежуточных обновлений прогресса — сама
    // операция всё равно продолжится и завершится нормально.
    let duration_hint = probe_media(path).map(|m| m.duration).unwrap_or(0.0);

    let mut args: Vec<String> = vec!["-v".into(), "error".into(), "-y".into(), "-i".into(), path.into()];
    if let Some(w) = opts.width {
        let h = opts.height.map(|h| h.to_string()).unwrap_or_else(|| "-2".to_string());
        args.extend(["-vf".into(), format!("scale={w}:{h}")]);
    } else if let Some(h) = opts.height {
        args.extend(["-vf".into(), format!("scale=-2:{h}")]);
    }
    if let Some(vc) = &opts.video_codec {
        args.extend(["-c:v".into(), vc.clone()]);
    }
    if let Some(vb) = &opts.video_bitrate {
        args.extend(["-b:v".into(), vb.clone()]);
    }
    if let Some(crf) = opts.crf {
        args.extend(["-crf".into(), crf.to_string()]);
    }
    if let Some(ac) = &opts.audio_codec {
        args.extend(["-c:a".into(), ac.clone()]);
    }
    if let Some(ab) = &opts.audio_bitrate {
        args.extend(["-b:a".into(), ab.clone()]);
    }

    run_ffmpeg_with_progress(app, &args, out_path, duration_hint)
}

// ---------- extract_audio ----------

#[derive(Deserialize)]
pub struct ExtractAudioOpts {
    pub codec: String, // "copy" | "mp3" | "aac" | ...
    pub bitrate: Option<String>,
    pub normalize: bool,
}

/// -vn — выкидываем видеодорожку (если она есть, для аудиофайла это
/// no-op). normalize — фильтр loudnorm (EBU R128), тот же алгоритм, что
/// используют профессиональные инструменты нормализации громкости;
/// несовместим с codec="copy" (фильтры требуют декодирования), поэтому
/// при normalize=true copy откатывается на "aac", а не молча игнорирует
/// фильтр.
pub fn extract_audio(path: &str, out_path: &str, opts: &ExtractAudioOpts) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg();
    let mut cmd = ffmpeg_command(ffmpeg);
    cmd.args(["-v", "error", "-y", "-i", path, "-vn"]);

    let codec = if opts.normalize && opts.codec == "copy" { "aac" } else { opts.codec.as_str() };
    cmd.args(["-c:a", codec]);
    if let Some(b) = &opts.bitrate {
        cmd.args(["-b:a", b]);
    }
    if opts.normalize {
        cmd.args(["-af", "loudnorm"]);
    }
    cmd.arg(out_path);

    let output = cmd.output().map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg не смог извлечь звук: {}", err.trim()));
    }
    Ok(())
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
pub fn concat_media(paths: &[String], out_path: &str) -> Result<String, String> {
    if paths.len() < 2 {
        return Err("Нужно как минимум два файла для склейки.".into());
    }
    let infos: Vec<MediaInfo> = paths
        .iter()
        .map(|p| probe_media(p))
        .collect::<Result<_, _>>()?;
    let can_copy = same_codecs(&infos);
    let ffmpeg = resolve_ffmpeg();

    if can_copy {
        let list_path = std::env::temp_dir().join(format!(
            "phoenix_concat_{}.txt",
            std::process::id()
        ));
        let list_body = paths
            .iter()
            .map(|p| format!("file '{}'\n", p.replace('\'', "'\\''")))
            .collect::<String>();
        std::fs::write(&list_path, list_body)
            .map_err(|e| format!("Не удалось подготовить список склейки: {e}"))?;
        let output = ffmpeg_command(ffmpeg)
            .args(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i"])
            .arg(&list_path)
            .args(["-c", "copy"])
            .arg(out_path)
            .output();
        let _ = std::fs::remove_file(&list_path);
        let output = output.map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg не смог склеить файлы: {}", err.trim()));
        }
        Ok("copy".to_string())
    } else {
        // filter_complex concat — универсальный путь для разнородных
        // входов, но требует перекодирования: у каждого входа по одному
        // видео- и аудио-потоку ([i:v:0][i:a:0]...concat=n=N:v=1:a=1).
        let mut cmd = ffmpeg_command(ffmpeg);
        cmd.args(["-v", "error", "-y"]);
        for p in paths {
            cmd.args(["-i", p]);
        }
        let filter = (0..paths.len())
            .map(|i| format!("[{i}:v:0][{i}:a:0]"))
            .collect::<String>()
            + &format!("concat=n={}:v=1:a=1[v][a]", paths.len());
        cmd.args(["-filter_complex", &filter, "-map", "[v]", "-map", "[a]"]);
        cmd.arg(out_path);
        let output = cmd.output().map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg не смог склеить файлы с перекодированием: {}", err.trim()));
        }
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

// ---------- прогресс длинных операций ----------

/// Запускает ffmpeg с `-progress pipe:2` (пишет ключ=значение построчно в
/// stderr, а не в stdout — stdout мы уже не читаем нигде для прогресса,
/// но -v error и так пишет туда ошибки; разносим потоки, чтобы не
/// смешивать машинно-читаемый прогресс с текстом ошибки) и на каждой
/// строке `out_time_ms=` шлёт событие `mediatool-progress` с долей
/// выполнения (0..1), посчитанной от duration_hint. Используется
/// операциями, которые реально долго идут на большом файле (транскод,
/// конкат с перекодированием) — lossless-резка (-c copy) быстра и своего
/// прогресса не эмитит, там пользователю нечего ждать.
pub(crate) fn run_ffmpeg_with_progress(
    app: &tauri::AppHandle,
    args: &[String],
    out_path: &str,
    duration_hint: f64,
) -> Result<(), String> {
    use tauri::Emitter;
    let ffmpeg = resolve_ffmpeg();
    let mut cmd = ffmpeg_command(ffmpeg);
    cmd.args(args)
        .args(["-progress", "pipe:2", "-nostats"])
        .arg(out_path)
        .stderr(Stdio::piped())
        .stdout(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg не найден или не запустился ({ffmpeg}): {e}."))?;
    let stderr = child.stderr.take().expect("stderr должен быть piped");
    let mut stderr_text = String::new();
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if let Some(ms) = line.strip_prefix("out_time_ms=").and_then(|v| v.trim().parse::<f64>().ok()) {
            if duration_hint > 0.0 {
                let frac = ((ms / 1_000_000.0) / duration_hint).clamp(0.0, 1.0);
                let _ = app.emit("mediatool-progress", frac);
            }
        } else {
            stderr_text.push_str(&line);
            stderr_text.push('\n');
        }
    }
    let status = child.wait().map_err(|e| format!("ffmpeg завершился с ошибкой ожидания: {e}"))?;
    let _ = app.emit("mediatool-progress", 1.0_f64);
    if !status.success() {
        return Err(format!("ffmpeg завершился с ошибкой: {}", stderr_text.trim()));
    }
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
        assert!(cut_media("whatever.mp4", &[], "/tmp", true, false).is_err());
        let bad = vec![CutSegment { start: 2.0, end: 1.0 }];
        assert!(cut_media("whatever.mp4", &bad, "/tmp", true, false).is_err());
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
        let result = cut_media(&src, &segments, &dir.to_string_lossy(), true, true)
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
        let result = cut_media(&src, &segments, &dir.to_string_lossy(), false, true)
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
        extract_audio(&src, &out, &opts).expect("extract_audio не должен падать");
        let info = probe_media(&out).expect("результат должен читаться probe_media");
        assert!(info.audio.is_some());
        assert!(info.video.is_none(), "видео-потока в результате быть не должно (-vn)");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn concat_media_rejects_single_file() {
        assert!(concat_media(&["only-one.mp4".to_string()], "/tmp/out.mp4").is_err());
    }

    #[test]
    fn concat_media_uses_fast_copy_path_for_matching_inputs() {
        if !ffmpeg_available() { eprintln!("ffmpeg недоступен — пропускаем"); return; }
        let dir = std::env::temp_dir();
        let a = make_test_video(&dir, "phoenix_mt_concat_a.mp4", 2);
        let b = make_test_video(&dir, "phoenix_mt_concat_b.mp4", 2);
        let out = dir.join("phoenix_mt_concat_out.mp4").to_string_lossy().into_owned();
        let mode = concat_media(&[a.clone(), b.clone()], &out).expect("concat_media не должен падать");
        assert_eq!(mode, "copy", "одинаковые кодеки/разрешение — должен пойти быстрый путь");
        let info = probe_media(&out).expect("результат должен читаться");
        assert!((info.duration - 4.0).abs() < 0.5, "2с+2с ~ 4с, получили {}", info.duration);
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
        let _ = std::fs::remove_file(&out);
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
