// Журнал действий админов — то же, что «🧾 Журнал действий» в боте
// (admin/log_view.py): кто выдал или отозвал доступ, одобрил заявку,
// удалил отчёт. Только владельцу. /api/admin-log?page&page_size&action_type.

import { apiGet, openSheet, dialogSkeletonHtml } from "./api.js";
import { esc, relTime } from "./utils.js";
import { loadAvatars } from "./profile.js";
import { openReportDetail } from "./report-detail.js";

const PAGE_SIZE = 50;
const TYPE_META = {
  delete_report: { c: "var(--s-stop)", ic: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>' },
  revoke_access: { c: "var(--s-fix)", ic: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>' },
  grant_access: { c: "var(--s-done)", ic: '<path d="M5 12.5l4.5 4.5L19 7.5"/>' },
  approve_request: { c: "var(--s-review)", ic: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6 6.5-6M15 17l2 2 4-4"/>' },
};
const stripEmoji = s => String(s || "").replace(/^(?:[\p{Extended_Pictographic}️‍]\s*)+/u, "").trim();

function fmtWhen(iso) {
  const d = new Date(String(iso).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z"));
  if (isNaN(d)) return esc(iso);
  return `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function rowHtml(e) {
  const m = TYPE_META[e.action_type] || { c: "var(--ink-dim)", ic: '<circle cx="12" cy="12" r="3"/>' };
  // Удалённый отчёт открыть уже нельзя — ссылка только на живые.
  const isReport = /^R-\d+$/.test(e.target || "") && e.action_type !== "delete_report";
  return `
    <tr>
      <td class="al-when" title="${esc(relTime(e.created_at))}">${fmtWhen(e.created_at)}</td>
      <td class="al-actor"><span class="avatar-bubble al-av" data-avatar-for="${e.actor_telegram_id || ""}">${esc(String(e.actor).charAt(0).toUpperCase())}</span>${esc(e.actor)}</td>
      <td><span class="al-action" style="--c:${m.c}"><svg viewBox="0 0 24 24" aria-hidden="true">${m.ic}</svg>${esc(stripEmoji(e.action))}</span></td>
      <td class="al-target">${e.target ? (isReport ? `<button type="button" class="al-rid" data-al-report="${esc(e.target)}">${esc(e.target)}</button>` : esc(e.target)) : "—"}</td>
      <td class="al-detail">${e.detail ? esc(e.detail) : `<span class="tt-dim">—</span>`}</td>
    </tr>`;
}

export async function openAdminLogSheet() {
  const overlay = openSheet(`<h2>Журнал действий</h2>${dialogSkeletonHtml(6)}`, "wide");
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("al-sheet");
  let page = 0;
  let type = "";

  async function load() {
    const body = sheet.querySelector("#al-body");
    if (body) body.style.opacity = ".5";
    let d;
    try {
      d = await apiGet("/admin-log", { page, page_size: PAGE_SIZE, action_type: type });
    } catch (e) {
      sheet.innerHTML = `<h2>Журнал действий</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    const all = d.types.reduce((s, t) => s + t.count, 0);
    const from = d.total ? page * PAGE_SIZE + 1 : 0;
    const to = Math.min(d.total, (page + 1) * PAGE_SIZE);
    sheet.innerHTML = `
      <h2>Журнал действий</h2>
      <p class="tn-hint">Надзор за самими админами: доступ, заявки, удаление отчётов. Видно только владельцу.</p>
      <div class="chip-row al-types">
        <button type="button" class="qchip${type === "" ? " on" : ""}" data-al-type="">Все · ${all}</button>
        ${d.types.map(t => `<button type="button" class="qchip${type === t.value ? " on" : ""}" data-al-type="${esc(t.value)}"${t.count ? "" : " disabled"}>${esc(stripEmoji(t.label))} · ${t.count}</button>`).join("")}
      </div>
      <div class="al-wrap" id="al-body">
        ${d.entries.length ? `
        <table class="al-table">
          <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Что</th><th>Подробности</th></tr></thead>
          <tbody>${d.entries.map(rowHtml).join("")}</tbody>
        </table>` : `<div class="no-assignee" style="padding:16px;">Записей нет</div>`}
      </div>
      <div class="sheet-actions al-pager">
        <span class="al-range">${from}–${to} из ${d.total}</span>
        <span style="flex:1"></span>
        <button class="btn" data-al-page="-1"${page === 0 ? " disabled" : ""}>Новее</button>
        <button class="btn" data-al-page="1"${to >= d.total ? " disabled" : ""}>Старее</button>
        <button class="btn" data-close>Закрыть</button>
      </div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    loadAvatars(sheet);
    sheet.querySelectorAll("[data-al-type]").forEach(b => b.addEventListener("click", () => { type = b.dataset.alType; page = 0; load(); }));
    sheet.querySelectorAll("[data-al-page]").forEach(b => b.addEventListener("click", () => { page = Math.max(0, page + Number(b.dataset.alPage)); load(); }));
    sheet.querySelectorAll("[data-al-report]").forEach(b => b.addEventListener("click", () => openReportDetail(b.dataset.alReport)));
  }

  await load();
}
