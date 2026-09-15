# PHOENIX DUB Desktop

Десктоп-клиент студии дубляжа PHOENIX DUB: список отчётов, доска по
статусам, массовые операции, профиль и рейтинг команды, локальный QC
звука через ffmpeg, трей с уведомлениями и автообновлением.

Клиент не хранит своей копии бизнес-логики — вся она в общем сервере
студии (`miniapp/server.py`, отдельный репозиторий бота); этот
репозиторий — только Tauri-обёртка и фронтенд, ходит в тот же REST API,
что и Telegram-мини-апп. Полный список используемых эндпоинтов — в
[docs/API.md](docs/API.md).

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

Нужны Rust (stable), Node.js 20+ и системные зависимости Tauri для
вашей ОС (см. [официальный гайд по установке](https://tauri.app/start/prerequisites/)).

```bash
npm install
npm run dev        # только фронтенд, hot-reload — для правок вёрстки
```

Полный запуск приложения (Rust + фронтенд, требует `npm run build` заранее):

```bash
npm install
npm run build
cd src-tauri
cargo run
```

Для сборки релизного бинарника (без установщика):

```bash
npm run build
cargo build --release --manifest-path src-tauri/Cargo.toml
```

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
