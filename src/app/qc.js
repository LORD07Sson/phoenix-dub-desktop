// QC звука по локальному файлу — целиком в Rust (src-tauri/src/audio_qc.rs),
// этот модуль только открывает диалог выбора файла и рисует результат.

import { invoke, pickInputFiles, pickOutputFile, revealInFolder, appWindow, sendNotification } from "./tauri.js";
import { openSheet, dialogSkeletonHtml, toast, apiPost } from "./api.js";
import { $, esc, formatTime, formatRange, noteTimePrefix } from "./utils.js";

const FINDING_LABELS = {
  clipping: "Клиппинг", silence: "Пауза", quiet: "Тихо", loud: "Громко",
};

// Список расширений, которые умеет разбирать qc_analyze — общий и для
// диалога выбора файла ниже, и для file-drop.js (перетащить файл на
// окно без открытой карточки отчёта — тоже запускает этот же QC).
export const QC_EXTENSIONS = ["wav", "mp3", "flac", "m4a", "aac", "ogg", "mp4", "mkv", "mov"];

function baseName(path) {
  return String(path).split(/[\\/]/).pop() || path;
}

// «2 файла», но «5 файлов» — раньше заголовок пакетного QC всегда
// писал «файла», и на десятке дорожек читалось «10 файла».
function pluralFiles(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "файл";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "файла";
  return "файлов";
}

const SCISSORS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1L20 20M8.1 15.9L20 4"/></svg>';

// path — необязателен: когда он есть (одиночный QC и раскрытая строка
// пакетного QC — там путь файла тоже известен), рядом с находкой
// рисуется кнопка «вырезать фрагмент», см. wireExportButtons ниже.
function findingsHtml(findings, path) {
  return findings.map(f => `
    <div class="qc-finding ${f.severity}">
      <span class="tag">${esc(FINDING_LABELS[f.kind] || f.kind)}</span>
      <div class="qc-finding-body">
        <div class="time">${formatRange(f.start, f.end)}</div>
        <div>${esc(f.message)}</div>
      </div>
      ${path ? `<button type="button" class="qc-export-btn" title="Сохранить фрагмент вокруг находки как WAV"
          data-export-path="${esc(path)}" data-export-start="${f.start}" data-export-end="${f.end}"
          data-export-kind="${esc(f.kind)}">${SCISSORS_ICON}Фрагмент</button>` : ""}
    </div>
  `).join("");
}

// ---------- волна с маркерами находок ----------
// Раньше QC-находки были просто списком с тайм-кодами — время видно,
// но не видно САМ сигнал: почему именно тут "тихо" или где именно на
// пике клиппинг. Огибающая амплитуды (min/max по бакетам, из Rust —
// generate_waveform в audio_qc.rs) рисуется под находками той же
// шкалой времени, с подсвеченными диапазонами находок — тот же приём,
// что маркеры в Adobe Audition/iZotope RX, только без открытия
// отдельного приложения.
const WAVEFORM_BUCKETS = 400;

function drawWaveform(canvas, waveform, findings) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 560;
  const cssHeight = 84;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const mid = cssHeight / 2;
  const buckets = waveform.peaks.length / 2;
  const barWidth = cssWidth / buckets;

  // Диапазоны находок — полупрозрачные полосы под волной, цвет по
  // серьёзности (та же пара цветов, что .qc-finding.error/.warn).
  const css = window.getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;

  (findings || []).forEach(f => {
    if (!waveform.duration) return;
    const x1 = (f.start / waveform.duration) * cssWidth;
    const x2 = (f.end / waveform.duration) * cssWidth;
    ctx.globalAlpha = .26;
    ctx.fillStyle = f.severity === "error" ? token("--s-stop", "#ff6b6b") : token("--s-work", "#ff9d4d");
    ctx.fillRect(x1, 0, Math.max(1.5, x2 - x1), cssHeight);
    ctx.globalAlpha = 1;
  });

  const grad = ctx.createLinearGradient(0, 0, 0, cssHeight);
  grad.addColorStop(0, token("--fire", "#ff6a2b"));
  grad.addColorStop(1, token("--gold", "#ffb444"));
  ctx.fillStyle = grad;
  for (let i = 0; i < buckets; i++) {
    const min = waveform.peaks[i * 2];
    const max = waveform.peaks[i * 2 + 1];
    const x = i * barWidth;
    const yTop = mid - max * mid;
    const yBottom = mid - min * mid;
    ctx.fillRect(x, yTop, Math.max(1, barWidth - 0.5), Math.max(1, yBottom - yTop));
  }

  ctx.strokeStyle = token("--line", "#1e212c");
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(cssWidth, mid + 0.5);
  ctx.stroke();
}

