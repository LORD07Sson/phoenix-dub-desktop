// Тикеты поддержки — то же, что «🎫 Тикеты» в админ-панели бота
// (admin/tickets.py): список обращений, переписка целиком, ответ человеку
// (уходит ему в Telegram от бота), готовые ответы, закрыть и открыть
// заново. Владелец видит все обращения, обычный админ — только
// переданные ему (сервер проверяет сам).
//
// /api/tickets?status=open|closed, /api/tickets/{id},
// /api/tickets/{id}/reply {text}, /api/tickets/{id}/close, /reopen.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { esc, relTime } from "./utils.js";
import { loadAvatars } from "./profile.js";

const SEND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12l18-8-8 18-2-8-8-2Z"/></svg>';
const MAX_REPLY = 3500;

function initial(name) { return esc(String(name || "?").replace(/^@/, "").charAt(0).toUpperCase() || "?"); }

function listItemHtml(t, activeId) {
  return `
    <button type="button" class="tk-item${t.id === activeId ? " active" : ""}" data-tk="${t.id}">
      <span class="avatar-bubble tk-av">${initial(t.name)}</span>
      <span class="tk-item-main">
        <span class="tk-item-top"><b>${esc(t.name || "без имени")}</b><span>#${t.id}</span></span>
        <span class="tk-item-last">${esc(t.last_message || "без сообщений")}</span>
      </span>
      <span class="tk-item-time">${esc(relTime(t.updated_at))}</span>
    </button>`;
}

function bubbleHtml(p) {
  return `
    <div class="tk-msg ${p.from_support ? "out" : "in"}">
      <div class="tk-msg-meta">${esc(p.from_support ? (p.author || "поддержка") : (p.author || "человек"))} · ${esc(relTime(p.created_at))}</div>
      <div class="tk-bubble">${esc(p.text)}</div>
    </div>`;
}

function threadHtml(d) {
  const t = d.ticket;
  const open = t.status === "open";
  return `
    <div class="tk-thread-head">
      <span class="avatar-bubble tk-av lg" data-avatar-for="${t.telegram_id}">${initial(t.name)}</span>
      <div class="tk-thread-title">
        <b>${esc(t.name)}${t.username ? ` <span>@${esc(t.username)}</span>` : ""}</b>
        <span>Обращение #${t.id} · ${open ? "открыто" : `закрыто${t.closed_by ? ` · ${esc(t.closed_by)}` : ""}`}${t.assigned_to ? ` · передано: ${esc(t.assigned_to)}` : ""}</span>
      </div>
      <span class="tk-status ${open ? "open" : "closed"}">${open ? "Открыт" : "Закрыт"}</span>
      ${open
        ? `<button type="button" class="btn" data-tk-close>Закрыть</button>`
        : `<button type="button" class="btn" data-tk-reopen>Открыть заново</button>`}
    </div>
    <div class="tk-messages" id="tk-messages">
      ${d.posts.length ? d.posts.map(bubbleHtml).join("") : `<div class="no-assignee">Сообщений пока нет</div>`}
    </div>
    ${open ? `
    <div class="tk-compose">
      <div class="tk-quick">${(d.quick_replies || []).map((q, i) => `<button type="button" class="qchip" data-tk-quick="${i}" title="${esc(q.text)}">${esc(q.label)}</button>`).join("")}</div>
      <div class="tk-input-row">
        <textarea id="tk-input" rows="2" maxlength="${MAX_REPLY}" placeholder="Ответ уйдёт человеку в Telegram от бота…"></textarea>
        <button type="button" class="btn primary tk-send" id="tk-send" title="Отправить (Ctrl+Enter)" aria-label="Отправить">${SEND_ICON}</button>
      </div>
    </div>` : `<div class="tk-closed-note">Обращение закрыто. Откройте заново, чтобы ответить.</div>`}`;
}

