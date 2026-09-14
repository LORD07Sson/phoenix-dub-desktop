"""Локальная проверка качества звука — целиком на самом ПК, без
похода на сервер бота: ffmpeg/ffprobe уже должны стоять на машине
(см. README про установку), дальше только numpy.

Логика и пороги — то же самое, что у audio_qc.py на сервере бота
(проверено, устоявшиеся значения), но:
  - без Silero VAD (там отдельная модель + onnxruntime, лишний вес для
    десктоп-сборки) — паузы ищем как в собственном запасном пути
    сервера: порогом громкости через ffmpeg silencedetect. Менее
    точно, чем VAD (тихую, но внятную реплику может принять за паузу),
    но без лишней зависимости.
  - синхронно (subprocess.run), а не через asyncio — вызывается из
    фонового QThread в qc_dialog.py, отдельный event loop тут не нужен.

Что умеет: клиппинг, резкие всплески громкости на фоне остальной
записи, долгие паузы (не у самого начала/конца файла).
Чего не умеет — то же самое, что и на сервере: не понимает СОДЕРЖАНИЕ
речи, не сверяет с оригиналом/сценарием, только "здесь тихо"/"здесь
громкий скачок"/"здесь перегруз" — подсказки, куда смотреть (слушать),
не готовый вердикт."""

import re
import shutil
import subprocess

import numpy as np

SAMPLE_RATE = 16000
QC_WINDOW_MS = 100
QC_WINDOW_SAMPLES = SAMPLE_RATE * QC_WINDOW_MS // 1000

QC_CLIP_PEAK = 32000
QC_CLIP_FRACTION = 0.01
QC_NOISE_SPIKE_RATIO = 3.0
QC_SPEECH_FLOOR_RATIO = 0.08

QC_SILENCE_DB = "-35dB"
QC_MIN_SILENCE_GAP_SEC = 0.7
QC_EDGE_MARGIN_SEC = 0.3
QC_LONG_SILENCE_SEC = 8.0

QC_MAX_ISSUES = 15
QC_PROBE_TIMEOUT = 20
QC_DECODE_TIMEOUT = 90  # локальный диск обычно быстрее, но запас не помешает


class ToolsMissingError(Exception):
    """ffmpeg/ffprobe не найдены на PATH — отдельный тип ошибки, чтобы
    диалог мог показать конкретную подсказку "установите ffmpeg", а не
    общее "файл повреждён"."""


def tools_available() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def analyze_audio_file(file_path: str) -> dict:
    """{"duration": float|None, "issues": [...], "error": str|None} —
    тот же формат, что и у серверной analyze_audio_file, так что при
    желании результаты можно показывать общим кодом."""

    if not tools_available():
        raise ToolsMissingError(
            "ffmpeg/ffprobe не найдены — установите ffmpeg и добавьте его в PATH."
        )

    duration = _probe_duration(file_path)
    if duration is None:
        return {"duration": None, "issues": [], "error": "Не удалось прочитать файл — возможно, повреждён или не аудио/видео."}

    issues = []
    errors = []

    try:
        samples = _decode_pcm(file_path)
    except Exception as e:
        return {"duration": duration, "issues": [], "error": f"не удалось декодировать аудио: {e}"}

    if len(samples):
        try:
            issues += _find_silence_gaps(file_path, duration)
        except Exception as e:
            errors.append(f"паузы не проверены: {e}")

        try:
            issues += _find_level_issues(samples)
        except Exception as e:
            errors.append(f"громкость не проверена: {e}")

    issues.sort(key=lambda i: i["start"])

    return {
        "duration": duration,
        "issues": issues[:QC_MAX_ISSUES],
        "truncated": len(issues) > QC_MAX_ISSUES,
        "error": "; ".join(errors) or None,
    }


def _probe_duration(file_path):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", file_path],
            capture_output=True, timeout=QC_PROBE_TIMEOUT,
        )
        return float(result.stdout.decode().strip())
    except Exception:
        return None


