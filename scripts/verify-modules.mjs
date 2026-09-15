// Разовый скрипт проверки: реально ли резолвится граф ES-модулей
// dist/app/*.js (совпадают ли имена export/import между файлами — то,
// что node --check в принципе не видит, так как не резолвит модули).
// Не часть рантайма приложения, не грузится в проде — только для
// ручной/CI-проверки после правок в dist/app|vendor. Проект принципиально
// без package.json (никакого npm build/bundler в дереве) — jsdom для
// этого скрипта ставится разово и не сохраняется:
//   cd desktop_client && npm install --no-save jsdom && node scripts/verify-modules.mjs
//
// Поднимает jsdom с реальным index.html, стабит window.__TAURI_INTERNALS__
// (иначе синхронный getCurrentWindow() в vendor/tauri-api/window.js
// бросает исключение прямо на этапе импорта — в реальном приложении его
// подставляет сам Tauri) и импортирует dist/app/main.js напрямую — все
// импорты в dist/app|vendor относительные (никаких бэйр-спецификаторов
// вроде "@tauri-apps/api/core" и import map — на реальном WebView2
// пользователя внешний import map не подхватился, см. app/tauri.js),
// поэтому Node резолвит их сам, без кастомных loader-хуков.

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";
import path from "node:path";

const distDir = path.resolve(import.meta.dirname, "..", "dist");
const html = readFileSync(path.join(distDir, "index.html"), "utf8");

const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.navigator = dom.window.navigator;
globalThis.Image = dom.window.Image;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame || (cb => setTimeout(cb, 0));
globalThis.fetch = async () => { throw new Error("fetch недоступен в проверке — это нормально, сеть не нужна для проверки импортов"); };

// Минимальная заглушка Tauri-бэкенда — ровно то же самое, что и в
// Playwright-тестах этого проекта (см. summary методологии), только
// теперь на уровне window.__TAURI_INTERNALS__, а не window.__TAURI__:
// достаточно, чтобы модули импортировались и выполнили свой
// top-level код (навешивание обработчиков), не более.
dom.window.__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
  unregisterCallback: () => {},
  convertFileSrc: p => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

const mainUrl = pathToFileURL(path.join(distDir, "app", "main.js")).href;
await import(mainUrl);

console.log("OK: граф модулей dist/app/*.js резолвится без ошибок (import/export совпадают).");
// notifications.js вешает setInterval, который держал бы процесс открытым вечно.
process.exit(0);
