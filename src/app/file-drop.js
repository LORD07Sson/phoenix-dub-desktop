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

// Всё, что можно приложить к отчёту = то, что понимает QC (аудио/видео)
// плюс документы и картинки. Раньше это был отдельный литерал-регэксп,
// и он разъехался с QC_EXTENSIONS: .aac прогонялся через QC, но на
// открытой карточке отчёта отклонялся как «формат не поддерживается».
// Тот же список продублирован в Rust (ALLOWED_UPLOAD_EXT в main.rs) —
// держать в синхроне руками, JS-проверку легко обойти, Rust-нельзя.
export const ATTACH_EXTENSIONS = [
  ...QC_EXTENSIONS, "oga", "avi", "png", "jpg", "jpeg", "webp", "pdf", "doc", "docx", "ppt", "pptx", "zip",
];
const extRe = list => new RegExp(`\\.(${list.join("|")})$`, "i");
const ALLOWED_EXT = extRe(ATTACH_EXTENSIONS);
const QC_EXT_RE = extRe(QC_EXTENSIONS);

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