def _decode_pcm(file_path) -> np.ndarray:
    result = subprocess.run(
        ["ffmpeg", "-i", file_path, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
        capture_output=True, timeout=QC_DECODE_TIMEOUT,
    )
    stdout = result.stdout
    usable_len = len(stdout) - (len(stdout) % 2)
    return np.frombuffer(stdout[:usable_len], dtype=np.int16)


_SILENCE_RE = re.compile(r"silence_(start|end): ([\d.]+)")


def _classify_gap(start, end):
    gap = end - start
    if gap < QC_LONG_SILENCE_SEC:
        return None
    return {
        "start": round(start, 2), "end": round(end, 2), "kind": "silence_long",
        "detail": f"Долгая тишина ~{round(gap, 1)} сек — возможно, просто проигрыш/пауза, но стоит перепроверить.",
    }


def _find_silence_gaps(file_path, duration):
    result = subprocess.run(
        ["ffmpeg", "-i", file_path, "-af", f"silencedetect=noise={QC_SILENCE_DB}:d={QC_MIN_SILENCE_GAP_SEC}",
         "-f", "null", "-"],
        capture_output=True, timeout=QC_DECODE_TIMEOUT,
    )
    text = result.stderr.decode(errors="ignore")

    issues = []
    pending_start = None

    for kind, value in _SILENCE_RE.findall(text):
        t = float(value)
        if kind == "start":
            pending_start = t
            continue
        if pending_start is None:
            continue
        start, pending_start = pending_start, None
        if start <= QC_EDGE_MARGIN_SEC or t >= duration - QC_EDGE_MARGIN_SEC:
            continue
        issue = _classify_gap(start, t)
        if issue:
            issues.append(issue)

    return issues


def _find_level_issues(samples):
    if len(samples) < QC_WINDOW_SAMPLES:
        return []

    windows = []
    for i in range(0, len(samples) - QC_WINDOW_SAMPLES + 1, QC_WINDOW_SAMPLES):
        chunk = samples[i:i + QC_WINDOW_SAMPLES].astype(np.int64)
        clipped = int((np.abs(chunk) >= QC_CLIP_PEAK).sum())
        rms = float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
        windows.append({
            "start": i / SAMPLE_RATE, "end": (i + QC_WINDOW_SAMPLES) / SAMPLE_RATE,
            "clip_fraction": clipped / len(chunk), "rms": rms,
        })

    clean_windows = [w for w in windows if w["clip_fraction"] < QC_CLIP_FRACTION]
    max_rms = max((w["rms"] for w in clean_windows), default=0.0) or 1.0
    active_rms = [w["rms"] for w in clean_windows if w["rms"] >= max_rms * QC_SPEECH_FLOOR_RATIO]
    median_active_rms = _median(active_rms) if active_rms else 0.0

    issues = []
    pending = None

    def flush():
        if pending is not None:
            issues.append({
                "start": round(pending["start"], 2), "end": round(pending["end"], 2),
                "kind": pending["kind"], "detail": pending["detail"],
            })

    for w in windows:
        kind = detail = None

        if w["clip_fraction"] >= QC_CLIP_FRACTION:
            kind = "clip"
            detail = "Клиппинг — сигнал упирается в потолок громкости (перегрузка микрофона)."
        elif median_active_rms and w["rms"] >= median_active_rms * QC_NOISE_SPIKE_RATIO:
            kind = "noise"
            detail = "Резкий всплеск громкости на фоне остальной записи — похоже на посторонний шум/щелчок."

        if kind and pending and pending["kind"] == kind and w["start"] - pending["end"] <= QC_WINDOW_MS / 1000:
            pending["end"] = w["end"]
            continue

        if kind:
            flush()
            pending = {"kind": kind, "start": w["start"], "end": w["end"], "detail": detail}
        else:
            flush()
            pending = None

    flush()
    return issues


def _median(values):
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2
