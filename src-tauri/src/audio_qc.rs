//! Локальный QC звука — переносит логику из старой Python-версии
//! (`audio_qc.py` в прежнем PySide6-клиенте): клиппинг, слишком тихие/шумные
//! куски, длинные паузы. Без Silero VAD (лишняя зависимость для десктопа) —
//! паузы ищутся порогом громкости, как и в прежней реализации.
//!
//! Декодирование — через `ffmpeg`. Раньше требовался ffmpeg в PATH — теперь
//! сначала пробуем версию, лежащую рядом с самим приложением, и только
//! если её нет, откатываемся на системный PATH. Так у пользователя ничего
//! не нужно ставить отдельно, но у кого-то PATH тоже сработает как раньше.
//! Рядом с .exe ffmpeg кладёт не bundle.resources (bundle в
//! tauri.conf.json выключен — пакует Velopack, а не tauri-bundler), а
//! шаг `vpk pack` в CI: он копирует и сам бинарник, и ffmpeg.exe в одну
//! директорию pack_dir/ (см. build.yml).

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Приложение собрано как GUI (windows_subsystem = "windows"), но у
/// запускаемого из него процесса своя консоль — и Windows показывает её
/// отдельным чёрным окном, мигающим поверх интерфейса на каждый запуск
/// ffmpeg. CREATE_NO_WINDOW это отключает.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn ffmpeg_command(exe: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[derive(Serialize, Clone)]
pub struct QcFinding {
    pub kind: String,      // "clipping" | "silence" | "quiet" | "loud"
    pub start: f64,        // секунды
    pub end: f64,
    pub severity: String,  // "warn" | "error"
    pub message: String,
}

#[derive(Serialize)]
pub struct QcReport {
    pub duration: f64,
    pub findings: Vec<QcFinding>,
    pub peak_dbfs: f64,
    pub rms_dbfs: f64,
}

const SAMPLE_RATE: u32 = 16_000;
const CLIP_THRESHOLD: i32 = 32_600; // почти предел i16 (32767) — считаем клиппингом
const SILENCE_RMS_THRESHOLD: f64 = 0.006; // линейная амплитуда, ~-44 дБФС
const MIN_SILENCE_SECONDS: f64 = 1.2;
const WINDOW_SECONDS: f64 = 0.05;

pub fn analyze(path: &str) -> Result<QcReport, String> {
    let samples = decode_pcm(path)?;
    analyze_samples(&samples)
}

/// Путь к ffmpeg рядом с исполняемым файлом приложения, если он там
/// есть (packaged-вариант) — иначе `None`, и вызывающий код откатится
/// на системный PATH. `current_exe()` — тот же приём, что использует
/// сам Tauri для поиска sidecar-бинарников.
fn bundled_ffmpeg_path() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = exe_dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
    candidate.is_file().then_some(candidate)
}

/// Быстрая проверка, что найденный ffmpeg реально запускается на этой
/// системе (не битый архитектурно/повреждённый файл) — лучше явно
/// сказать об этом и откатиться на PATH, чем один раз молча упасть на
/// декодировании реального файла с непонятной ошибкой.
fn ffmpeg_supported(exe: &std::path::Path) -> bool {
    ffmpeg_command(exe)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Резолвит, каким ffmpeg пользоваться: сначала bundled рядом с .exe
/// (если он реально запускается), иначе — просто "ffmpeg" из PATH.
/// Результат кэшируется на процесс: проверка `-version` — это ещё один
/// запуск процесса, делать его перед КАЖДЫМ анализом файла незачем.
fn resolve_ffmpeg() -> &'static str {
    static RESOLVED: OnceLock<String> = OnceLock::new();
    RESOLVED.get_or_init(resolve_ffmpeg_uncached).as_str()
}

fn resolve_ffmpeg_uncached() -> String {
    if let Some(bundled) = bundled_ffmpeg_path() {
        if ffmpeg_supported(&bundled) {
            return bundled.to_string_lossy().into_owned();
        }
        // Лежит рядом, но не запускается (например, собран не под ту
        // архитектуру) — не тихо молчим, а пробуем PATH дальше.
        eprintln!("bundled ffmpeg найден по пути {:?}, но не запустился — используем PATH", bundled);
    }
    "ffmpeg".to_string()
}