// Подгружается отдельно от самого QC-отчёта и не блокирует его показ:
// не всякий файл вообще имеет смысл рисовать волной (например, видео
// без звуковой дорожки), и вторая ffmpeg-команда не должна тормозить
// уже готовый список находок.
async function loadWaveform(overlay, path, findings) {
  const canvas = overlay.querySelector(".qc-waveform");
  if (!canvas) return;
  try {
    const waveform = await invoke("generate_waveform", { path, buckets: WAVEFORM_BUCKETS });
    if (!overlay.isConnected) return;
    drawWaveform(canvas, waveform, findings);
  } catch {
    // Тихо убираем плейсхолдер — не аудио/видео с дорожкой, или ffmpeg
    // не смог прочитать поток. Сам QC-анализ (qc_analyze) в этот момент
    // уже отрисован, вторая ошибка тем же текстом ничего не добавляет.
    canvas.remove();
  }
}

// Экспорт фрагмента вокруг находки — делегирование на document, а не
// точечная навеска после каждого рендера: кнопки живут и в одиночном
// QC, и в раскрытых строках пакетного QC, рендерятся динамически.
// Секунда запаса до/после находки — чтобы в вырезанном кусочке было
// слышно контекст, а не только сам щелчок клиппинга/срез паузы;
// верхнюю границу под длительность файла не подрезаем — ffmpeg -t за
// пределами файла просто останавливается на EOF сам.
document.addEventListener("click", async e => {
  const btn = e.target.closest(".qc-export-btn");
  if (!btn) return;
  const path = btn.dataset.exportPath;
  const start = Math.max(0, parseFloat(btn.dataset.exportStart) - 1);
  const end = parseFloat(btn.dataset.exportEnd) + 1;
  const kind = btn.dataset.exportKind;
  const stem = baseName(path).replace(/\.[^./\\]+$/, "");
  const savePath = await pickOutputFile(`${stem}_${kind}_${Math.round(start)}s.wav`, [{ name: "WAV", extensions: ["wav"] }]);
  if (!savePath) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Вырезаю…";
  try {
    await invoke("export_audio_clip", { path, start, end, savePath });
    toast("Фрагмент сохранён.", "success", {
      label: "Показать в папке",
      onClick: () => revealInFolder(savePath),
    });
  } catch (err) {
    toast(`Не удалось вырезать фрагмент: ${err}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// Сам прогон QC + отрисовка результата — вынесено отдельной функцией,
// чтобы её могли звать и обычный диалог выбора файла (ниже), и
// file-drop.js напрямую с уже известным путём (без диалога).
// opts.reportId — прогон запущен из карточки отчёта (кнопка «QC дорожки»),
// значит находки можно положить прямо в заметки этого отчёта: у каждой
// уже есть время начала, а заметки теперь понимают тайм-код.
export async function runQcAnalysis(path, opts = {}) {
  const overlay = openSheet(`
    <h2>QC звука</h2>
    <div class="qc-file" title="${esc(path)}">${esc(baseName(path))}</div>
    <div id="qc-body">${dialogSkeletonHtml(3)}</div>
    <div class="sheet-actions" id="qc-actions"><button class="btn" data-close>Закрыть</button></div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());

  try {
    const report = await invoke("qc_analyze", { path });
    const body = overlay.querySelector("#qc-body");
    const errors = report.findings.filter(f => f.severity === "error").length;
    const statsHtml = `
      <div class="qc-stats">
        <div class="qc-stat"><span>Длительность</span><b>${formatTime(report.duration)}</b></div>
        <div class="qc-stat"><span>Пик</span><b>${report.peak_dbfs.toFixed(1)} <i>дБФС</i></b></div>
        <div class="qc-stat"><span>RMS</span><b>${report.rms_dbfs.toFixed(1)} <i>дБФС</i></b></div>
        <div class="qc-stat"><span>Замечаний</span><b style="color:var(${errors ? "--s-stop" : report.findings.length ? "--s-work" : "--s-done"});">${report.findings.length}</b></div>
      </div>
      <div class="qc-wave-card"><canvas class="qc-waveform"></canvas></div>`;
    if (!report.findings.length) {
      body.innerHTML = statsHtml + `<div class="qc-clean">Замечаний не найдено — дорожка чистая.</div>`;
      loadWaveform(overlay, path, report.findings);
      return;
    }
    body.innerHTML = statsHtml + `<div class="qc-findings">${findingsHtml(report.findings, path)}</div>`;
    loadWaveform(overlay, path, report.findings);
    if (opts.reportId) wireAddToNotes(overlay, opts.reportId, report.findings);
  } catch (e) {
    overlay.querySelector("#qc-body").innerHTML = `<div style="color:var(--s-stop);">${esc(e)}</div>`;
  }
}

// Каждая находка уезжает в заметки отдельной строкой с тайм-кодом —
// перепечатывать «на 4:12 клиппинг» руками больше не нужно.
function wireAddToNotes(overlay, reportId, findings) {
  const actions = overlay.querySelector("#qc-actions");
  const btn = document.createElement("button");
  btn.className = "btn primary";
  btn.style.marginRight = "auto";
  btn.textContent = `В заметки отчёта (${findings.length})`;
  actions.prepend(btn);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Добавляю…";
    let added = 0;
    try {
      for (const f of findings) {
        await apiPost(`/report/${reportId}/notes`, { text: noteTimePrefix(f.start) + f.message });
        added++;
      }
      toast(`Добавлено заметок: ${added}.`);
      document.dispatchEvent(new CustomEvent("report-notes-added", { detail: { publicId: reportId } }));
      overlay.remove();
    } catch (e) {
      toast(`Добавлено ${added} из ${findings.length}: ${e.message}`, "error");
      btn.disabled = false;
      btn.textContent = `В заметки отчёта (${findings.length})`;
    }
  });
}

