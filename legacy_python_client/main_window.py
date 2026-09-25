"""Главное окно — список отчётов студии (то же, что вкладка «Список»
в мини-аппе): фильтры, сортировка по клику на заголовок, массовые
операции по нескольким выделенным строкам сразу, QC звука. Закрытие
крестиком сворачивает в трей (см. tray.py) — приложение продолжает
опрашивать новые назначения/просрочки в фоне; по-настоящему выходит
только явный "Выйти" (или "Выход" из меню трея)."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from api import ApiClient, ApiError
from auth import clear_session
from qc_dialog import QcDialog

# Фолбэк, если /api/meta вдруг недоступен (не должно случаться для
# админа, но лучше подписи "as is", чем пустой список) — в норме их
# перекрывают реальные подписи с сервера (см. load_meta).
STATUS_LABELS = {
    "draft": "Черновик", "working": "В работе", "review": "На проверке",
    "revision": "На правках", "completed": "Готово", "cancelled": "Отменён",
}
PRIORITY_LABELS = {"normal": "Обычный", "high": "Высокий", "urgent": "Срочно"}

COLUMNS = ["Номер", "Название", "Статус", "Приоритет", "Срок"]
REPORT_ROLE = Qt.UserRole


class MainWindow(QMainWindow):
    def __init__(self, api: ApiClient, user_name: str):
        super().__init__()
        self.api = api
        self.setWindowTitle(f"Project Desktop — {user_name}")
        self.resize(980, 640)

        self.status_labels = dict(STATUS_LABELS)
        self.priority_labels = dict(PRIORITY_LABELS)
        self._assignable_users: list[dict] = []
        self._reports: list[dict] = []

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)

        # ---------- верхняя строка: кто вошёл, обновить, выйти ----------
        top_row = QHBoxLayout()
        who_label = QLabel(user_name)
        who_label.setStyleSheet("font-weight: 700;")
        top_row.addWidget(who_label)
        top_row.addStretch(1)

        refresh_btn = QPushButton("🔄 Обновить")
        refresh_btn.clicked.connect(self.load_reports)
        top_row.addWidget(refresh_btn)

        qc_btn = QPushButton("🎧 QC звука")
        qc_btn.clicked.connect(self._open_qc)
        top_row.addWidget(qc_btn)

        logout_btn = QPushButton("Выйти")
        logout_btn.clicked.connect(self._logout)
        top_row.addWidget(logout_btn)
        layout.addLayout(top_row)

        # ---------- фильтры ----------
        filter_row = QHBoxLayout()
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("🔎 Поиск по номеру, названию, исполнителю…")
        self.search_input.returnPressed.connect(self.load_reports)
        filter_row.addWidget(self.search_input, 2)

        self.status_filter = QComboBox()
        self.status_filter.addItem("Все статусы", "")
        self.status_filter.currentIndexChanged.connect(self.load_reports)
        filter_row.addWidget(self.status_filter, 1)

        self.priority_filter = QComboBox()
        self.priority_filter.addItem("Все приоритеты", "")
        self.priority_filter.currentIndexChanged.connect(self.load_reports)
        filter_row.addWidget(self.priority_filter, 1)

        apply_btn = QPushButton("Найти")
        apply_btn.clicked.connect(self.load_reports)
        filter_row.addWidget(apply_btn)
        layout.addLayout(filter_row)

        # ---------- таблица ----------
        self.table = QTableWidget(0, len(COLUMNS))
        self.table.setHorizontalHeaderLabels(COLUMNS)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Stretch)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.table.setSortingEnabled(True)
        self.table.cellDoubleClicked.connect(self._change_status_dialog)
        self.table.itemSelectionChanged.connect(self._update_bulk_bar)
        layout.addWidget(self.table)

        # ---------- панель массовых операций — появляется, когда выбрано
        # больше одной строки; одиночная правка по-прежнему двойным кликом. ----------
        self.bulk_bar = QWidget()
        bulk_layout = QHBoxLayout(self.bulk_bar)
        bulk_layout.setContentsMargins(0, 0, 0, 0)

        self.bulk_count_label = QLabel("")
        bulk_layout.addWidget(self.bulk_count_label)
        bulk_layout.addStretch(1)

        self.bulk_status_combo = QComboBox()
        bulk_layout.addWidget(self.bulk_status_combo)
        bulk_status_btn = QPushButton("Сменить статус у выбранных")
        bulk_status_btn.clicked.connect(self._bulk_set_status)
        bulk_layout.addWidget(bulk_status_btn)

        self.bulk_assignee_combo = QComboBox()
        bulk_layout.addWidget(self.bulk_assignee_combo)
        bulk_assign_btn = QPushButton("Назначить выбранным")
        bulk_assign_btn.clicked.connect(self._bulk_assign)
        bulk_layout.addWidget(bulk_assign_btn)

        layout.addWidget(self.bulk_bar)
        self.bulk_bar.hide()

        self.status_bar_label = QLabel("")
        self.statusBar().addWidget(self.status_bar_label)

        self.load_meta()
        self.load_reports()

    # ------------------------------------------------------------

    def load_meta(self):
        """Подписи статусов/приоритетов и список исполнителей — один
        раз при старте (справочники, не отчёты, меняются редко)."""

        try:
            meta = self.api.meta()
        except ApiError:
            meta = {}

        for s in meta.get("statuses", []):
            self.status_labels[s["value"]] = s["label"]
            self.status_filter.addItem(s["label"], s["value"])
            self.bulk_status_combo.addItem(s["label"], s["value"])

        for p in meta.get("priorities", []):
            self.priority_labels[p["value"]] = p["label"]
            self.priority_filter.addItem(p["label"], p["value"])

        if not meta:
            # /api/meta не ответил — хотя бы захардкоженные подписи в
            # выпадающих списках, чтобы массовые операции работали.
            for value, label in self.status_labels.items():
                self.bulk_status_combo.addItem(label, value)

        try:
            self._assignable_users = self.api.assignable_users()
        except ApiError:
            self._assignable_users = []

        for u in self._assignable_users:
            name = f"@{u['username']}" if u.get("username") else u["name"]
            self.bulk_assignee_combo.addItem(name, u["telegram_id"])

    def load_reports(self):
        params = {"page_size": 200}
        if self.search_input.text().strip():
            params["q"] = self.search_input.text().strip()
        if self.status_filter.currentData():
            params["status"] = self.status_filter.currentData()
        if self.priority_filter.currentData():
            params["priority"] = self.priority_filter.currentData()

        try:
            data = self.api.list_reports(**params)
        except ApiError as e:
            QMessageBox.warning(self, "Не удалось загрузить", str(e))
            return

        self._reports = data.get("reports", [])

        self.table.setSortingEnabled(False)
        self.table.setRowCount(len(self._reports))

        for row, r in enumerate(self._reports):
            id_item = QTableWidgetItem(r.get("public_id", ""))
            id_item.setData(REPORT_ROLE, r)
            self.table.setItem(row, 0, id_item)
            self.table.setItem(row, 1, QTableWidgetItem(r.get("title", "")))
            self.table.setItem(row, 2, QTableWidgetItem(self.status_labels.get(r.get("status"), r.get("status", ""))))
            self.table.setItem(row, 3, QTableWidgetItem(self.priority_labels.get(r.get("priority"), r.get("priority", ""))))
            self.table.setItem(row, 4, QTableWidgetItem(r.get("deadline") or "без срока"))

        self.table.setSortingEnabled(True)

        total = data.get("total", len(self._reports))
        self.status_bar_label.setText(
            f"Отчётов: {len(self._reports)} из {total} · двойной клик — сменить статус одному, "
            "выделите несколько строк — массовые операции"
        )
        self._update_bulk_bar()

    # ------------------------------------------------------------
    # Данные строки — из Qt.UserRole первой колонки, не из индекса в
    # self._reports: сортировка/фильтр меняют порядок строк в таблице,
    # но не трогают сами QTableWidgetItem с уже прикреплёнными данными.
    # ------------------------------------------------------------

    def _report_at_row(self, row: int) -> dict:
        return self.table.item(row, 0).data(REPORT_ROLE)

    def _selected_reports(self) -> list[dict]:
        rows = {idx.row() for idx in self.table.selectedIndexes()}
        return [self._report_at_row(row) for row in rows]

    def _update_bulk_bar(self):
        count = len({idx.row() for idx in self.table.selectedIndexes()})
        if count > 1:
            self.bulk_count_label.setText(f"Выбрано: {count}")
            self.bulk_bar.show()
        else:
            self.bulk_bar.hide()

    # ------------------------------------------------------------

    def _change_status_dialog(self, row: int, _column: int):
        report = self._report_at_row(row)
        public_id = report["public_id"]

        dialog = QDialog(self)
        dialog.setWindowTitle(f"Статус {public_id}")
        v = QVBoxLayout(dialog)
        v.addWidget(QLabel(report.get("title", "")))

        combo = QComboBox()
        for value, label in self.status_labels.items():
            combo.addItem(label, value)
        current_index = combo.findData(report.get("status"))
        if current_index >= 0:
            combo.setCurrentIndex(current_index)
        v.addWidget(combo)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        v.addWidget(buttons)

        if dialog.exec() != QDialog.Accepted:
            return

        new_status = combo.currentData()
        try:
            self.api.set_status(public_id, new_status)
        except ApiError as e:
            QMessageBox.warning(self, "Не удалось сохранить", str(e))
            return

        self.load_reports()

    def _bulk_set_status(self):
        reports = self._selected_reports()
        if len(reports) < 2:
            return

        status_value = self.bulk_status_combo.currentData()
        status_label = self.bulk_status_combo.currentText()
        public_ids = [r["public_id"] for r in reports]

        if QMessageBox.question(
            self, "Массовая смена статуса",
            f"Сменить статус на «{status_label}» у {len(public_ids)} отчётов?",
        ) != QMessageBox.Yes:
            return

        try:
            result = self.api.bulk_status(public_ids, status_value)
        except ApiError as e:
            QMessageBox.warning(self, "Не удалось выполнить", str(e))
            return

        QMessageBox.information(
            self, "Готово",
            f"Изменено {result.get('changed', 0)} из {result.get('total', len(public_ids))}.",
        )
        self.load_reports()

    def _bulk_assign(self):
        reports = self._selected_reports()
        if len(reports) < 2:
            return

        telegram_id = self.bulk_assignee_combo.currentData()
        name = self.bulk_assignee_combo.currentText()
        public_ids = [r["public_id"] for r in reports]

        if QMessageBox.question(
            self, "Массовое назначение",
            f"Назначить {name} исполнителем на {len(public_ids)} отчётов?",
        ) != QMessageBox.Yes:
            return

        try:
            result = self.api.bulk_assign(public_ids, telegram_id)
        except ApiError as e:
            QMessageBox.warning(self, "Не удалось выполнить", str(e))
            return

        QMessageBox.information(
            self, "Готово",
            f"Назначено {result.get('changed', 0)} из {result.get('total', len(public_ids))}.",
        )
        self.load_reports()

    def _open_qc(self):
        dialog = QcDialog(self)
        dialog.exec()

    def closeEvent(self, event):
        # Крестик сворачивает в трей, а не завершает процесс — иначе
        # фоновый опрос новых назначений/просрочек (см. tray.py) тоже
        # остановился бы, а весь смысл трея в том, чтобы работать, пока
        # окно не открыто. По-настоящему выйти — только "Выйти" тут или
        # "Выход" в меню значка в трее.
        event.ignore()
        self.hide()

    def _logout(self):
        clear_session()
        QApplication.instance().quit()