export async function openTicketsSheet(initialId) {
  const overlay = openSheet(`<h2>Тикеты поддержки</h2>${dialogSkeletonHtml(5)}`, "wide");
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("tk-sheet");
  let status = "open";
  let activeId = initialId || null;
  let list = [];

  sheet.innerHTML = `
    <div class="tk-head">
      <h2>Тикеты поддержки</h2>
      <div class="seg-toggle" role="group" aria-label="Какие тикеты">
        <button type="button" class="seg-btn active" data-tk-status="open">Открытые</button>
        <button type="button" class="seg-btn" data-tk-status="closed">Закрытые</button>
      </div>
      <button type="button" class="icon-btn" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="tk-layout">
      <div class="tk-list" id="tk-list">${dialogSkeletonHtml(4)}</div>
      <div class="tk-thread" id="tk-thread"><div class="tk-empty">Выберите обращение слева</div></div>
    </div>`;
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());

  const listEl = sheet.querySelector("#tk-list");
  const threadEl = sheet.querySelector("#tk-thread");

  async function loadList() {
    listEl.innerHTML = dialogSkeletonHtml(4);
    try {
      const d = await apiGet("/tickets", { status });
      list = d.tickets || [];
    } catch (e) {
      listEl.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div>`;
      return;
    }
    renderList();
    if (!activeId && list.length) openThread(list[0].id);
    if (!list.length) threadEl.innerHTML = `<div class="tk-empty">${status === "open" ? "Открытых обращений нет — всё разобрано" : "Закрытых обращений нет"}</div>`;
  }

  function renderList() {
    listEl.innerHTML = list.length
      ? list.map(t => listItemHtml(t, activeId)).join("")
      : `<div class="no-assignee" style="padding:12px;">Пусто</div>`;
    listEl.querySelectorAll("[data-tk]").forEach(b => b.addEventListener("click", () => openThread(Number(b.dataset.tk))));
  }

  function showThread(d) {
    threadEl.innerHTML = threadHtml(d);
    loadAvatars(threadEl);
    const msgs = threadEl.querySelector("#tk-messages");
    msgs.scrollTop = msgs.scrollHeight;
    const input = threadEl.querySelector("#tk-input");
    const send = threadEl.querySelector("#tk-send");
    const doSend = async text => {
      text = (text || "").trim();
      if (!text) return;
      send.disabled = true;
      try {
        const r = await apiPost(`/tickets/${d.ticket.id}/reply`, { text });
        toast("Ответ доставлен.");
        showThread(r);
        loadList();
      } catch (e) {
        toast(e.message, "error");
        send.disabled = false;
      }
    };
    if (input) {
      input.focus();
      input.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doSend(input.value); });
      send.addEventListener("click", () => doSend(input.value));
      threadEl.querySelectorAll("[data-tk-quick]").forEach(b => b.addEventListener("click", () => {
        const q = d.quick_replies[Number(b.dataset.tkQuick)];
        input.value = q.text;
        input.focus();
      }));
    }
    const closeBtn = threadEl.querySelector("[data-tk-close]");
    if (closeBtn) closeBtn.addEventListener("click", async () => {
      if (!confirm(`Закрыть обращение #${d.ticket.id}? Человеку придёт уведомление.`)) return;
      closeBtn.disabled = true;
      try {
        const r = await apiPost(`/tickets/${d.ticket.id}/close`, {});
        toast("Обращение закрыто.");
        showThread(r);
        activeId = null;
        loadList();
      } catch (e) { toast(e.message, "error"); closeBtn.disabled = false; }
    });
    const reopenBtn = threadEl.querySelector("[data-tk-reopen]");
    if (reopenBtn) reopenBtn.addEventListener("click", async () => {
      reopenBtn.disabled = true;
      try {
        const r = await apiPost(`/tickets/${d.ticket.id}/reopen`, {});
        toast("Обращение снова открыто.");
        showThread(r);
        loadList();
      } catch (e) { toast(e.message, "error"); reopenBtn.disabled = false; }
    });
  }

  async function openThread(id) {
    activeId = id;
    renderList();
    threadEl.innerHTML = dialogSkeletonHtml(4);
    try {
      showThread(await apiGet(`/tickets/${id}`));
    } catch (e) {
      threadEl.innerHTML = `<div class="tk-empty">Не удалось открыть: ${esc(e.message)}</div>`;
    }
  }

  sheet.querySelectorAll("[data-tk-status]").forEach(b => b.addEventListener("click", () => {
    status = b.dataset.tkStatus;
    sheet.querySelectorAll("[data-tk-status]").forEach(x => x.classList.toggle("active", x === b));
    activeId = null;
    loadList();
  }));

  await loadList();
  if (initialId) openThread(initialId);
}