// ---------- пакетный прогон ----------
// Раньше несколько перетащенных дорожек открывали столько же модалок
// подряд, одна поверх другой (file-drop.js гонял runQcAnalysis в цикле):
// сравнить эпизод целиком было нельзя, а закрывать приходилось по одной.
// Здесь всё в одну таблицу: строка на файл, заполняется по мере анализа,
// клик по строке раскрывает находки. Файлы считаются по очереди, а не
// параллельно — каждый прогон запускает свой ffmpeg, и десяток сразу
// просто отнял бы у машины всё, что у неё есть.

const SEVERITY_RANK = { error: 0, warn: 1, ok: 2, fail: 3 };

function rowSeverity(report) {
  if (!report) return "fail";
  if (report.findings.some(f => f.severity === "error")) return "error";
  if (report.findings.length) return "warn";
  return "ok";
}

function summaryHtml(report) {
  const errors = report.findings.filter(f => f.severity === "error").length;
  const warns = report.findings.length - errors;
  if (!report.findings.length) return `<span style="color:var(--s-done);">чисто</span>`;
  const parts = [];
  if (errors) parts.push(`<span style="color:var(--s-stop);">${errors} ${errors === 1 ? "ошибка" : "ошибок"}</span>`);
  if (warns) parts.push(`<span style="color:var(--s-work);">${warns} ${warns === 1 ? "замечание" : "замечаний"}</span>`);
  return parts.join(" · ");
}

