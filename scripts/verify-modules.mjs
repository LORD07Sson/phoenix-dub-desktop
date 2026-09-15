// Разовый скрипт проверки: реально ли резолвится и выполняется собранный
// Vite-бандл (dist/assets/*.js) — импортирует ли себя без ошибок, что
// node --check в принципе не видит (он не резолвит модули). Раньше
// (до перехода на Vite/Solid, см. историю миграции) импортировал
// dist/app/main.js напрямую — все импорты были относительными путями,
// без сборки. Теперь src/app/*.js(x) держит бэйр-специфи-каторы
// ("@tauri-apps/api/core") и JSX, которые сам Node не резолвит —
// поэтому проверяем УЖЕ СОБРАННЫЙ бандл (там всё уже инлайнено Vite,
// внешних импортов не остаётся, обычный self-contained ES-модуль):
//   cd desktop_client && npm run build && node scripts/verify-modules.mjs
//
// Поднимает jsdom с реальным dist/index.html, стабит
// window.__TAURI_INTERNALS__ (иначе синхронный getCurrentWindow() в
// @tauri-apps/api/window бросает исключение прямо на этапе импорта —
// в реальном приложении его подставляет сам Tauri) и импортирует тот
// же JS-чанк, что подключает index.html (имя с хэшем — не хардкодим,
// вычитываем из <script> в HTML).

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";
import path from "node:path";

const distDir = path.resolve(import.meta.dirname, "..", "dist");
let html;
try {
  html = readFileSync(path.join(distDir, "index.html"), "utf8");
} catch {
  console.error("dist/index.html не найден — сначала соберите: npm run build");
  process.exit(1);
}

const scriptMatch = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
if (!scriptMatch) {
  console.error("В dist/index.html не нашёлся <script type=\"module\" src=\"...\">.");
  process.exit(1);
}
const entryPath = path.join(distDir, scriptMatch[1].replace(/^\.\//, ""));

const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});

// Часть этих имён у самого Node — встроенные глобалы, причём
// определённые только геттером (navigator появился в Node 21): простое
// присваивание там падает с "Cannot set property ... which has only a
// getter". Поэтому кладём через defineProperty, а не через =.
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

setGlobal("window", dom.window);
setGlobal("document", dom.window.document);
setGlobal("localStorage", dom.window.localStorage);
setGlobal("navigator", dom.window.navigator);
setGlobal("Image", dom.window.Image);
// Vite сам вставляет в бандл IIFE-полифилл modulepreload, который
// создаёт MutationObserver сразу при импорте чанка (см. верх собранного
// файла) — без этого глобала import ниже падает ещё до нашего кода.
setGlobal("MutationObserver", dom.window.MutationObserver);
setGlobal("requestAnimationFrame", dom.window.requestAnimationFrame || (cb => setTimeout(cb, 0)));
setGlobal("fetch", async () => { throw new Error("fetch недоступен в проверке — это нормально, сеть не нужна для проверки импортов"); });

// Минимальная заглушка Tauri-бэкенда — ровно то же самое, что и в
// Playwright-тестах этого проекта (см. summary методологии): достаточно,
// чтобы модули импортировались и выполнили свой top-level код
// (навешивание обработчиков, root.render() и т.п.), не более.
dom.window.__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
  unregisterCallback: () => {},
  convertFileSrc: p => p,
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
};

await import(pathToFileURL(entryPath).href);

console.log(`OK: собранный бандл (${path.relative(distDir, entryPath)}) импортируется и выполняется без ошибок.`);
// notifications.js вешает setInterval, который держал бы процесс открытым вечно.
process.exit(0);
