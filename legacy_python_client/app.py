"""Точка входа — вход по сохранённой сессии (если есть и токен ещё
не отозван), иначе диалог входа по коду из /desktop."""

import sys

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import QApplication, QDialog

from api import ApiClient, ApiError
from auth import clear_session, load_session
from login_dialog import LoginDialog
from main_window import MainWindow
from tray import TrayManager


def _build_icon() -> QIcon:
    """Значок трея рисуем на лету — простой огненный кружок с "P", без
    отдельного .ico/.png в репозитории: одна деталь оформления не
    стоит того, чтобы тащить файл-ассет ради одной буквы."""

    size = 64
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.transparent)

    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.Antialiasing)
    painter.setBrush(QColor("#ff7a45"))
    painter.setPen(Qt.NoPen)
    painter.drawEllipse(2, 2, size - 4, size - 4)

    painter.setPen(QColor("#1a0f0a"))
    font = QFont("Arial", int(size * 0.5), QFont.Bold)
    painter.setFont(font)
    painter.drawText(pixmap.rect(), Qt.AlignCenter, "P")
    painter.end()

    return QIcon(pixmap)


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    # Крестик у главного окна теперь сворачивает в трей (см.
    # MainWindow.closeEvent), а не закрывает его по-настоящему — без
    # этого флага Qt по умолчанию завершил бы процесс, как только не
    # осталось ни одного ВИДИМОГО окна, что сломало бы саму идею трея.
    app.setQuitOnLastWindowClosed(False)

    api = ApiClient()
    session = load_session()

    if session:
        api.set_token(session.get("token"))
        try:
            api.whoami()
        except ApiError:
            clear_session()
            session = None

    if not session:
        login = LoginDialog(api)
        if login.exec() != QDialog.Accepted:
            sys.exit(0)
        session = login.session

    window = MainWindow(api, session["name"])
    window.show()

    tray = TrayManager(app, api, window, _build_icon())  # noqa: F841 — держим ссылку живой

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
