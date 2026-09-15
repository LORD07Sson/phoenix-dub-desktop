// Единая точка входа в Tauri API — раньше был window.__TAURI__.* (требует
// app.withGlobalTauri:true в tauri.conf.json, то есть ВЕСЬ Tauri JS API
// доступен странице). Теперь withGlobalTauri выключен, импортируем только
// то, что реально нужно, явными именами — меньше поверхность на случай XSS
// через какой-нибудь чужой контент (постеры тайтлов и т.п. рендерятся через
// esc()/атрибуты, но лишняя защита в глубину не помешает).
//
// Раньше это были vendored копии npm-пакетов (dist/vendor/, скопированные
// вручную файлы) — обходили именно потому, что реальные бэйр-специфи-
// каторы ("@tauri-apps/api/core") требовали <script type="importmap">,
// а внешний import map на реальном WebView2 у пользователя не подхватился
// (баг конкретного WebView2-раннера, не спецификации) — весь граф модулей
// падал с ошибкой резолва прямо на старте. Теперь бэйр-специфи-каторы
// резолвит Vite на этапе сборки (см. vite.config.js) — в собранном
// dist/*.js их уже нет, только относительные пути между чанками, так что
// того бага тут больше нет по конструкции, а не потому что мы его обошли.
//
// tauri-plugin-updater/tauri-plugin-process не нужны — автообновление
// на Velopack (см. main.rs: check_for_update/download_and_apply_update,
// вызываются через invoke(); прогресс — событием "update-progress", его и
// слушаем через listen() ниже).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";

export { invoke, listen, getCurrentWindow, openDialog, saveDialog, sendNotification };

export const appWindow = getCurrentWindow();

// Открыть ссылку во внешнем браузере/приложении (plugin:shell|open) —
// внутри окна открывать чужие сайты незачем. Обычный <a target="_blank">
// в webview не работает вообще (нового окна никто не создаёт), так что
// это единственный рабочий способ.
export function openExternal(url) {
  return invoke("plugin:shell|open", { path: url });
}
