# API-контракт

Десктоп-клиент не хранит своей копии бизнес-логики — вся она в
`miniapp/server.py` (отдельный репозиторий бота PHOENIX DUB). Этот файл —
полный список эндпоинтов, которые реально дёргает `src/app/*.js` (сверено
по коду, не по памяти; фронтенд раздроблен на модули по темам — список,
доска, тайтлы и т.п., каждый в своём файле) — держите в актуальном виде
при добавлении новых вызовов.

## Базовый URL и авторизация

- `API_BASE` в `src/app/api.js` — `https://minitg.shitstudent.com:8443/api`
- Все запросы (кроме `/desktop/pair`) несут заголовок
  `X-Init-Data: dsk_<токен>` — desktop-токен, полученный при входе по коду
  (см. [README](../README.md#вход)). Сервер отличает его от
  Telegram initData по префиксу `dsk_` (`_validate_desktop_token` в
  `miniapp/server.py`)
- Токен хранится в нативном хранилище учётных данных ОС
  (`src-tauri/src/token_store.rs`), не в localStorage/файле

## Вход

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/desktop/pair` | `{code, label}` | `{token, telegram_id, name}` — код из `/desktop` в боте, одноразовый, 5 минут |
| GET | `/whoami` | — | `{telegram_id, is_admin}` — используется при восстановлении сессии, чтобы проверить, что токен ещё не отозван. Имени тут нет: для шапки клиент отдельно дёргает `/me` (см. `hydrateIdentity` в `src/app/auth.js`) |

Любой ответ `401`/`403` на запрос с токеном клиент трактует как
«сессию отозвали»: чистит токен из хранилища ОС и возвращает на экран
входа (`session-expired` в `src/app/api.js`). Исключение — сам
`/desktop/pair`, где `401` значит просто «неверный код».

## Обзор и профиль

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/overview` | Сводка по студии: счётчики отчётов по статусам, просрочка, топ-5 исполнителей, доступ, тикеты, дни рождения — вкладка «Обзор» |
| GET | `/trend` | Динамика за 14 дней (создано/завершено по дням) — график на «Обзоре» |
| GET | `/overview/monthly-top` | Топ-5 за последние 30 дней по закрытым отчётам — «Рейтинг месяца» |
| GET | `/me` | Личный профиль: статистика (assigned/overdue/completed_*), донат по активным отчётам, `role_breakdown`, `team`, `badges`, `studio_rank: {place, total}` — вкладка «Я» |
| POST | `/me/profile` | `{status_text, bio}` — правка своего статуса/о себе |
| GET | `/me/activity` | Личная лента последних действий по отчётам |
| POST | `/presence/ping` | Хартбит «я сейчас в приложении» — раз в минуту, влияет на `is_online`/`online` у команды и профиля |

## Список отчётов

| Метод | Путь | Параметры/тело | Назначение |
|---|---|---|---|
| GET | `/reports` | `q, status, priority, sort, assignee, overdue, unassigned, page_size` | Список с фильтрами — вкладка «Список» и опрос новых назначений (`assignee=me`) |
| GET | `/assignable-users` | — | Список для выпадающего меню «Назначить» |
| GET | `/report/{public_id}` | — | Карточка отчёта — статус/приоритет/срок/исполнители/автор |
| POST | `/report/{public_id}/status` | `{status, comment}` | Смена статуса одному отчёту |
| POST | `/report/{public_id}/assign` | `{telegram_id}` | Назначение исполнителя одному отчёту |
| POST | `/report/{public_id}/details` | `{priority}` \| `{deadline}` \| `{clear_deadline: true}` | Правка приоритета/срока |
| POST | `/reports/bulk/status` | `{public_ids, status}` | Массовая смена статуса |
| POST | `/reports/bulk/assign` | `{public_ids, telegram_id}` | Массовое назначение |
| POST | `/report/{public_id}/unassign` | `{telegram_id}` | Снять одного исполнителя (кнопка ✕ у карточки исполнителя) |
| POST | `/report/{public_id}/delete` | — | Удалить отчёт — владелец сразу, обычный админ через подтверждение владельцем (`pending_approval`) |
| GET | `/report/{public_id}/history` | `offset, page_size` | История смены статуса, листается «Показать ещё» |
| GET | `/report/{public_id}/activity` | `offset, page_size` | Лента действий по отчёту |

## Карточка отчёта — чек-лист, заметки, файлы

| Метод | Путь | Тело | Назначение |
|---|---|---|---|
| GET | `/report/{public_id}/checklist` | — | Список пунктов чек-листа |
| POST | `/report/{public_id}/checklist` | `{text}` | Добавить пункт |
| POST | `/report/{public_id}/checklist/{item_id}/toggle` | — | Отметить/снять пункт |
| POST | `/report/{public_id}/checklist/{item_id}/delete` | — | Удалить пункт |
| GET | `/report/{public_id}/notes` | — | Список заметок |
| POST | `/report/{public_id}/notes` | `{text}` | Добавить заметку |
| GET | `/report/{public_id}/files` | — | Файлы отчёта (для карточки) |
| POST | `/report/{public_id}/files/{file_id}/qc` | — | Серверная AI-проверка звука (Silero VAD — точнее локальной эвристики клиента) |
| GET | `/report/{public_id}/files/{file_id}/download` | — | Скачать файл. Запрос делает Rust (`download_report_file` в `main.rs`) с обычным заголовком `X-Init-Data`, путь сохранения выбирает нативный диалог. Раньше это была ссылка `<a target="_blank">` с `init_data` в query — она и не работала (webview не открывает новых окон), и уносила токен в URL |

## Dev-режим (только owner)

| Метод | Путь | Тело | Назначение |
|---|---|---|---|
| DELETE | `/dev/badge/{badge_id}` | — | Отозвать ранее выданную вручную награду |

## Не через сервер бота

- **Обновления** — Velopack (`GithubSource` в `src-tauri/src/main.rs`),
  читает релизы репозитория напрямую с GitHub (репозиторий публичный,
  свой прокси не нужен). Старый прокси `/api/desktop/update` на
  сервере бота удалён (был мёртвым кодом после перехода на Velopack)
- **Канал обновлений** — стабильный (по умолчанию, `build.yml`, только
  на изменение `VERSION`) или альфа (`build-alpha.yml`, на каждый push
  в `main`, версия `VERSION-alpha.<номер запуска>`) — переключается в
  Настройках (`get_update_channel`/`set_update_channel` в `main.rs`,
  хранится через `tauri-plugin-store`). Каналы независимы — у каждого
  свой `releases.{channel}.json`, стабильный клиент альфа-сборки не видит
- **QC звука по локальному файлу** — вообще не ходит на сервер, целиком
  в Rust (`src-tauri/src/audio_qc.rs`), вызывается через
  `invoke("qc_analyze", {path})`
