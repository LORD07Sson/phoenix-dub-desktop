// Единая точка входа в Tauri API — раньше был window.__TAURI__.* (требует
// app.withGlobalTauri:true в tauri.conf.json, то есть ВЕСЬ Tauri JS API
// доступен странице). Теперь withGlobalTauri выключен, импортируем только
// то, что реально нужно, явными именами — меньше поверхность на случай XSS
// через какой-нибудь чужой контент (постеры тайтлов и т.п. рендерятся через
// esc()/атрибуты, но лишняя защита в глубину не помешает).
//
// Сами файлы — vendored копии официальных npm-пакетов (см. dist/vendor/
// README.md), бэйр-спецификаторы ("@tauri-apps/api/core") резолвятся через
// <script type="importmap"> в index.html, не бандлером — в проекте его
// принципиально нет.
//
// tauri-plugin-updater/tauri-plugin-process больше не нужны — автообновление
// теперь на Velopack (см. main.rs: check_for_update/download_and_apply_update,
// вызываются через invoke(); прогресс — событием "update-progress", его и
// слушаем через listen() ниже). Раньше тут были ещё @tauri-apps/plugin-updater
// и @tauri-apps/plugin-process — удалены вместе с PR #7.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";

export { invoke, listen, getCurrentWindow, openDialog, sendNotification };

export const appWindow = getCurrentWindow();
