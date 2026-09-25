"""Хранение токена десктоп-клиента — через keyring (родное хранилище
учётных данных ОС: Credential Manager на Windows, Keychain на macOS,
Secret Service/KWallet на Linux — keyring сам выбирает нужный бэкенд),
с фолбэком на локальный файл, если на конкретной машине ни один бэкенд
не доступен (бывает на "голых" Linux-серверах без графической сессии
и секретного хранилища). Сам токен и его получение (обмен кода на
токен) — см. api.py."""

import json
import logging
import os

from config import APP_NAME, ORG_NAME

logger = logging.getLogger("project_desktop")

_KEYRING_SERVICE = f"{ORG_NAME}.{APP_NAME}"
_KEYRING_USERNAME = "session"

try:
    import keyring
    _KEYRING_AVAILABLE = True
except Exception as e:  # pragma: no cover — окружение без keyring backend
    logger.warning("keyring недоступен (%s), используем локальный файл", e)
    _KEYRING_AVAILABLE = False

# Фолбэк — рядом с остальными настройками приложения в профиле
# пользователя: %APPDATA%\PhoenixDub на Windows, ~/.config/PhoenixDub
# на Linux/macOS (APPDATA там просто не задан, os.environ.get вернёт
# None и сработает вторая часть or).
_FALLBACK_DIR = os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~/.config"),
    ORG_NAME,
)
_FALLBACK_PATH = os.path.join(_FALLBACK_DIR, "session.json")


def save_session(token: str, telegram_id: int, name: str) -> None:
    payload = json.dumps({"token": token, "telegram_id": telegram_id, "name": name})

    if _KEYRING_AVAILABLE:
        try:
            keyring.set_password(_KEYRING_SERVICE, _KEYRING_USERNAME, payload)
            return
        except Exception as e:
            logger.warning("keyring.set_password не сработал (%s), пишем в файл", e)

    os.makedirs(_FALLBACK_DIR, exist_ok=True)
    with open(_FALLBACK_PATH, "w", encoding="utf-8") as f:
        f.write(payload)


def load_session() -> dict | None:
    """{"token", "telegram_id", "name"} или None, если ещё не входили
    (или сессию явно стёрли через clear_session)."""

    raw = None

    if _KEYRING_AVAILABLE:
        try:
            raw = keyring.get_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
        except Exception as e:
            logger.warning("keyring.get_password не сработал (%s), пробуем файл", e)

    if raw is None and os.path.exists(_FALLBACK_PATH):
        try:
            with open(_FALLBACK_PATH, encoding="utf-8") as f:
                raw = f.read()
        except OSError:
            raw = None

    if not raw:
        return None

    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def clear_session() -> None:
    if _KEYRING_AVAILABLE:
        try:
            keyring.delete_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
        except Exception:
            pass  # не было записи — и не надо

    if os.path.exists(_FALLBACK_PATH):
        try:
            os.remove(_FALLBACK_PATH)
        except OSError:
            pass
