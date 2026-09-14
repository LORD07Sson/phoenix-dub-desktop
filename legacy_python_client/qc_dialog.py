"""Окно локального QC звука — выбираешь файл, анализ идёт в фоновом
потоке (декодирование даже минутной записи занимает заметное время,
незачем подвешивать на это весь интерфейс), результат — список находок
по времени. Работает полностью на самой машине, см. audio_qc.py."""

import os

from PySide6.QtCore import QThread, Signal
from PySide6.QtWidgets import (
    QDialog,
    QFileDialog,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
)

import audio_qc

KIND_ICON = {
    "clip": "🔴", "noise": "🟠", "silence_long": "🟡", "no_speech": "⚪",
}
KIND_LABEL = {
    "clip": "Клиппинг", "noise": "Резкий шум", "silence_long": "Долгая пауза", "no_speech": "Нет речи",
}


def format_time(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m}:{s:02d}"


def format_range(start: float, end: float) -> str:
    """Клиппинг/шум часто укладываются в доли секунды — с округлением
    до целой секунды start и end у такой находки выглядели бы
    одинаково ("0:16–0:16"), как будто диапазон нулевой длины/баг. Для
    находок короче секунды показываем длительность отдельно."""

    if end - start < 1:
        return f"{format_time(start)} (~{round((end - start) * 1000)} мс)"
    return f"{format_time(start)}–{format_time(end)}"


class QcWorker(QThread):
    finished_ok = Signal(dict)
    failed = Signal(str)

    def __init__(self, file_path: str):
        super().__init__()
        self.file_path = file_path

    def run(self):
        try:
            result = audio_qc.analyze_audio_file(self.file_path)
        except audio_qc.ToolsMissingError as e:
            self.failed.emit(str(e))
            return
        except Exception as e:
            self.failed.emit(f"Неожиданная ошибка: {e}")
            return
        self.finished_ok.emit(result)


class QcDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("QC звука")
        self.resize(520, 480)
        self.worker: QcWorker | None = None

        layout = QVBoxLayout(self)

        self.pick_btn = QPushButton("📂 Выбрать файл…")
        self.pick_btn.clicked.connect(self._pick_file)
        layout.addWidget(self.pick_btn)

        self.file_label = QLabel("Файл не выбран")
        self.file_label.setStyleSheet("color: #999;")
        self.file_label.setWordWrap(True)
        layout.addWidget(self.file_label)

        self.progress = QProgressBar()
        self.progress.setRange(0, 0)  # неопределённый — точного прогресса ffmpeg не отдаёт
        self.progress.hide()
        layout.addWidget(self.progress)

        self.summary_label = QLabel("")
        layout.addWidget(self.summary_label)

        self.results_list = QListWidget()
        layout.addWidget(self.results_list)

    def _pick_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Выберите аудио/видео файл", "",
            "Аудио и видео (*.mp3 *.wav *.flac *.ogg *.m4a *.mp4 *.mkv *.mov *.webm);;Все файлы (*)",
        )
        if not path:
            return

        self.file_label.setText(os.path.basename(path))
        self.results_list.clear()
        self.summary_label.setText("")
        self.pick_btn.setEnabled(False)
        self.progress.show()

        self.worker = QcWorker(path)
        self.worker.finished_ok.connect(self._on_result)
        self.worker.failed.connect(self._on_error)
        self.worker.start()

    def _on_result(self, result: dict):
        self.progress.hide()
        self.pick_btn.setEnabled(True)

        duration = result.get("duration")
        issues = result.get("issues", [])
        error = result.get("error")

        parts = []
        if duration is not None:
            parts.append(f"Длительность: {format_time(duration)}")
        parts.append(f"Находок: {len(issues)}" + (" (показаны первые 15)" if result.get("truncated") else ""))
        if error:
            parts.append(f"⚠️ {error}")
        self.summary_label.setText(" · ".join(parts))

        if not issues:
            item = QListWidgetItem("✅ Ничего подозрительного не найдено")
            self.results_list.addItem(item)
            return

        for issue in issues:
            icon = KIND_ICON.get(issue["kind"], "•")
            label = KIND_LABEL.get(issue["kind"], issue["kind"])
            text = f"{icon} {format_range(issue['start'], issue['end'])} · {label}\n{issue['detail']}"
            self.results_list.addItem(QListWidgetItem(text))

    def _on_error(self, message: str):
        self.progress.hide()
        self.pick_btn.setEnabled(True)
        self.summary_label.setText(f"⚠️ {message}")
