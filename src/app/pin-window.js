// Окно «📌 Открепить в окне» — маленькое read-only окно с ключевым
// состоянием одного отчёта (статус, срок, чек-лист, последние заметки),
// чтобы держать его на виду поверх других программ, не переключаясь
// обратно в студию. Отдельный вход (src/pin.html), не index.html — тому
// нужен весь экран входа/вкладки/трей-обвязка (десятки побочных
// эффектов верхнего уровня почти в каждом модуле main.js), этому — одна
// карточка. См. app/tauri.js::pinReportWindow — как это окно создаётся.

import { invoke, listen, getCurrentWindow, PIN_REPORT_EVENT } from "./tauri.js";
import { state } from "./state.js";
import { apiGet } from "./api.js";
import { esc, STATUS_DOT_CLASS, STATUS_COLOR_VAR, isOverdue, parseNoteTime } from "./utils.js";

// Тема — то же localStorage-значение, что читает theme.js в основном
// окне (общий origin у всех webview одного Tauri-приложения, см.
// SECURITY.md/README про происхождение). Полный theme.js сюда не тянем
// специально: он вешает обработчик клика на #theme-toggle, которого в
// этом окне просто нет — импорт уронил бы модуль в рантайме.
try { document.documentElement.dataset.theme = localStorage.getItem("phoenix-theme") || "dark"; } catch (_) {}

const root = document.getElementById("pin-root");
const appWindow = getCurrentWindow();

function currentPublicId() {
  return new URLSearchParams(location.search).get("id") || "";
}
let publicId = currentPublicId();

// Автообновление — то же read-only окно может часами висеть поверх
// другой программы, пока кто-то в основном окне двигает статус/пишет
// заметку. Интервал, не вебсокет — того же порядка, что и pingPresence
// в основном окне, а у сервера и так нет push-канала для карточки.
const REFRESH_MS = 15_000;
let refreshTimer = null;
let pinnedOnTop = true;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, REFRESH_MS); // DevSkim: ignore DS172411 — функция, не строка
}

function renderError(message) {
  root.innerHTML = `
    <div class="pin-card">
      <div class="pin-error">${esc(message)}</div>
    </div>
  `;
}

function checklistSummary(checklist) {
  if (!checklist.items.length) return "";
  const done = checklist.items.filter(i => i.done).length;
  return `<div class="pin-row"><span>✅ Чек-лист</span><b>${done}/${checklist.items.length}</b></div>`;
}

function notesHtml(notes) {
  const latest = notes.notes.slice(-4).reverse();
  if (!latest.length) return `<div class="pin-empty">Пока нет заметок</div>`;
  return latest.map(n => {
    const t = parseNoteTime(n.text);
    return `<div class="pin-note">
      <div class="pin-note-meta">${esc(n.author)}${t ? ` · <span class="note-time">${esc(t.label)}</span>` : ""}</div>
      <div class="pin-note-text">${esc(t ? t.rest : n.text)}</div>
    </div>`;
  }).join("");
}

async function load() {
  publicId = currentPublicId();
  if (!publicId) { renderError("Не выбран отчёт."); return; }
  try {
    const [detail, notes, checklist] = await Promise.all([
      apiGet(`/report/${publicId}`),
      apiGet(`/report/${publicId}/notes`),
      apiGet(`/report/${publicId}/checklist`),
    ]);
    const dotClass = STATUS_DOT_CLASS[detail.status] || "draft";
    const overdue = isOverdue(detail);
    const assignees = (detail.assignees || []).map(a => a.first_name || a.username || `ID ${a.telegram_id}`).join(", ");
    root.innerHTML = `
      <div class="pin-card">
        <div class="pin-head">
          <div class="pin-id">${esc(detail.public_id)}</div>
          <button class="icon-btn" id="pin-pinned-toggle" title="Поверх остальных окон">${pinnedOnTop ? "📌" : "📍"}</button>
        </div>
        <div class="pin-title">${esc(detail.title)}</div>
        <div class="detail-chips" style="margin:8px 0;">
          <span class="chip status-chip" style="--chip-accent: var(${STATUS_COLOR_VAR[detail.status] || "--s-draft"})"><span class="dot ${dotClass}"></span>${esc(detail.status_label)}</span>
          <span class="chip">${esc(detail.priority_label)}</span>
          <span class="chip" style="${overdue ? "border-color:var(--s-stop); color:var(--s-stop);" : ""}">${overdue ? "⏰ " : "📅 "}${esc(detail.deadline || "без срока")}</span>
        </div>
        ${assignees ? `<div class="pin-row"><span>👤 Исполнители</span><b>${esc(assignees)}</b></div>` : `<div class="pin-row"><span>👤 Исполнители</span><span class="pin-empty-inline">никто</span></div>`}
        ${checklistSummary(checklist)}
        <div class="pin-section-title">Заметки</div>
        <div class="pin-notes">${notesHtml(notes)}</div>
      </div>
    `;
    root.querySelector("#pin-pinned-toggle").addEventListener("click", async () => {
      pinnedOnTop = !pinnedOnTop;
      try { await appWindow.setAlwaysOnTop(pinnedOnTop); } catch (_) { /* платформа может не уметь — окно просто останется как есть */ }
      const btn = root.querySelector("#pin-pinned-toggle");
      if (btn) { btn.textContent = pinnedOnTop ? "📌" : "📍"; btn.title = pinnedOnTop ? "Поверх остальных окон (нажмите, чтобы убрать)" : "Обычное окно (нажмите, чтобы закрепить поверх остальных)"; }
    });
  } catch (e) {
    renderError(`Не удалось загрузить: ${e.message || e}`);
  } finally {
    scheduleRefresh();
  }
}

// Токен читаем напрямую из нативного хранилища (token_store.rs) — то
// же, что делает tryRestoreSession() в основном окне при старте.
// localStorage тут не при чём: авторизационный токен там никогда не
// лежал (см. SECURITY.md), он всегда только в Rust-хранилище.
async function boot() {
  try {
    state.token = await invoke("token_load");
  } catch (_) { state.token = null; }
  if (!state.token) {
    renderError("Не выполнен вход — откройте основное окно PHOENIX DUB и войдите.");
    return;
  }
  await load();
}

// Кто-то нажал «📌 Открепить в окне» на другом отчёте, пока это окно уже
// открыто — подменяем отчёт вместо того, чтобы плодить второе окно (см.
// pinReportWindow в app/tauri.js: он же переиспользует это окно).
listen(PIN_REPORT_EVENT, ev => {
  const nextId = ev.payload && ev.payload.publicId;
  if (!nextId) return;
  const url = new URL(location.href);
  url.searchParams.set("id", nextId);
  history.replaceState(null, "", url);
  load();
});

// Окно часто будет просто висеть на экране без фокуса — обновить сразу,
// как только на него посмотрели, а не ждать до следующего тика таймера.
window.addEventListener("focus", load);

boot();
