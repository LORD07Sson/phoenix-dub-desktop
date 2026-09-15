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

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";
// tauri-plugin-updater/tauri-plugin-process — только пока автообновление
// не переведено на Velopack (отдельный PR #7, требует ответной правки
// Rust-стороны, main.rs на этой ветке её ещё не содержит). Как только
// #7 смержен — удалить оба импорта и их экспорт здесь и в settings.js
// (Velopack-вариант ходит через invoke("check_for_update")/
// invoke("download_and_apply_update"), плагины ему не нужны вовсе).
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export { invoke, listen, getCurrentWindow, openDialog, sendNotification, checkUpdate, relaunch };

export const appWindow = getCurrentWindow();
