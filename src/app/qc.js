// QC звука по локальному файлу — целиком в Rust (src-tauri/src/audio_qc.rs),
// этот модуль только открывает диалог выбора файла и рисует результат.

import { invoke, openDialog } from "./tauri.js";
import { openSheet, dialogSkeletonHtml } from "./api.js";
import { $, esc, formatTime, formatRange } from "./utils.js";

const FINDING_LABELS = {
  clipping: "Клиппинг", silence: "Пауза", quiet: "Тихо", loud: "Громко",
};

async function openQcDialog() {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: "Аудио/видео", extensions: ["wav", "mp3", "flac", "m4a", "aac", "ogg", "mp4", "mkv", "mov"] }],
  });
  if (!path) return;

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
      report.findings.map(f => `
        <div class="qc-finding ${f.severity}">
          <span class="tag">${esc(FINDING_LABELS[f.kind] || f.kind)}</span>
          <div>
            <div class="time">${formatRange(f.start, f.end)}</div>
            <div>${esc(f.message)}</div>
          </div>
        </div>
      `).join("");
  } catch (e) {
    overlay.querySelector("#qc-body").innerHTML = `<div style="color:var(--s-stop);">${esc(e)}</div>`;
  }
}

$("#open-qc").addEventListener("click", openQcDialog);
