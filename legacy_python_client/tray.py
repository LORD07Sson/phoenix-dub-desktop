"""Трей и уведомления — фоновый поллинг того же /api/reports с
assignee=me (сервер сам разворачивает "me" в telegram_id вызывающего,
см. api.py в мини-аппе), с двух сторон:
  - новые назначения — сравниваем набор id с прошлым опросом, а не
    вчитываемся в даты создания: проще и не зависит от часовых поясов;
  - просроченные — отдельным запросом с overdue=1 (сервер уже умеет
    эту логику, реализовывать её заново на клиенте незачем), тоже
    только НОВЫЕ с прошлого опроса, иначе одна и та же просрочка
    дёргала бы уведомление на каждом опросе бесконечно.

Первый опрос после запуска не уведомляет ни о чём — иначе при каждом
старте приложения человек получал бы уведомления обо всём, что на нём
уже висело до этого, как будто это только что произошло."""

from PySide6.QtCore import QTimer
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

from api import ApiError

POLL_INTERVAL_MS = 60_000


class TrayManager:
    def __init__(self, app: QApplication, api, main_window, icon: QIcon):
        self.app = app
        self.api = api
        self.main_window = main_window

        self.tray_icon = QSystemTrayIcon(icon, app)
        self.tray_icon.setToolTip("PHOENIX DUB Desktop")

        menu = QMenu()
        menu.addAction("Открыть", self.show_window)
        menu.addAction("Обновить сейчас", self.poll_now)
        menu.addSeparator()
        menu.addAction("Выход", self.quit_app)
        self.tray_icon.setContextMenu(menu)
        self.tray_icon.activated.connect(self._on_activated)
        self.tray_icon.show()

        self._known_assigned_ids: set | None = None
        self._known_overdue_ids: set | None = None

        self.timer = QTimer()
        self.timer.timeout.connect(self.poll_now)
        self.timer.start(POLL_INTERVAL_MS)

        self.poll_now()

    # ------------------------------------------------------------

    def _on_activated(self, reason):
        # Двойной клик (и на части систем — обычный) по значку в трее —
        # самый ожидаемый способ вернуть окно, тот же, что у большинства
        # трей-приложений.
        if reason in (QSystemTrayIcon.DoubleClick, QSystemTrayIcon.Trigger):
            self.show_window()

    def show_window(self):
        self.main_window.showNormal()
        self.main_window.raise_()
        self.main_window.activateWindow()

    def quit_app(self):
        self.tray_icon.hide()
        self.app.quit()

    # ------------------------------------------------------------

    def poll_now(self):
        try:
            mine = self.api.list_reports(assignee="me", page_size=200).get("reports", [])
        except ApiError:
            return  # сеть моргнула — тихо ждём следующего опроса, не спамим ошибкой

        current_ids = {r["public_id"] for r in mine}
        if self._known_assigned_ids is not None:
            new_ids = current_ids - self._known_assigned_ids
            if new_ids:
                self._notify_new([r for r in mine if r["public_id"] in new_ids])
        self._known_assigned_ids = current_ids

        try:
            overdue = self.api.list_reports(assignee="me", overdue=1, page_size=200).get("reports", [])
        except ApiError:
            overdue = []

        overdue_ids = {r["public_id"] for r in overdue}
        if self._known_overdue_ids is not None:
            new_overdue_ids = overdue_ids - self._known_overdue_ids
            if new_overdue_ids:
                self._notify_overdue([r for r in overdue if r["public_id"] in new_overdue_ids])
        self._known_overdue_ids = overdue_ids

        if self.main_window.isVisible():
            self.main_window.load_reports()

    def _notify_new(self, reports: list[dict]):
        if len(reports) == 1:
            body = reports[0].get("title", reports[0]["public_id"])
        else:
            body = "\n".join(f"• {r.get('title', r['public_id'])}" for r in reports[:5])
        self.tray_icon.showMessage(
            f"Вам назначили {len(reports)} " + _plural_reports(len(reports)),
            body, QSystemTrayIcon.Information, 8000,
        )

    def _notify_overdue(self, reports: list[dict]):
        if len(reports) == 1:
            body = reports[0].get("title", reports[0]["public_id"])
        else:
            body = "\n".join(f"• {r.get('title', r['public_id'])}" for r in reports[:5])
        self.tray_icon.showMessage(
            f"⏰ Просрочено — {len(reports)} " + _plural_reports(len(reports)),
            body, QSystemTrayIcon.Warning, 8000,
        )


def _plural_reports(n: int) -> str:
    n10, n100 = n % 10, n % 100
    if n10 == 1 and n100 != 11:
        return "отчёт"
    if 2 <= n10 <= 4 and not (10 <= n100 <= 20):
        return "отчёта"
    return "отчётов"
