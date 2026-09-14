"""Конфигурация десктоп-клиента — один адрес сервера на всё
приложение, тот же хост, что и у мини-аппа в Telegram (см. MINIAPP_URL
в корневом config.py бота)."""

API_BASE = "https://minitg.shitstudent.com:8443/api"

APP_NAME = "PHOENIX DUB Desktop"
ORG_NAME = "PhoenixDub"  # для QSettings/keyring — просто namespace, не показывается пользователю

# Таймаут одного HTTP-запроса — сервер за секунды отвечает на всё, что
# нужно этому клиенту; если завис на дольше — сеть сама важнее ошибки,
# чем зависшее окно.
REQUEST_TIMEOUT = 15
