// QC звука по локальному файлу — целиком в Rust (src-tauri/src/audio_qc.rs),
// этот модуль только открывает диалог выбора файла и рисует результат.

import { invoke, openDialog } from "./tauri.js";
import { openSheet, dialogSkeletonHtml, toast } from "./api.js";
import { $, esc, formatTime, formatRange } from "./utils.js";

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

function findingsHtml(findings) {
  return findings.map(f => `
    <div class="qc-finding ${f.severity}">
      <span class="tag">${esc(FINDING_LABELS[f.kind] || f.kind)}</span>
      <div>
        <div class="time">${formatRange(f.start, f.end)}</div>
        <div>${esc(f.message)}</div>
      </div>
    </div>
  `).join("");
}

// Сам прогон QC + отрисовка результата — вынесено отдельной функцией,
// чтобы её могли звать и обычный диалог выбора файла (ниже), и
// file-drop.js напрямую с уже известным путём (без диалога).
export async function runQcAnalysis(path) {
  const overlay = openSheet(`
    <h2>QC звука</h2>
    <p style="color:var(--ink-soft); font-size:12.5px; margin-top:-8px;">${esc(path)}</p>
    <div id="qc-body">${dialogSkeletonHtml(3)}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());

  try {
    const report = await invoke("qc_analyze", { path });
    const body = overlay.querySelector("#qc-body");
    if (!report.findings.length) {
      body.innerHTML = `<div style="color:var(--s-done);">✓ Замечаний не найдено. Пик ${report.peak_dbfs.toFixed(1)} дБФС, RMS ${report.rms_dbfs.toFixed(1)} дБФС, длительность ${formatTime(report.duration)}.</div>`;
      return;
    }
    body.innerHTML =
      `<div style="color:var(--ink-soft); font-size:12.5px; margin-bottom:10px;">Длительность ${formatTime(report.duration)} · Пик ${report.peak_dbfs.toFixed(1)} дБФС · RMS ${report.rms_dbfs.toFixed(1)} дБФС</div>` +
      findingsHtml(report.findings);
  } catch (e) {
    overlay.querySelector("#qc-body").innerHTML = `<div style="color:var(--s-stop);">${esc(e)}</div>`;
  }
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

export async function runQcBatch(paths) {
  const overlay = openSheet(`
    <h2>QC звука — ${paths.length} ${paths.length === 1 ? "файл" : "файла"}</h2>
    <div class="qc-batch-head">
      <span id="qc-progress">Анализирую 1 из ${paths.length}…</span>
      <button class="btn ghost" id="qc-sort" hidden style="padding:4px 10px; font-size:12px;">Сначала проблемные</button>
    </div>
    <div class="qc-table" id="qc-rows">
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

  for (let i = 0; i < paths.length; i++) {
    // Закрыли шторку посреди прогона — дальше считать незачем.
    if (!overlay.isConnected) return;
    progressEl.textContent = `Анализирую ${i + 1} из ${paths.length}…`;
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
    if (!overlay.isConnected) return;

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
        box.innerHTML = findingsHtml(report.findings);
        row.classList.add("expandable");
        row.addEventListener("click", () => { box.hidden = !box.hidden; });
      }
      row.querySelector(".nm").title = `${paths[i]}\nДлительность ${formatTime(report.duration)}`;
    } else {
      row.querySelector(".st").innerHTML = `<span style="color:var(--s-stop);">не прочитан</span>`;
      row.querySelector(".qc-row-findings").innerHTML = `<div style="color:var(--s-stop); font-size:12px;">${esc(error)}</div>`;
      row.classList.add("expandable");
      row.addEventListener("click", () => {
        const box = row.querySelector(".qc-row-findings");
        box.hidden = !box.hidden;
      });
    }
  }

  const done = results.filter(Boolean);
  const bad = done.filter(r => r.severity === "error" || r.severity === "warn").length;
  const broken = done.filter(r => r.severity === "fail").length;
  progressEl.innerHTML = bad || broken
    ? `Готово: <span style="color:var(--s-stop);">${bad} с замечаниями</span>${broken ? ` · ${broken} не прочитано` : ""} из ${done.length}`
    : `Готово: замечаний нет ни в одном из ${done.length}`;

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
  const picked = await openDialog({
    multiple: true,
    filters: [{ name: "Аудио/видео", extensions: QC_EXTENSIONS }],
  });
  if (!picked) return;
  const list = Array.isArray(picked) ? picked : [picked];
  if (!list.length) return;
  if (list.length > 40) {
    toast("Больше 40 файлов за раз — это надолго; возьмите частями.", "error");
    return;
  }
  await runQc(list);
}

$("#open-qc").addEventListener("click", openQcDialog);
