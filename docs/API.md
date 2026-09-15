# API-контракт

Десктоп-клиент не хранит своей копии бизнес-логики — вся она в
`miniapp/server.py` (отдельный репозиторий бота PHOENIX DUB). Этот файл —
полный список эндпоинтов, которые реально дёргает `dist/app/*.js` (сверено
по коду, не по памяти; фронтенд раздроблен на модули по темам — список,
доска, тайтлы и т.п., каждый в своём файле) — держите в актуальном виде
при добавлении новых вызовов.

## Базовый URL и авторизация

- `API_BASE` в `dist/app/api.js` — `https://minitg.shitstudent.com:8443/api`
- Все запросы (кроме `/desktop/pair`) несут заголовок
  `X-Init-Data: dsk_<токен>` — desktop-токен, полученный при входе по коду
  (см. [README](../README.md#-как-войти)). Сервер отличает его от
  Telegram initData по префиксу `dsk_` (`_validate_desktop_token` в
  `miniapp/server.py`)
- Токен хранится в нативном хранилище учётных данных ОС
  (`src-tauri/src/token_store.rs`), не в localStorage/файле

## Вход

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/desktop/pair` | `{code, label}` | `{token, telegram_id, name}` — код из `/desktop` в боте, одноразовый, 5 минут |
| GET | `/whoami` | — | `{telegram_id, is_admin}` — используется при восстановлении сессии, чтобы проверить, что токен ещё не отозван |

## Обзор и профиль

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/overview` | Сводка по студии: счётчики отчётов по статусам, просрочка, топ-5 исполнителей, доступ, тикеты, дни рождения — вкладка «Обзор» |
| GET | `/me` | Личный профиль: статистика (assigned/overdue/completed_*), донат по активным отчётам, `role_breakdown`, `team`, `badges`, `studio_rank: {place, total}` — вкладка «Я» |

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

## Карточка отчёта — чек-лист, заметки, файлы

| Метод | Путь | Тело | Назначение |
|---|---|---|---|
| GET | `/report/{public_id}/checklist` | — | Список пунктов чек-листа |
| POST | `/report/{public_id}/checklist` | `{text}` | Добавить пункт |
| POST | `/report/{public_id}/checklist/{item_id}/toggle` | — | Отметить/снять пункт |
| GET | `/report/{public_id}/notes` | — | Список заметок |
| POST | `/report/{public_id}/notes` | `{text}` | Добавить заметку |
| GET | `/report/{public_id}/files` | — | Файлы отчёта (для карточки) |
| POST | `/report/{public_id}/files/{file_id}/qc` | — | Серверная AI-проверка звука (Silero VAD — точнее локальной эвристики клиента) |

## Не через сервер бота

- **Обновления** — Velopack (`GithubSource` в `src-tauri/src/main.rs`),
  читает релизы репозитория напрямую с GitHub (репозиторий публичный,
  свой прокси не нужен). Раньше был прокси `/api/desktop/update` на
  сервере бота — остался в коде сервера неиспользуемым, можно убрать
  отдельно при случае
- **QC звука по локальному файлу** — вообще не ходит на сервер, целиком
  в Rust (`src-tauri/src/audio_qc.rs`), вызывается через
  `invoke("qc_analyze", {path})`