// Пакетный QC на десяток файлов реально занимает минуты (см. комментарий
// у runQcBatch выше — файлы считаются по очереди, не параллельно), и
// открытая шторка с таблицей результатов ничем не поможет, если само
// окно приложения в этот момент свёрнуто в трей — единственный внутри-
// оконный индикатор её никто не увидит. Системное уведомление — то,
// что реально дойдёт до пользователя независимо от состояния окна;
// isVisible() === false покрывает и «свёрнуто в трей», и «на другом
// виртуальном рабочем столе», а не только буквальный минимайз.
async function notifyBatchDoneIfHidden(total, bad, broken) {
  // Один try на весь путь, а не только на isVisible(): sendNotification
  // (tauri-plugin-notification) сама трогает window.Notification —
  // в окружениях без него (например, jsdom в notes-timecodes-test.mjs)
  // бросает синхронно, и необработанное исключение внутри async-функции
  // без await на вызывающей стороне роняет процесс целиком.
  try {
    if (await appWindow.isVisible()) return;
    const body = bad || broken
      ? `${bad} с замечаниями${broken ? `, ${broken} не прочитано` : ""} из ${total}`
      : `Замечаний нет ни в одном из ${total}`;
    sendNotification({ title: "Project — QC завершён", body });
  } catch {
    // нет доступа к состоянию окна/уведомлениям — молча пропускаем
  }
}

