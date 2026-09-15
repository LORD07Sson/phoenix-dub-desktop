# vendor/

Ванильные ESM-файлы из официальных npm-пакетов Tauri, скопированы как есть
(без сборщика — проект принципиально без bundler'а, см. комментарий в начале
dist/app/main.js). Нужны, чтобы выключить `withGlobalTauri` в tauri.conf.json
и импортировать API явно (`import { invoke } from "@tauri-apps/api/core"`),
вместо `window.__TAURI__.*` — меньше поверхность API, доступной странице.

Разрешение бэйр-спецификаторов (`@tauri-apps/api/core` и т.п.) — через
`<script type="importmap">` в index.html, не патчами самих файлов: так их
проще обновлять (просто переcкопировать из npm) при бампе версии Tauri.

## Версии (синхронизировать с `tauri = "2"` в src-tauri/Cargo.toml)
- @tauri-apps/api@2.11.1 — core.js, event.js, window.js, dpi.js, image.js,
  external/tslib/tslib.es6.js (полный список файлов, которые реально
  импортируются друг из друга — не весь пакет)
- @tauri-apps/plugin-dialog@2 — index.js
- @tauri-apps/plugin-notification@2 — index.js

## Как обновить
```
npm install @tauri-apps/api@2 @tauri-apps/plugin-dialog@2 @tauri-apps/plugin-notification@2 --prefix /tmp/probe
# скопировать те же файлы из /tmp/probe/node_modules/... поверх этих
```
