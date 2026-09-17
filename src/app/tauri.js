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

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { sendNotification } from "@tauri-apps/plugin-notification";

export { invoke, listen, emit, getCurrentWindow, WebviewWindow, openDialog, saveDialog, sendNotification, convertFileSrc };

export const appWindow = getCurrentWindow();

// Окно «📌 Открепить в окне» (report-detail.js) — отдельный WebviewWindow
// (Tauri 2 multiwebview, @tauri-apps/api/webviewWindow: конструктор бьёт
// в plugin:webview|create_webview_window, не в plugin:window|create —
// сверено по node_modules/@tauri-apps/api/webviewWindow.js, а не по
// памяти о Tauri 1, где модуль назывался иначе). Всегда один и тот же
// label — окно единственное: открепить второй отчёт значит заменить
// содержимое уже открытого окна, а не плодить второе поверх первого.
export const PIN_WINDOW_LABEL = "report-pin";
export const PIN_REPORT_EVENT = "pin-report-changed";

// Загружается отдельным HTML-входом (src/pin.html -> app/pin-window.js,
// см. vite.config.js: rollupOptions.input) — не главным index.html: тот
// поднимает весь экран входа/вкладки/трей-обвязку разом (побочные
// эффекты верхнего уровня почти в каждом модуле main.js тянет), а
// открепленному окну нужна только read-only карточка одного отчёта.
export async function pinReportWindow(publicId) {
  const existing = await WebviewWindow.getByLabel(PIN_WINDOW_LABEL);
  if (existing) {
    // Уже открыто — не плодим второе, просто подменяем отчёт в нём и
    // выводим на передний план.
    await emit(PIN_REPORT_EVENT, { publicId });
    await existing.setFocus();
    return existing;
  }
  return new WebviewWindow(PIN_WINDOW_LABEL, {
    url: `pin.html?id=${encodeURIComponent(publicId)}`,
    title: `📌 ${publicId} — PHOENIX DUB`,
    width: 360,
    height: 520,
    minWidth: 300,
    minHeight: 340,
    alwaysOnTop: true,
    decorations: true,
  });
}

// Открыть ссылку во внешнем браузере/приложении (plugin:shell|open) —
// внутри окна открывать чужие сайты незачем. Обычный <a target="_blank">
// в webview не работает вообще (нового окна никто не создаёт), так что
// это единственный рабочий способ.
export function openExternal(url) {
  return invoke("plugin:shell|open", { path: url });
}

// «Показать в папке» — открывает системный файловый менеджер на
// каталоге, содержащем указанный файл (сам plugin:shell|open умеет
// открывать и файлы, и папки; выделить конкретный файл внутри — уже
// отдельная программа на каждой ОС типа `explorer /select,`, а это
// shell:allow-execute — заведомо более широкое право, чем оправдано
// ради подсветки одного файла). Тот же shell:allow-open, что уже даёт
// "открыть в браузере" в карточке «Команда» — новых прав не требуется.
function parentDir(filePath) {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}
export function revealInFolder(filePath) {
  return invoke("plugin:shell|open", { path: parentDir(filePath) });
}
