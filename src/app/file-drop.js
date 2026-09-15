// Перетаскивание файла из проводника прямо на окно — раньше
// единственный способ приложить файл к отчёту был отправить его боту в
// чат (user/editing.py:receive_file), desktop к этому вообще не был
// причастен. onDragDropEvent — нативное OS-событие (не HTML5
// drag&drop), payload.paths — абсолютные пути на диске.
//
// Два разных действия в зависимости от того, что сейчас открыто:
// - открыта карточка отчёта (см. setDropTarget в report-detail.js) —
//   файл прикрепляется к ней. Привязка не по координатам курсора (в
//   физических пикселях, с масштабированием под DPI — легко
//   промахнуться мимо строки без реального железа под рукой), а по
//   тому, какая карточка ОТКРЫТА. Сами байты читает и шлёт на сервер
//   Rust-команда upload_report_file (см. main.rs) — так не нужен
//   tauri-plugin-fs с capability-скоупом на произвольный путь на диске.
// - карточка не открыта, а файл похож на аудио/видео (те же
//   расширения, что у кнопки «QC звука») — вместо ошибки запускаем
//   локальный QC прямо по перетащенному файлу (runQcAnalysis в
//   qc.js), путь уже известен из самого drop-события, диалог выбора
//   файла тут не нужен.

import { appWindow, invoke } from "./tauri.js";
import { state } from "./state.js";
import { toast } from "./api.js";
import { runQcAnalysis, QC_EXTENSIONS } from "./qc.js";

let activeReportId = null;
export function setDropTarget(publicId) { activeReportId = publicId; }

const ALLOWED_EXT = /\.(wav|mp3|flac|m4a|ogg|oga|mp4|mov|mkv|avi|png|jpe?g|webp|pdf|docx?|pptx?|zip)$/i;
const QC_EXT_RE = new RegExp(`\\.(${QC_EXTENSIONS.join("|")})$`, "i");

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
      // Теперь дроп что-то делает в любом случае (прикрепить к
      // карточке ИЛИ прогнать QC) — подсказку показываем всегда, а не
      // только когда есть открытая карточка.
      document.body.classList.add("drop-armed");
      return;
    }
    document.body.classList.remove("drop-armed");
    if (type !== "drop") return;

    const paths = event.payload.paths || [];

    if (!activeReportId) {
      const qcPaths = paths.filter(p => QC_EXT_RE.test(baseName(p)));
      if (!qcPaths.length) {
        toast("Откройте карточку отчёта, чтобы прикрепить файл (или перетащите аудио/видео для QC).", "error");
        return;
      }
      for (const path of qcPaths) await runQcAnalysis(path);
      return;
    }

    for (const path of paths) {
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
