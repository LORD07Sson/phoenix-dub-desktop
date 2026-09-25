"""HTTP-клиент к тому же API, что и мини-апп в Telegram — единственная
разница в заголовке авторизации: вместо настоящей Telegram initData
шлём токен десктоп-клиента (см. _validate_desktop_token в
miniapp/server.py, он принимает оба формата в один и тот же заголовок
X-Init-Data)."""

import logging

import requests

from config import API_BASE, REQUEST_TIMEOUT

logger = logging.getLogger("project_desktop")


class ApiError(Exception):
    """detail с сервера (или текст сетевой ошибки) — то, что можно
    прямо показать пользователю в диалоге, не разворачивая traceback."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class ApiClient:
    def __init__(self, token: str | None = None):
        self.token = token

    def set_token(self, token: str | None) -> None:
        self.token = token

    def _headers(self) -> dict:
        headers = {}
        if self.token:
            headers["X-Init-Data"] = self.token
        return headers

    def _request(self, method: str, path: str, **kwargs) -> dict:
        url = f"{API_BASE}{path}"
        try:
            resp = requests.request(
                method, url, headers=self._headers(), timeout=REQUEST_TIMEOUT, **kwargs
            )
        except requests.RequestException as e:
            raise ApiError(f"Нет связи с сервером: {e}") from e

        if resp.status_code >= 400:
            detail = resp.status_code
            try:
                detail = resp.json().get("detail", detail)
            except ValueError:
                pass
            raise ApiError(str(detail), status_code=resp.status_code)

        if not resp.content:
            return {}
        return resp.json()

    def get(self, path: str, **kwargs) -> dict:
        return self._request("GET", path, **kwargs)

    def post(self, path: str, json_body: dict | None = None) -> dict:
        return self._request("POST", path, json=json_body or {})

    # ------------------------------------------------------------
    # Вход — единственный эндпоинт без токена (см. api_desktop_pair
    # в miniapp/server.py: до обмена кода на токен подтверждать нечем).
    # ------------------------------------------------------------
    def pair(self, code: str, label: str) -> dict:
        resp = requests.post(
            f"{API_BASE}/desktop/pair",
            json={"code": code, "label": label},
            timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code >= 400:
            detail = resp.status_code
            try:
                detail = resp.json().get("detail", detail)
            except ValueError:
                pass
            raise ApiError(str(detail), status_code=resp.status_code)
        return resp.json()

    # ------------------------------------------------------------
    # Дальше — тонкие обёртки над уже существующими ручками сервера,
    # ровно тем же путям, что использует сам мини-апп.
    # ------------------------------------------------------------
    def whoami(self) -> dict:
        return self.get("/whoami")

    def list_reports(self, **params) -> dict:
        return self.get("/reports", params=params)

    def assignable_users(self) -> list[dict]:
        return self.get("/assignable-users").get("users", [])

    def meta(self) -> dict:
        return self.get("/meta")

    def report_detail(self, public_id: str) -> dict:
        return self.get(f"/report/{public_id}")

    def set_status(self, public_id: str, status: str, comment: str = "") -> dict:
        return self.post(f"/report/{public_id}/status", {"status": status, "comment": comment})

    def assign(self, public_id: str, telegram_id: int) -> dict:
        return self.post(f"/report/{public_id}/assign", {"telegram_id": telegram_id})

    def bulk_status(self, public_ids: list[str], status: str) -> dict:
        return self.post("/reports/bulk/status", {"public_ids": public_ids, "status": status})

    def bulk_assign(self, public_ids: list[str], telegram_id: int) -> dict:
        return self.post("/reports/bulk/assign", {"public_ids": public_ids, "telegram_id": telegram_id})