export async function runQcBatch(paths) {
  const overlay = openSheet(`
    <h2>QC звука — ${paths.length} ${pluralFiles(paths.length)}</h2>
    <div class="qc-batch-head">
      <span id="qc-progress">Анализирую 1 из ${paths.length}…</span>
      <button class="btn" id="qc-sort" hidden>Сначала проблемные</button>
    </div>
    <div class="qc-table" id="qc-rows">
      <div class="qc-table-head"><div class="nm">Файл</div><div class="pk">Пик</div><div class="rm">RMS</div><div class="st">Итог</div></div>
      ${paths.map((p, i) => `
        <div class="qc-row pending" data-i="${i}">
          <div class="nm" title="${esc(p)}">${esc(baseName(p))}</div>
          <div class="pk">—</div>
          <div class="rm">—</div>
          <div class="st">в очереди</div>
          <div class="qc-row-findings" hidden></div>
        </div>
      `).join("")}
    </div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `, "wide");
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());

  const rowsEl = overlay.querySelector("#qc-rows");
  const progressEl = overlay.querySelector("#qc-progress");
  const results = [];

  // Индикатор на иконке в панели задач — окно приложения на время
  // пакетного прогона часто свёрнуто в трей (студия оставляет его
  // работать фоном), внутренняя полоска прогресса в такой момент
  // никто не видит. Ошибку invoke здесь гасим — на платформе без
  // поддержки (см. cfg в Rust-команде set_window_progress) это не
  // повод ломать сам QC.
  const setTaskbarProgress = pct => invoke("set_window_progress", { progress: pct }).catch(() => {});

  for (let i = 0; i < paths.length; i++) {
    // Закрыли шторку посреди прогона — дальше считать незачем.
    if (!overlay.isConnected) { setTaskbarProgress(null); return; }
    progressEl.textContent = `Анализирую ${i + 1} из ${paths.length}…`;
    setTaskbarProgress(Math.round((i / paths.length) * 100));
    const row = rowsEl.querySelector(`.qc-row[data-i="${i}"]`);
    row.classList.remove("pending");
    row.classList.add("running");
    row.querySelector(".st").textContent = "считаю…";

    let report = null;
    let error = null;
    try {
      report = await invoke("qc_analyze", { path: paths[i] });
    } catch (e) {
      error = String(e);
    }
    // Закрыли посреди прогона — сбрасываем и индикатор на панели задач,
    // иначе он так и оставался висеть на последнем проценте.
    if (!overlay.isConnected) { setTaskbarProgress(null); return; }

    const severity = rowSeverity(report);
    results[i] = { path: paths[i], report, error, severity };
    row.classList.remove("running");
    row.classList.add(severity);
    if (report) {
      row.querySelector(".pk").textContent = report.peak_dbfs.toFixed(1);
      row.querySelector(".rm").textContent = report.rms_dbfs.toFixed(1);
      row.querySelector(".st").innerHTML = summaryHtml(report);
      const box = row.querySelector(".qc-row-findings");
      if (report.findings.length) {
        box.innerHTML = findingsHtml(report.findings, paths[i]);
        row.classList.add("expandable");
        row.addEventListener("click", e => {
          if (e.target.closest(".qc-row-findings")) return;
          box.hidden = !box.hidden;
        });
      }
      row.querySelector(".nm").title = `${paths[i]}\nДлительность ${formatTime(report.duration)}`;
    } else {
      row.querySelector(".st").innerHTML = `<span style="color:var(--s-stop);">не прочитан</span>`;
      row.querySelector(".qc-row-findings").innerHTML = `<div style="color:var(--s-stop); font-size:12px;">${esc(error)}</div>`;
      row.classList.add("expandable");
      row.addEventListener("click", e => {
        if (e.target.closest(".qc-row-findings")) return;
        const box = row.querySelector(".qc-row-findings");
        box.hidden = !box.hidden;
      });
    }
  }

  setTaskbarProgress(null);
  const done = results.filter(Boolean);
  const bad = done.filter(r => r.severity === "error" || r.severity === "warn").length;
  const broken = done.filter(r => r.severity === "fail").length;
  progressEl.innerHTML = bad || broken
    ? `Готово: <span style="color:var(--s-stop);">${bad} с замечаниями</span>${broken ? ` · ${broken} не прочитано` : ""} из ${done.length}`
    : `Готово: замечаний нет ни в одном из ${done.length}`;
  notifyBatchDoneIfHidden(done.length, bad, broken);

  // Сортировка — только когда есть что сортировать.
  const sortBtn = overlay.querySelector("#qc-sort");
  if (done.length > 1) {
    sortBtn.hidden = false;
    let sorted = false;
    sortBtn.addEventListener("click", () => {
      sorted = !sorted;
      const rows = Array.from(rowsEl.querySelectorAll(".qc-row"));
      rows.sort((a, b) => {
        const ia = Number(a.dataset.i), ib = Number(b.dataset.i);
        if (!sorted) return ia - ib;
        const ra = SEVERITY_RANK[results[ia].severity] ?? 9;
        const rb = SEVERITY_RANK[results[ib].severity] ?? 9;
        return ra - rb || ia - ib;
      });
      rows.forEach(r => rowsEl.appendChild(r));
      sortBtn.textContent = sorted ? "В порядке файлов" : "Сначала проблемные";
    });
  }
}

// Один файл — подробная карточка, несколько — сводная таблица.
export function runQc(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  if (!list.length) return;
  return list.length === 1 ? runQcAnalysis(list[0]) : runQcBatch(list);
}

async function openQcDialog() {
  const list = await pickInputFiles({
    multiple: true,
    filters: [{ name: "Аудио/видео", extensions: QC_EXTENSIONS }],
  });
  if (!list.length) return;
  if (list.length > 40) {
    toast("Больше 40 файлов за раз — это надолго; возьмите частями.", "error");
    return;
  }
  await runQc(list);
}

$("#open-qc").addEventListener("click", openQcDialog);
