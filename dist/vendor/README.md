# vendor/

Ванильные ESM-файлы из официальных npm-пакетов Tauri, скопированы как есть
(без сборщика — проект принципиально без bundler'а, см. комментарий в начале
dist/app/main.js). Нужны, чтобы выключить `withGlobalTauri` в tauri.conf.json
и импортировать API явно (`import { invoke } from "../vendor/tauri-api/core.js"`),
вместо `window.__TAURI__.*` — меньше поверхность API, доступной странице.

Импортируются обычными **относительными путями** — не бэйр-
спецификаторами вроде `@tauri-apps/api/core` через `<script
type="importmap">`. Так было раньше, но на реальном WebView2 у
пользователя внешний import map (`<script type="importmap" src="...">`)
не подхватился — весь граф модулей падал с ошибкой резолва прямо на
старте, сплэш-экран висел вечно. Из-за этого в двух вендоренных файлах
(`tauri-plugin-dialog/index.js`, `tauri-plugin-notification/index.js`)
первая строка **патчится вручную** при копировании из npm — их
собственный `import ... from '@tauri-apps/api/core'` меняется на
`'../tauri-api/core.js'` (единственная правка внутри вендоренных
файлов, остальное — 1:1 копия).

## Версии (синхронизировать с `tauri = "2"` в src-tauri/Cargo.toml)
- @tauri-apps/api@2.11.1 — core.js, event.js, window.js, dpi.js, image.js,
  external/tslib/tslib.es6.js (полный список файлов, которые реально
  импортируются друг из друга — не весь пакет)
- @tauri-apps/plugin-dialog@2 — index.js (первая строка патчится, см. выше)
- @tauri-apps/plugin-notification@2 — index.js (первая строка патчится, см. выше)

## Как обновить
```
npm install @tauri-apps/api@2 @tauri-apps/plugin-dialog@2 @tauri-apps/plugin-notification@2 --prefix /tmp/probe
# скопировать те же файлы из /tmp/probe/node_modules/... поверх этих,
# затем в tauri-plugin-dialog/index.js и tauri-plugin-notification/index.js
# поменять первую строку (import ... from '@tauri-apps/api/core')
# на relative-путь '../tauri-api/core.js'
```
