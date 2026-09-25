"""Диалог входа — код из /desktop в боте обменивается на токен через
POST /api/desktop/pair (см. api.py). Больше в приложении никакого
логина нет: код одноразовый и живёт 5 минут, ошибку неверного/
просроченного кода просто показываем и даём попробовать снова."""

import socket

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
)

from api import ApiClient, ApiError
from auth import save_session


class LoginDialog(QDialog):
    def __init__(self, api: ApiClient, parent=None):
        super().__init__(parent)
        self.api = api
        self.session: dict | None = None

        self.setWindowTitle("Вход — Project Desktop")
        self.setFixedWidth(360)

        layout = QVBoxLayout(self)

        title = QLabel("Вход в студию")
        title.setStyleSheet("font-size: 18px; font-weight: 700;")
        layout.addWidget(title)

        hint = QLabel(
            "Напишите боту в Telegram команду /desktop — он пришлёт "
            "одноразовый 6-значный код. Введите его сюда."
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #999;")
        layout.addWidget(hint)

        self.code_input = QLineEdit()
        self.code_input.setPlaceholderText("123456")
        self.code_input.setMaxLength(6)
        self.code_input.setAlignment(Qt.AlignCenter)
        self.code_input.setStyleSheet("font-size: 22px; letter-spacing: 4px; padding: 8px;")
        self.code_input.returnPressed.connect(self._submit)
        layout.addWidget(self.code_input)

        self.submit_btn = QPushButton("Войти")
        self.submit_btn.clicked.connect(self._submit)
        layout.addWidget(self.submit_btn)

        self.error_label = QLabel("")
        self.error_label.setStyleSheet("color: #d9534f;")
        self.error_label.setWordWrap(True)
        layout.addWidget(self.error_label)

        self.code_input.setFocus()

    def _submit(self):
        code = self.code_input.text().strip()
        if len(code) != 6 or not code.isdigit():
            self.error_label.setText("Код — это ровно 6 цифр из сообщения бота.")
            return

        self.submit_btn.setEnabled(False)
        self.error_label.setText("")

        try:
            result = self.api.pair(code, label=socket.gethostname())
        except ApiError as e:
            self.error_label.setText(str(e))
            self.submit_btn.setEnabled(True)
            return

        save_session(result["token"], result["telegram_id"], result["name"])
        self.api.set_token(result["token"])
        self.session = result
        self.accept()
