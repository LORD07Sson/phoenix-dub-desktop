// Перетаскивание файла из проводника прямо на открытую карточку
// отчёта — раньше единственный способ приложить файл был отправить его
// боту в чат (user/editing.py:receive_file), desktop к этому вообще не
// был причастен. onDragDropEvent — нативное OS-событие (не HTML5
// drag&drop), payload.paths — абсолютные пути на диске; сами байты
// читает и шлёт на сервер Rust-команда upload_report_file (см. main.rs)
// — так не нужен tauri-plugin-fs с capability-скоупом на произвольный
// путь на диске.
//
// Привязка "куда падает файл" — не по координатам курсора (в физических
// пикселях, с масштабированием под DPI монитора — точка, где легко
// промахнуться мимо конкретной строки без реального железа под рукой),
// а по тому, какая карточка отчёта сейчас ОТКРЫТА (см. setDropTarget в
// report-detail.js): нет открытой карточки — файл никуда не падает,
// просто подсказка "откройте карточку".

import { appWindow, invoke } from "./tauri.js";
import { state } from "./state.js";
import { toast } from "./api.js";

let activeReportId = null;
export function setDropTarget(publicId) { activeReportId = publicId; }

const ALLOWED_EXT = /\.(wav|mp3|flac|m4a|ogg|oga|mp4|mov|mkv|avi|png|jpe?g|webp|pdf|docx?|pptx?|zip)$/i;

function baseName(path) {
  return path.split(/[\\/]/).pop() || path;
}

// IIFE, не top-level await — тот же принцип, что и везде в проекте:
// не рассчитывать на фичи движка новее самого необходимого (см.
// историю с внешним import map, не подхватившимся в реальном WebView2).
(async () => {
  await appWindow.onDragDropEvent(async event => {
    const type = event.payload.type;
    if (type === "over" || type === "enter") {
      document.body.classList.toggle("drop-armed", !!activeReportId);
      return;
    }
    document.body.classList.remove("drop-armed");
    if (type !== "drop") return;

    if (!activeReportId) {
      toast("Откройте карточку отчёта, чтобы прикрепить файл.", "error");
      return;
    }

    for (const path of event.payload.paths || []) {
      const name = baseName(path);
      if (!ALLOWED_EXT.test(name)) {
        toast(`Формат файла не поддерживается: ${name}`, "error");
        continue;
      }
      toast(`Загружаю ${name}…`);
      try {
        await invoke("upload_report_file", { reportId: activeReportId, filePath: path, initData: state.token || "" });
        toast(`Файл прикреплён: ${name}`);
        document.dispatchEvent(new CustomEvent("report-file-uploaded", { detail: { publicId: activeReportId } }));
      } catch (e) {
        toast(`Не удалось загрузить ${name}: ${e}`, "error");
      }
    }
  });
})();
