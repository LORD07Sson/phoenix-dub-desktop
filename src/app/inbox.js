// Центр уведомлений: колокольчик в шапке и список всего, что касается
// человека, — действия других по его отчётам, @упоминания, новые
// личные, сроки и дни рождения (/api/me/inbox). Прочитано/нет хранится
// тут же, в localStorage: у каждого события стабильный id, а сервер
// общего «прочитано» для этого списка не ведёт.

import { state } from "./state.js";
import { apiGet } from "./api.js";
import { $, esc, relTime } from "./utils.js";
import { switchTab } from "./tabs.js";
import { openReportDetail } from "./report-detail.js";
import { openChatKey } from "./messages.js";

const POLL_MS = 60_000;
const FILTERS = [["all", "Все"], ["at", "Упоминания"], ["due", "Сроки"], ["work", "Работа"], ["chat", "Личные"]];
const ICON = { work: "▶", due: "⏰", at: "@", chat: "✉", team: "🎂" };
const COLOR = { work: "var(--fire)", due: "var(--s-stop)", at: "var(--gold)", chat: "var(--s-review)", team: "var(--s-done)" };

let items = [];
let filter = "all";
let lastUnread = 0;

function key() { return `phoenix_inbox_${state.telegramId || "anon"}`; }
function readState() {
  try { return JSON.parse(localStorage.getItem(key()) || "{}") || {}; } catch (_) { return {}; }
}
function saveState(st) {
  try { localStorage.setItem(key(), JSON.stringify(st)); } catch (_) { /* приватный режим — просто без памяти */ }
}
function isRead(it, st) {
  return (st.ids || []).includes(it.id) || (st.all && it.when <= st.all);
}
function markRead(id) {
  const st = readState();
  st.ids = Array.from(new Set([...(st.ids || []), id])).slice(-400);
  saveState(st);
}

function dayLabel(when) {
  const d = new Date(String(when).replace(" ", "T") + "Z");
  if (isNaN(d)) return "";
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  const diff = Math.round((t - x) / 864e5);
  if (diff <= 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function textOf(it) {
  const rep = it.report ? `<b>${esc(it.report)}</b> «${esc(it.title || "")}»` : "";
  if (it.kind === "work") {
    const detail = it.detail && !/^U-\d+$/.test(it.detail) ? `: ${esc(it.detail)}` : "";
    return `<b>${esc(it.actor)}</b> · ${esc(it.action)}${detail} — ${rep}`;
  }
  if (it.kind === "due") {
    const when = it.days < 0 ? `просрочен на ${-it.days} дн.` : it.days === 0 ? "срок сегодня" : "срок завтра";
    return `${rep} — <b>${when}</b>`;
  }
  if (it.kind === "at") return `<b>${esc(it.actor)}</b> упомянул(а) вас · ${esc(it.where)}<span class="ib-q">${esc(it.text)}</span>`;
  if (it.kind === "chat") return `<b>${it.count}</b> ${it.count === 1 ? "новое сообщение" : "новых сообщения"} от <b>${esc(it.actor)}</b>`;
  if (it.kind === "team") return `День рождения у <b>${esc(it.actor)}</b> ${it.days === 0 ? "сегодня 🎉" : `через ${it.days} дн.`}`;
  return "";
}

function paint() {
  const list = $("#ib-list"), badge = $("#ib-badge");
  if (!list) return;
  const st = readState();
  const shown = items.filter(it => filter === "all" || it.kind === filter);
  const unread = items.filter(it => !isRead(it, st)).length;
  badge.textContent = unread > 99 ? "99+" : String(unread);
  badge.hidden = !unread;
  const bell = $("#ib-bell");
  if (unread > lastUnread && lastUnread !== -1) {
    bell.classList.remove("ring");
    void bell.offsetWidth;
    bell.classList.add("ring");
  }
  lastUnread = unread;
  if (!shown.length) {
    list.innerHTML = `<div class="ib-empty">${items.length ? "В этом фильтре пусто." : "Ничего нового — всё под контролем."}</div>`;
    return;
  }
  let last = "", html = "";
  shown.forEach(it => {
    const day = dayLabel(it.when);
    if (day !== last) { html += `<div class="ib-day">${esc(day)}</div>`; last = day; }
    html += `<button type="button" class="ib-it${isRead(it, st) ? "" : " unread"}" data-ib="${esc(it.id)}" style="--c:${COLOR[it.kind] || "var(--fire)"}">
      <span class="ib-ic">${ICON[it.kind] || "•"}</span>
      <span class="ib-t">${textOf(it)}<span class="ib-m">${esc(relTime(it.when))}</span></span>
    </button>`;
  });
  list.innerHTML = html;
  list.querySelectorAll("[data-ib]").forEach(b => b.addEventListener("click", () => open(items.find(x => x.id === b.dataset.ib))));
}

function open(it) {
  if (!it) return;
  markRead(it.id);
  close();
  paint();
  if (it.chat) {
    openChatKey(it.chat);
    switchTab("messages");
  } else if (it.report) {
    if (state.isAdmin) openReportDetail(it.report);
    else switchTab("profile");
  }
}

function close() {
  const p = $("#ib-panel");
  if (p) p.hidden = true;
  const b = $("#ib-bell");
  if (b) b.setAttribute("aria-expanded", "false");
}

export async function refreshInbox() {
  if (!state.token) return;
  try {
    const d = await apiGet("/me/inbox");
    items = d.items || [];
    paint();
  } catch (_) { /* старый сервер или нет связи — колокольчик просто молчит */ }
}

export function resetInbox() {
  items = [];
  lastUnread = -1;
  paint();
}

function init() {
  const bell = $("#ib-bell"), panel = $("#ib-panel");
  if (!bell || !panel) return;
  $("#ib-filters").innerHTML = FILTERS.map(([k, l]) => `<button type="button" data-ibf="${k}" aria-pressed="${k === filter}">${l}</button>`).join("");
  $("#ib-filters").querySelectorAll("[data-ibf]").forEach(b => b.addEventListener("click", () => {
    filter = b.dataset.ibf;
    $("#ib-filters").querySelectorAll("[data-ibf]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    paint();
  }));
  bell.addEventListener("click", e => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    bell.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) refreshInbox();
  });
  $("#ib-readall").addEventListener("click", () => {
    const newest = items.reduce((m, it) => (it.when > m ? it.when : m), "");
    saveState({ ids: [], all: newest });
    paint();
  });
  document.addEventListener("click", e => { if (!panel.hidden && !panel.contains(e.target) && e.target !== bell) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) close(); });
  setInterval(() => { if (!$("#titlebar-apps").hidden) refreshInbox(); }, POLL_MS); // DevSkim: ignore DS172411 — функция, не строка
  window.addEventListener("focus", () => { if (!$("#titlebar-apps").hidden) refreshInbox(); });
  lastUnread = -1;
}

init();
