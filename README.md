# PHOENIX DUB Desktop

Десктоп-клиент студии дубляжа PHOENIX DUB: список отчётов, доска по
статусам, массовые операции, профиль и рейтинг команды, локальный QC
звука через ffmpeg, трей с уведомлениями и автообновлением.

Клиент не хранит своей копии бизнес-логики — вся она в общем сервере
студии (`miniapp/server.py`, отдельный репозиторий бота); этот
репозиторий — только Tauri-обёртка и фронтенд, ходит в тот же REST API,
что и Telegram-мини-апп. Полный список используемых эндпоинтов — в
[docs/API.md](docs/API.md).

## Вход

1. Написать боту студии в Telegram команду `/desktop` — он пришлёт
   одноразовый код (живёт 5 минут).
2. Ввести код в окне клиента. В обмен приходит desktop-токен `dsk_...`,
   который дальше лежит в системном хранилище учётных данных ОС
   (Credential Manager / Keychain / Secret Service), не в файле и не в
   localStorage.
3. Если токен отозвали (вышли на другом устройстве, сняли доступ),
   клиент сам вернёт на экран входа при первом же ответе `401`.

«Выйти» в шапке чистит и токен, и все загруженные данные — машина в
студии общая, следующий вошедший не должен видеть чужие отчёты.

## Стек

- **Tauri v2** (Rust) + **Vite** во фронтенде — большинство вкладок на
  обычном vanilla JS, `Overview.jsx` — на [SolidJS](https://solidjs.com)
  (первый пример частичной миграции, см. CHANGELOG; остальные вкладки
  переносятся постепенно, не одним махом)
- **Автообновление** — [Velopack](https://velopack.io), рассылка через
  GitHub Releases, отдельные stable/alpha-каналы
- **Токены** — в системном keyring ОС, не в localStorage/файле
- **Вход** — по одноразовому коду из Telegram-бота (см. `/desktop` в
  боте), не по паролю

## Разработка

Нужны Rust (stable, не ниже 1.88 — см. `rust-version` в
`src-tauri/Cargo.toml`), Node.js 24+ (столько же требует CI, см. `engines` в `package.json`) и системные зависимости Tauri для
вашей ОС (см. [официальный гайд по установке](https://tauri.app/start/prerequisites/)).

Проект не использует `cargo-tauri` CLI (собирается напрямую `cargo
build`/`cargo run`, см. build.yml) — поэтому переключение
devUrl/frontendDist, которое CLI обычно делает само, здесь ручное:
Cargo-фича `custom-protocol` **обязательна** при любом запуске без
работающего `npm run dev` — без неё бинарник (в любом профиле, включая
`--release`) пытается открыть `http://localhost:1420` и падает с
`ERR_CONNECTION_REFUSED`, если там никто не слушает.

Разработка с hot-reload (два терминала):

```bash
npm install && npm run dev          # терминал 1 — Vite dev-сервер
cd src-tauri && cargo run           # терминал 2 — без --features custom-protocol
```

Запуск как у обычного пользователя (без dev-сервера):

```bash
npm install && npm run build
cargo run --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

Сборка релизного бинарника (без установщика):

```bash
npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

Проверки перед коммитом (их же гоняет CI):

```bash
npm run lint                        # ESLint по src/app/**
npm run build && npm run verify     # собранный бандл реально импортируется
cargo test --manifest-path src-tauri/Cargo.toml
```

Номер версии живёт в одном месте — файле `VERSION` в корне. В
`tauri.conf.json`/`Cargo.toml` его подставляет CI перед сборкой, в
интерфейс («Настройки» → «Версия») — сам Vite через
`define: __APP_VERSION__` (см. `vite.config.js`), так что локальная
сборка показывает ту же версию, что лежит в `VERSION`.

Установщики (`Setup.exe`, `Portable.zip`, `.nupkg`) собирает CI —
[`build.yml`](.github/workflows/build.yml) для стабильных релизов,
[`build-alpha.yml`](.github/workflows/build-alpha.yml) — на каждый
пуш в `main`, тестовая rolling-сборка (см. переключатель канала в
Настройках приложения).

## Структура репозитория

| Путь | Что там |
|---|---|
| `src-tauri/` | Rust-бэкенд (команды, трей, автообновление, QC звука) |
| `src/` | Фронтенд-исходники — HTML/CSS/JS, раздроблен по темам в `src/app/*.js`; `Overview.jsx` — на SolidJS, остальные вкладки на vanilla JS (частичная миграция, см. CHANGELOG) |
| `dist/` | Собранный фронтенд (`npm run build`, Vite) — не в git, пересобирается всегда |
| `docs/API.md` | Список эндпоинтов сервера, которые дёргает клиент |
| `legacy_python_client/` | Старый клиент на Python/Tk, до миграции на Tauri — оставлен для истории, не используется и не поддерживается |

## Лицензия

См. [LICENSE](LICENSE) — весь код закрытый, репозиторий публикуется в
ознакомительных целях, использование без разрешения правообладателя не
допускается.
