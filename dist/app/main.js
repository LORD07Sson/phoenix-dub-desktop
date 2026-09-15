// PHOENIX DUB Desktop — точка входа. Обычный vanilla JS с ES-модулями,
// без сборщика (никакого webpack/vite/esbuild в проекте нет и не будет —
// ходит напрямую в тот же REST API, что и мини-апп, через fetch()).
//
// Раздроблено на dist/app/*.js по темам (было — один файл на ~2000 строк,
// см. историю git) — каждый модуль явно импортирует то, что ему нужно,
// вместо общей области видимости одного <script>. Порядок import'ов ниже
// не имеет значения для графа зависимостей (ES-модули резолвятся сами),
// но некоторые модули нужно импортировать именно отсюда явно — их
// побочный эффект (навешивание обработчиков на кнопки) не тянется
// транзитивно ни из одного другого модуля. Если добавляете новый модуль
// с своей DOM-разводкой (addEventListener на верхнем уровне) и он не
// импортируется ни одним из уже переходимых отсюда — добавьте import
// сюда тоже, иначе его код просто никогда не выполнится.

import { appWindow } from "./tauri.js";
import { tryRestoreSession } from "./auth.js";
import "./tabs.js";
import "./qc.js";
import { checkForUpdates } from "./settings.js";
import "./notifications.js";

tryRestoreSession();
setTimeout(() => appWindow.show(), 0); // DevSkim: ignore DS172411 — функция, не строка
setTimeout(() => checkForUpdates(true), 3000); // DevSkim: ignore DS172411 — функция, не строка