/// Собственно анализ — вынесена из `analyze` отдельно от decode_pcm, чтобы
/// её можно было юнит-тестировать на синтетических сэмплах без реального
/// аудиофайла и без запуска ffmpeg (см. тесты внизу файла).
fn analyze_samples(samples: &[i16]) -> Result<QcReport, String> {
    if samples.is_empty() {
        return Err("Не удалось прочитать аудио — файл пуст или повреждён.".into());
    }

    let duration = samples.len() as f64 / SAMPLE_RATE as f64;
    let window_len = ((WINDOW_SECONDS * SAMPLE_RATE as f64) as usize).max(1);

    let mut findings = Vec::new();
    let mut peak: i32 = 0;
    let mut sum_sq: f64 = 0.0;
    for &s in samples {
        let a = (s as i32).abs();
        if a > peak {
            peak = a;
        }
        sum_sq += (s as f64) * (s as f64);
    }
    let rms = (sum_sq / samples.len() as f64).sqrt();
    let peak_dbfs = amplitude_to_dbfs(peak as f64 / 32768.0);
    let rms_dbfs = amplitude_to_dbfs(rms / 32768.0);

    // Клиппинг — ищем подряд идущие сэмплы на пределе шкалы.
    let mut clip_run_start: Option<usize> = None;
    for (i, &s) in samples.iter().enumerate() {
        let clipped = (s as i32).abs() >= CLIP_THRESHOLD;
        match (clipped, clip_run_start) {
            (true, None) => clip_run_start = Some(i),
            (false, Some(start)) => {
                let run_len = i - start;
                if run_len >= 3 {
                    findings.push(QcFinding {
                        kind: "clipping".into(),
                        start: start as f64 / SAMPLE_RATE as f64,
                        end: i as f64 / SAMPLE_RATE as f64,
                        severity: "error".into(),
                        message: "Клиппинг — сигнал упирается в потолок шкалы.".into(),
                    });
                }
                clip_run_start = None;
            }
            _ => {}
        }
    }
    if let Some(start) = clip_run_start {
        findings.push(QcFinding {
            kind: "clipping".into(),
            start: start as f64 / SAMPLE_RATE as f64,
            end: samples.len() as f64 / SAMPLE_RATE as f64,
            severity: "error".into(),
            message: "Клиппинг — сигнал упирается в потолок шкалы.".into(),
        });
    }

    // Долгие паузы — окна с RMS ниже порога подряд.
    let mut silence_start: Option<usize> = None;
    let mut i = 0usize;
    while i < samples.len() {
        let end = (i + window_len).min(samples.len());
        let window = &samples[i..end];
        let win_rms = rms_amplitude(window) / 32768.0;
        let is_silent = win_rms < SILENCE_RMS_THRESHOLD;
        match (is_silent, silence_start) {
            (true, None) => silence_start = Some(i),
            (false, Some(start)) => {
                let dur = (i - start) as f64 / SAMPLE_RATE as f64;
                if dur >= MIN_SILENCE_SECONDS {
                    findings.push(QcFinding {
                        kind: "silence".into(),
                        start: start as f64 / SAMPLE_RATE as f64,
                        end: i as f64 / SAMPLE_RATE as f64,
                        severity: "warn".into(),
                        message: format!("Пауза без звука {:.1} с.", dur),
                    });
                }
                silence_start = None;
            }
            _ => {}
        }
        i = end;
    }
    if let Some(start) = silence_start {
        let dur = (samples.len() - start) as f64 / SAMPLE_RATE as f64;
        if dur >= MIN_SILENCE_SECONDS {
            findings.push(QcFinding {
                kind: "silence".into(),
                start: start as f64 / SAMPLE_RATE as f64,
                end: samples.len() as f64 / SAMPLE_RATE as f64,
                severity: "warn".into(),
                message: format!("Пауза без звука {:.1} с.", dur),
            });
        }
    }

    if rms_dbfs < -38.0 {
        findings.insert(
            0,
            QcFinding {
                kind: "quiet".into(),
                start: 0.0,
                end: duration,
                severity: "warn".into(),
                message: format!("Общая громкость низкая ({:.1} дБФС) — возможно, дорожку стоит поднять.", rms_dbfs),
            },
        );
    } else if peak_dbfs > -0.3 {
        findings.insert(
            0,
            QcFinding {
                kind: "loud".into(),
                start: 0.0,
                end: duration,
                severity: "warn".into(),
                message: "Пик почти на потолке шкалы — риск клиппинга при перекодировании.".into(),
            },
        );
    }

    findings.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());

    Ok(QcReport {
        duration,
        findings,
        peak_dbfs,
        rms_dbfs,
    })
}

fn rms_amplitude(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum_sq / samples.len() as f64).sqrt()
}

fn amplitude_to_dbfs(a: f64) -> f64 {
    if a <= 0.0 {
        return -120.0;
    }
    20.0 * a.log10()
}

