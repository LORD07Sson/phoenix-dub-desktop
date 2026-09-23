// Напоминания и мои сроки — то же, что «🔔 Уведомления» в боте
// (user/reminders.py): отчёты со сроком (просрочено / скоро) и личные
// напоминания «дата + текст» — бот пришлёт их в Telegram в этот день.
// /api/me/reminders (GET / POST {date, text}), /api/me/reminders/{id}/delete.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc } from "./utils.js";
import { fmtDay } from "./people.js";
import { openReportDetail } from "./report-detail.js";

const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

// null — если сервер старый (без /me/reminders) или ответ неполный.
export async function fetchReminders() {
  try {
    const d = await apiGet("/me/reminders");
    return d && Array.isArray(d.reminders) && Array.isArray(d.deadlines) ? d : null;
  } catch (_) { return null; }
}

function deadlineRow(r) {
  return `
    <button type="button" class="rm-dl${r.overdue ? " late" : ""}" data-open-report="${esc(r.public_id)}">
      <span class="rm-dl-date">${r.overdue ? "просрочено" : "до"} ${esc(fmtDay(r.deadline))}</span>
      <span class="pp-rid">${esc(r.public_id)}</span>
      <span class="rm-dl-title">${esc(r.title)}</span>
      <span class="pp-status">${esc(String(r.status_label || "").replace(/^(?:[\p{Extended_Pictographic}️‍]\s*)+/u, ""))}</span>
    </button>`;
}

export async function openRemindersSheet(onChange) {
  const overlay = openSheet(`<h2>Напоминания и сроки</h2>${dialogSkeletonHtml(5)}`);
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("rm-sheet");

  function render(d) {
    const soon = d.deadlines.filter(r => !r.overdue);
    const late = d.deadlines.filter(r => r.overdue);
    const active = d.reminders.filter(r => !r.notified);
    const done = d.reminders.filter(r => r.notified);
    sheet.innerHTML = `
      <h2>Напоминания и сроки</h2>
      <p class="tn-hint">Личное напоминание бот пришлёт вам в Telegram в выбранный день. То же, что «🔔 Уведомления» в боте.</p>
      <form class="rm-form" id="rm-form">
        <input type="date" id="rm-date" min="${d.today}" value="${d.today}" required aria-label="Когда напомнить">
        <input type="text" id="rm-text" maxlength="500" placeholder="О чём напомнить — например, сдать сведение Фрирен 2" required aria-label="Текст напоминания">
        <button class="btn primary" type="submit">Напомнить</button>
      </form>
      <div class="rm-sec-title">Мои напоминания${active.length ? ` · ${active.length}` : ""}</div>
      <div class="rm-list">
        ${active.length ? active.map(r => `
          <div class="rm-item${r.date === d.today ? " today" : ""}">
            <span class="rm-date">${r.date === d.today ? "сегодня" : esc(fmtDay(r.date))}</span>
            <span class="rm-text">${esc(r.text)}</span>
            <button type="button" class="icon-btn bd-del" data-rm-del="${r.id}" title="Удалить" aria-label="Удалить напоминание">${TRASH_ICON}</button>
          </div>`).join("") : `<div class="no-assignee">Напоминаний нет</div>`}
        ${done.length ? `<div class="rm-done">Уже пришли: ${done.length}</div>` : ""}
      </div>
      <div class="rm-sec-title">Мои сроки${d.deadlines.length ? ` · ${d.deadlines.length}` : ""}</div>
      <div class="rm-list">
        ${late.map(deadlineRow).join("")}
        ${soon.map(deadlineRow).join("")}
        ${d.deadlines.length ? "" : `<div class="no-assignee">Отчётов со сроком нет</div>`}
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelectorAll("[data-open-report]").forEach(b => b.addEventListener("click", () => openReportDetail(b.dataset.openReport)));
    sheet.querySelector("#rm-form").addEventListener("submit", async e => {
      e.preventDefault();
      const date = sheet.querySelector("#rm-date").value;
      const text = sheet.querySelector("#rm-text").value.trim();
      if (!date || !text) return;
      try {
        const r = await apiPost("/me/reminders", { date, text });
        toast(`Напомню ${date === d.today ? "сегодня" : fmtDay(date)}.`);
        render(r);
        if (onChange) onChange();
      } catch (err) { toast(err.message, "error"); }
    });
    sheet.querySelectorAll("[data-rm-del]").forEach(b => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        render(await apiPost(`/me/reminders/${b.dataset.rmDel}/delete`, {}));
        if (onChange) onChange();
      } catch (err) { toast(err.message, "error"); b.disabled = false; }
    }));
  }

  const d = await fetchReminders();
  if (!d) {
    sheet.innerHTML = `<h2>Напоминания и сроки</h2><div class="no-assignee">Не удалось загрузить</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  render(d);
}

// Карточка во вкладке «Я».
export async function fillRemindersCard(root) {
  const slot = root.querySelector("#reminders-card");
  if (!slot) return;
  const d = await fetchReminders();
  if (!d || !slot.isConnected) { if (slot.isConnected) slot.remove(); return; }
  const next = d.reminders.find(r => !r.notified);
  const late = d.deadlines.filter(r => r.overdue).length;
  slot.innerHTML = `
    <div class="dash-cell-head" style="margin-bottom:4px;">
      <span class="dash-cell-title">Напоминания и сроки</span>
      <span class="dash-link">открыть</span>
    </div>
    <div class="sub">${next ? `ближайшее — ${next.date === d.today ? "сегодня" : esc(fmtDay(next.date))}: ${esc(next.text.slice(0, 60))}` : "личных напоминаний нет"}${late ? ` · <span style="color:var(--s-stop);">просрочено ${late}</span>` : ""}</div>`;
  slot.onclick = () => openRemindersSheet(() => fillRemindersCard(root));
}
