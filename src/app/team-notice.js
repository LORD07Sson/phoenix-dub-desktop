// Объявление для команды — то же, что «📌 Объявление» в админ-панели
// бота: одна закреплённая строка («Вася в отпуске, не назначайте»),
// которую видят все. В десктопе — баннер над любой вкладкой.
// /api/team-notice (GET / POST {text} / POST /clear).
//
// «Скрыть» убирает баннер только у себя и только для этого текста:
// поставят новое объявление — оно снова появится.

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast } from "./api.js";
import { $, esc } from "./utils.js";
import { loadAvatars } from "./profile.js";

const POLL_INTERVAL_MS = 120_000;
let current = null;
let maxLength = 500;

function hiddenKey() { return `phoenix_notice_hidden_${state.telegramId || "anon"}`; }
function noticeSig(n) { return n ? `${n.created_at}|${n.text}` : ""; }
function isHidden(n) {
  try { return localStorage.getItem(hiddenKey()) === noticeSig(n); } catch (_) { return false; }
}

const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6"/></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function whenText(createdAt) {
  // Сервер пишет "YYYY-MM-DD HH:MM" по Москве — показываем как есть,
  // только дату по-русски.
  const m = String(createdAt || "").match(/^(\d{4})-(\d\d)-(\d\d)\s+(\d\d:\d\d)/);
  if (!m) return createdAt || "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}, ${m[4]} МСК`;
}

function render() {
  const el = $("#team-notice");
  if (!el) return;
  if (!current || isHidden(current)) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = `
    <span class="tn-ic">${PIN_ICON}</span>
    <div class="tn-body">
      <div class="tn-text">${esc(current.text)}</div>
      <div class="tn-meta">
        ${current.author ? `<span class="avatar-bubble tn-av" data-avatar-for="${current.author_telegram_id || ""}">${esc(current.author.replace(/^@/, "").charAt(0).toUpperCase())}</span>${esc(current.author)} · ` : ""}${esc(whenText(current.created_at))}
      </div>
    </div>
    <button type="button" class="icon-btn tn-btn" id="tn-edit" title="Изменить объявление" aria-label="Изменить объявление">${EDIT_ICON}</button>
    <button type="button" class="icon-btn tn-btn" id="tn-hide" title="Скрыть у себя (появится снова, если объявление сменят)" aria-label="Скрыть объявление">${CLOSE_ICON}</button>`;
  loadAvatars(el);
  el.querySelector("#tn-edit").addEventListener("click", openNoticeEditor);
  el.querySelector("#tn-hide").addEventListener("click", () => {
    try { localStorage.setItem(hiddenKey(), noticeSig(current)); } catch (_) { /* не критично */ }
    render();
  });
}

export async function refreshTeamNotice() {
  if (!state.token) return;
  try {
    const d = await apiGet("/team-notice");
    current = d.notice || null;
    maxLength = d.max_length || maxLength;
    render();
  } catch (_) { /* тихо: старый сервер без эндпоинта или нет сети */ }
}

export function clearTeamNotice() {
  current = null;
  render();
}

export function openNoticeEditor() {
  const overlay = openSheet(`
    <h2>Объявление для команды</h2>
    <p class="tn-hint">Одна закреплённая строка — её видят все: в боте при входе и здесь, над вкладками. Не для срочного, а для фонового «важно помнить».</p>
    <textarea id="tn-input" class="tn-input" maxlength="${maxLength}" rows="4" placeholder="Например: Никита в отпуске до 30 сентября — не назначайте ему серии">${esc(current ? current.text : "")}</textarea>
    <div class="tn-count"><span id="tn-count">0</span> / ${maxLength}</div>
    <div class="sheet-actions">
      ${current ? `<button class="btn danger" id="tn-clear">Убрать объявление</button>` : ""}
      <span style="flex:1"></span>
      <button class="btn" data-close>Отмена</button>
      <button class="btn primary" id="tn-save">${current ? "Заменить" : "Поставить"}</button>
    </div>`);
  const sheet = overlay.querySelector(".sheet");
  const input = sheet.querySelector("#tn-input");
  const count = sheet.querySelector("#tn-count");
  const sync = () => { count.textContent = input.value.length; };
  input.addEventListener("input", sync);
  sync();
  input.focus();
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelector("#tn-save").addEventListener("click", async e => {
    const text = input.value.trim();
    if (!text) { toast("Текст не может быть пустым.", "error"); return; }
    e.target.disabled = true;
    try {
      const d = await apiPost("/team-notice", { text });
      current = d.notice;
      render();
      overlay.remove();
      toast("Объявление поставлено — его видит вся команда.");
    } catch (err) {
      toast(`Не удалось поставить: ${err.message}`, "error");
      e.target.disabled = false;
    }
  });
  const clearBtn = sheet.querySelector("#tn-clear");
  if (clearBtn) clearBtn.addEventListener("click", async () => {
    if (!confirm("Убрать объявление у всей команды?")) return;
    clearBtn.disabled = true;
    try {
      await apiPost("/team-notice/clear", {});
      current = null;
      render();
      overlay.remove();
      toast("Объявление убрано.");
    } catch (err) {
      toast(`Не удалось убрать: ${err.message}`, "error");
      clearBtn.disabled = false;
    }
  });
}

window.setInterval(refreshTeamNotice, POLL_INTERVAL_MS);
