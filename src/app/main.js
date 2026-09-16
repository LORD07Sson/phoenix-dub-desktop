// PHOENIX DUB Desktop — точка входа. В основном vanilla JS с ES-модулями
// (Overview.jsx — первый компонент на SolidJS, см. историю миграции на
// Vite) — ходит напрямую в тот же REST API, что и мини-апп, через fetch().
//
// Раздроблено на src/app/*.js по темам (было — один файл на ~2000 строк,
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
import "./density.js";
import "./tabs.js";
import "./qc.js";
import { checkForUpdates } from "./settings.js";
import "./notifications.js";
import "./presence.js";
import "./command-palette.js";
import "./shortcuts-help.js";
import "./focus-mode.js";
import "./file-drop.js";
import "./avatar-hover.js";
import "./feed-badge.js";
import "./title-hover.js";

tryRestoreSession();
setTimeout(() => appWindow.show(), 0); // DevSkim: ignore DS172411 — функция, не строка
setTimeout(() => checkForUpdates(true), 3000); // DevSkim: ignore DS172411 — функция, не строка
