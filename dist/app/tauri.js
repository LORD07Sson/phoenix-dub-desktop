// Единая точка входа в Tauri API — раньше был window.__TAURI__.* (требует
// app.withGlobalTauri:true в tauri.conf.json, то есть ВЕСЬ Tauri JS API
// доступен странице). Теперь withGlobalTauri выключен, импортируем только
// то, что реально нужно, явными именами — меньше поверхность на случай XSS
// через какой-нибудь чужой контент (постеры тайтлов и т.п. рендерятся через
// esc()/атрибуты, но лишняя защита в глубину не помешает).
//
// Сами файлы — vendored копии официальных npm-пакетов (см. dist/vendor/
// README.md). Импортируем их ОТНОСИТЕЛЬНЫМИ путями, а не бэйр-
// спецификаторами ("@tauri-apps/api/core") через import map — на реальном
// WebView2 у пользователя внешний <script type="importmap" src="...">
// не подхватился (эта фича браузеров новее, чем сам инлайновый import map,
// и по факту оказалась не везде доступна), из-за чего весь граф модулей
// падал с ошибкой резолва прямо на старте — сплэш-экран висел вечно,
// tryRestoreSession() просто никогда не запускался. Относительные пути
// резолвятся штатным ES-module loader'ом браузера без каких-либо доп.
// фич — работает везде. dist/importmap.json удалён — больше не нужен.
//
// tauri-plugin-updater/tauri-plugin-process больше не нужны — автообновление
// теперь на Velopack (см. main.rs: check_for_update/download_and_apply_update,
// вызываются через invoke(); прогресс — событием "update-progress", его и
// слушаем через listen() ниже).

import { invoke } from "../vendor/tauri-api/core.js";
import { listen } from "../vendor/tauri-api/event.js";
import { getCurrentWindow } from "../vendor/tauri-api/window.js";
import { open as openDialog } from "../vendor/tauri-plugin-dialog/index.js";
import { sendNotification } from "../vendor/tauri-plugin-notification/index.js";

export { invoke, listen, getCurrentWindow, openDialog, sendNotification };

export const appWindow = getCurrentWindow();