/// Декодирует любой аудио/видео-файл в PCM s16le моно 16кГц через ffmpeg,
/// читая результат из stdout — временных файлов не создаём.
fn decode_pcm(path: &str) -> Result<Vec<i16>, String> {
    let ffmpeg = resolve_ffmpeg();
    let output = ffmpeg_command(ffmpeg)
        .args([
            "-v", "error",
            "-i", path,
            "-f", "s16le",
            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", &SAMPLE_RATE.to_string(),
            "-",
        ])
        .output()
        .map_err(|e| format!(
            "ffmpeg не найден или не запустился ({ffmpeg}): {e}. В штатной сборке ffmpeg идёт вместе с приложением — \
             попробуйте переустановить; либо поставьте ffmpeg сами и добавьте его в PATH."
        ))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg не смог прочитать файл: {}", err.trim()));
    }

    let bytes = output.stdout;
    let mut samples = Vec::with_capacity(bytes.len() / 2);
    let (chunks, _remainder) = bytes.as_chunks::<2>();
    for c in chunks {
        samples.push(i16::from_le_bytes(*c));
    }
    Ok(samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn silence(seconds: f64) -> Vec<i16> {
        vec![0i16; (seconds * SAMPLE_RATE as f64) as usize]
    }

    fn tone(seconds: f64, amplitude: i16) -> Vec<i16> {
        // Не настоящий синус — чередование +amplitude/-amplitude тем же
        // темпом, что и реальный клиппинг на полке: для порогов клиппинга
        // и RMS этого достаточно, не тянуть же в тест-хелпер std::f64::sin
        // ради треугольного приближения синуса.
        (0..(seconds * SAMPLE_RATE as f64) as usize)
            .map(|i| if i % 2 == 0 { amplitude } else { -amplitude })
            .collect()
    }

    #[test]
    fn empty_input_is_an_error() {
        assert!(analyze_samples(&[]).is_err());
    }

    #[test]
    fn clean_quiet_free_audio_has_no_findings() {
        // Умеренная громкость, без клиппинга и без длинных пауз —
        // чистая дорожка не должна порождать ни одной находки.
        let samples = tone(3.0, 8000);
        let report = analyze_samples(&samples).unwrap();
        assert!(
            report.findings.is_empty(),
            "ожидали пустой список находок, получили: {:?}",
            report.findings.iter().map(|f| &f.kind).collect::<Vec<_>>()
        );
        assert!((report.duration - 3.0).abs() < 0.01);
    }

    #[test]
    fn sustained_clipping_is_detected() {
        // CLIP_THRESHOLD = 32_600 — сэмплы на самом пределе шкалы,
        // достаточно долгий отрезок (порог — 3+ сэмпла подряд).
        let mut samples = tone(0.5, 8000);
        for s in samples.iter_mut().skip(1000).take(50) {
            *s = 32767;
        }
        let report = analyze_samples(&samples).unwrap();
        assert!(
            report.findings.iter().any(|f| f.kind == "clipping"),
            "клиппинг на 50 сэмплах подряд должен быть найден"
        );
    }

    #[test]
    fn brief_clipping_under_threshold_is_ignored() {
        // Меньше 3 сэмплов подряд на пределе — случайный пик, не клиппинг.
        let mut samples = tone(0.5, 8000);
        samples[1000] = 32767;
        samples[1001] = 32767;
        let report = analyze_samples(&samples).unwrap();
        assert!(!report.findings.iter().any(|f| f.kind == "clipping"));
    }

    #[test]
    fn long_silence_is_detected() {
        // MIN_SILENCE_SECONDS = 1.2 — тишина короче порога отчёта не
        // получает, длиннее — должна попасть в findings как "silence".
        let mut samples = tone(0.5, 8000);
        samples.extend(silence(2.0));
        samples.extend(tone(0.5, 8000));
        let report = analyze_samples(&samples).unwrap();
        let sil = report.findings.iter().find(|f| f.kind == "silence");
        assert!(sil.is_some(), "пауза 2с должна быть найдена");
        let sil = sil.unwrap();
        assert!(sil.end - sil.start >= 1.2);
    }

    #[test]
    fn short_silence_is_not_reported() {
        // Короткая пауза (0.5с) — это естественная тишина между фразами,
        // не проблема озвучки, findings быть не должно.
        let mut samples = tone(0.5, 8000);
        samples.extend(silence(0.5));
        samples.extend(tone(0.5, 8000));
        let report = analyze_samples(&samples).unwrap();
        assert!(!report.findings.iter().any(|f| f.kind == "silence"));
    }

    #[test]
    fn overall_silence_is_flagged_quiet() {
        // Вся дорожка тихая (не путать с точечной паузой) — попадает под
        // summary-находку "quiet" по итоговому RMS, а не под "silence".
        let samples = silence(2.0);
        let report = analyze_samples(&samples).unwrap();
        assert!(report.findings.iter().any(|f| f.kind == "quiet"));
        assert!(report.rms_dbfs < -38.0);
    }

    #[test]
    fn near_full_scale_audio_is_flagged_loud() {
        // Громко, но не настолько долго на пределе, чтобы засчитаться
        // клиппингом — предупреждение "loud" по пиковому уровню.
        let samples = tone(1.0, 32000);
        let report = analyze_samples(&samples).unwrap();
        assert!(report.findings.iter().any(|f| f.kind == "loud" || f.kind == "clipping"));
    }

    #[test]
    fn findings_are_sorted_by_start_time() {
        let mut samples = silence(1.5); // long silence -> finding at start=0
        samples.extend(tone(0.5, 8000));
        samples.extend(silence(1.5)); // another long silence later
        let report = analyze_samples(&samples).unwrap();
        let starts: Vec<f64> = report.findings.iter().map(|f| f.start).collect();
        let mut sorted = starts.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(starts, sorted);
    }
}
