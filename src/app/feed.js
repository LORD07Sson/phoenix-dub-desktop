// Вкладка «Лента» (история изменений по отчётам + админ-лог).
// Тот же /api/feed, что у мини-аппа — объединяет report_activity и
// (только для владельцев студии) admin_log, листается "Показать ещё".
//
// Вид — компактная лента активности: события сгруппированы по дням,
// одна строка на событие (кто · что · по какому отчёту · результат),
// подряд идущие смены статуса одного отчёта одним человеком свёрнуты в
// цепочку «Озвучка → Перезапись/дозапись → В работе».

import { state } from "./state.js";
import { apiGet, toast, dialogSkeletonHtml } from "./api.js";
import { $, esc, relTime, STATUS_COLOR_VAR } from "./utils.js";
import { openReportDetail } from "./report-detail.js";
import { markFeedSeen, getFeedLastSeen } from "./feed-badge.js";
import { loadAvatars } from "./profile.js";

const FEED_PAGE_SIZE = 60;
// Смены статуса одного отчёта одним человеком в пределах этого окна
// сворачиваются в одну строку-цепочку.
const CHAIN_WINDOW_MS = 30 * 60 * 1000;

const ICONS = {
  status: '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20v-4.5h4.5"/>',
  assign: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6 6.5-6 1.5 0 2.8.4 3.9 1.1M17 14v6M14 17h6"/>',
  unassign: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6 6.5-6 1.5 0 2.8.4 3.9 1.1M14 17h6"/>',
  create: '<path d="M12 5v14M5 12h14"/>',
  note: '<path d="M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h5"/>',
  file: '<path d="M20 11.5 12.4 19a5 5 0 0 1-7-7L13 4.4a3.3 3.3 0 0 1 4.7 4.7l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4l7-7"/>',
  deadline: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.5M9.5 2.5h5"/>',
  overdue: '<path d="M12 4 2.8 19.5h18.4zM12 10v4M12 17h.01"/>',
  pipeline: '<path d="M5 5l7 7-7 7M12 5l7 7-7 7"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"/>',
  admin: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
};

// action приходит с сервера строкой вида «Статус изменён (mini-app)» —
// источник в скобках выносим в отдельную метку, по остальному
// определяем тип события.
function parseAction(ev) {
  const raw = String(ev.action || "").replace(/^(?:[\p{Extended_Pictographic}️‍]\s*)+/u, "").trim();
  const m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const text = m ? m[1] : raw;
  const source = m ? m[2] : "";
  if (ev.kind === "admin") return { type: "admin", label: text.charAt(0).toLowerCase() + text.slice(1), source, color: "var(--s-stop)" };
  const t = text.toLowerCase();
  const pick = (type, label, color) => ({ type, label, source, color });
  if (t.includes("статус")) return pick("status", "смена статуса", "var(--fire)");
  if (t.includes("снят")) return pick("unassign", "снят исполнитель", "var(--ink-dim)");
  if (t.includes("назначен")) return pick("assign", "назначен исполнитель", "var(--s-review)");
  if (t.includes("создан")) return pick("create", "новый отчёт", "var(--s-done)");
  if (t.includes("просрочк")) return pick("overdue", "просрочка", "var(--s-stop)");
  if (t.includes("заметк")) return pick("note", "заметка", "var(--gold)");
  if (t.includes("файл")) return pick("file", "файл", "var(--s-review)");
  if (t.includes("пайплайн")) return pick("pipeline", "следующий этап", "var(--ember)");
  if (t.includes("дедлайн") || t.includes("срок")) return pick("deadline", "новый срок", "var(--s-fix)");
  if (t.includes("изменён") || t.includes("изменен")) return pick("edit", "правка отчёта", "var(--ink-soft)");
  return pick("dot", text.charAt(0).toLowerCase() + text.slice(1), "var(--ink-dim)");
}

function statusFromLabel(label) {
  const clean = String(label || "").replace(/^(?:[\p{Extended_Pictographic}️‍]\s*)+/u, "").trim();
  const hit = state.statusOptions.find(([, l]) => l.toLowerCase() === clean.toLowerCase());
  return { key: hit ? hit[0] : null, label: clean };
}

function statusPill(label) {
  const s = statusFromLabel(label);
  const v = s.key ? STATUS_COLOR_VAR[s.key] : "--ink-dim";
  return `<span class="fd-pill" style="--c: var(${v})"><i></i>${esc(s.label)}</span>`;
}

// «U-000001» — так сервер пишет исполнителя без имени (внутренний id).
// Подменяем на имя из /assignable-users, если человек там есть.
let usersById = null;
async function ensureUsers() {
  if (usersById) return;
  usersById = new Map();
  try {
    const d = await apiGet("/assignable-users");
    for (const u of d.users || []) usersById.set(Number(u.id), u);
  } catch (_) { /* без имён — покажем как есть */ }
}
function personChip(detail) {
  const m = String(detail || "").match(/^U-0*(\d+)$/);
  const u = m && usersById ? usersById.get(Number(m[1])) : null;
  const name = u ? u.name : String(detail || "");
  const tid = u ? u.telegram_id : "";
  return `<span class="fd-person"><span class="avatar-bubble fd-mini-av" data-avatar-for="${tid}">${esc(name.charAt(0).toUpperCase() || "?")}</span>${esc(name)}</span>`;
}

function parseTs(iso) {
  if (!iso) return new Date(NaN);
  return new Date(iso.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z"));
}
function hhmm(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function dayKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(d) {
  const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  const long = d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
  if (dayKey(d) === dayKey(today)) return { main: "Сегодня", sub: long };
  if (dayKey(d) === dayKey(y)) return { main: "Вчера", sub: long };
  return { main: long.charAt(0).toUpperCase() + long.slice(1), sub: d.getFullYear() !== today.getFullYear() ? String(d.getFullYear()) : "" };
}

// Свернуть подряд идущие смены статуса одного отчёта одним человеком.
function collapse(events) {
  const out = [];
  for (const ev of events) {
    const a = parseAction(ev);
    const prev = out[out.length - 1];
    if (prev && a.type === "status" && prev.a.type === "status" && prev.ev.public_id === ev.public_id
      && prev.ev.actor === ev.actor && Math.abs(parseTs(prev.ev.created_at) - parseTs(ev.created_at)) <= CHAIN_WINDOW_MS) {
      prev.chain.unshift(ev.detail); // лента идёт от новых к старым — старые статусы в начало цепочки
      continue;
    }
    out.push({ ev, a, chain: a.type === "status" ? [ev.detail] : null });
  }
  return out;
}

function resultHtml(item) {
  const { ev, a, chain } = item;
  if (chain) return chain.map(statusPill).join('<span class="fd-arrow">→</span>');
  if (a.type === "assign" || a.type === "unassign") return ev.detail ? personChip(ev.detail) : "";
  if (ev.detail) return `<span class="fd-detail">${esc(ev.detail)}</span>`;
  return "";
}

function rowHtml(item, lastSeen) {
  const { ev, a } = item;
  const d = parseTs(ev.created_at);
  const isNew = lastSeen && ev.created_at > lastSeen;
  const linkable = !!ev.public_id;
  const result = resultHtml(item);
  return `
    <div class="fd-row${linkable ? " linkable" : ""}${a.type === "admin" ? " admin" : ""}${isNew ? " is-new" : ""}" data-fd-type="${a.type}" data-fd-actor="${esc(ev.actor || "")}"${linkable ? ` data-open="${esc(ev.public_id)}" tabindex="0" role="button"` : ""}>
      <span class="fd-av">
        <span class="avatar-bubble" data-avatar-for="${ev.actor_telegram_id || ""}">${esc((ev.actor || "?").charAt(0).toUpperCase())}</span>
        <span class="fd-badge" style="--c:${a.color}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[a.type] || ICONS.dot}</svg></span>
      </span>
      <div class="fd-main">
        <div class="fd-line">
          <b class="fd-actor">${esc(ev.actor || "система")}</b>
          <span class="fd-verb">${esc(a.label)}</span>
          ${ev.public_id ? `<span class="fd-rid">${esc(ev.public_id)}</span>` : ""}
          ${ev.title ? `<span class="fd-title">${esc(ev.title)}</span>` : ""}
          ${a.type === "admin" ? `<span class="fd-tag owner">владелец</span>` : ""}
          ${a.source ? `<span class="fd-tag">${esc(a.source)}</span>` : ""}
        </div>
        ${result ? `<div class="fd-result">${result}</div>` : ""}
      </div>
      <time class="fd-time" title="${esc(relTime(ev.created_at))}">${isNew ? '<i class="fd-new-dot"></i>' : ""}${hhmm(d)}</time>
    </div>`;
}

function groupsHtml(items, lastSeen, lastDayKey) {
  let html = "";
  let current = lastDayKey;
  for (const it of items) {
    const d = parseTs(it.ev.created_at);
    const k = dayKey(d);
    if (k !== current) {
      if (current !== lastDayKey || html) html += `</div>`;
      const lbl = dayLabel(d);
      html += `<div class="fd-day" data-day="${k}"><div class="fd-day-head"><b>${esc(lbl.main)}</b>${lbl.sub ? `<span>${esc(lbl.sub)}</span>` : ""}</div>`;
      current = k;
    }
    html += rowHtml(it, lastSeen);
  }
  if (html) html += `</div>`;
  return { html, lastDayKey: current };
}

// ---------- фильтры ----------

const FILTERS = [
  ["all", "Все"],
  ["status", "Статусы"],
  ["assign", "Назначения"],
  ["content", "Файлы и заметки"],
  ["mine", "Мои"],
  ["admin", "Администрирование"],
];
const FILTER_TYPES = {
  status: ["status"],
  assign: ["assign", "unassign"],
  content: ["note", "file", "create", "edit", "pipeline", "deadline"],
  admin: ["admin"],
};
let activeFilter = "all";
let query = "";

function applyFilters(root) {
  const q = query.trim().toLowerCase();
  const me = (state.name || "").toLowerCase();
  root.querySelectorAll(".fd-row").forEach(row => {
    let ok = activeFilter === "all"
      || (activeFilter === "mine" ? row.dataset.fdActor.toLowerCase() === me || row.querySelector(`[data-avatar-for="${state.telegramId}"]`) : (FILTER_TYPES[activeFilter] || []).includes(row.dataset.fdType));
    if (ok && q) ok = row.textContent.toLowerCase().includes(q);
    row.hidden = !ok;
  });
  root.querySelectorAll(".fd-day").forEach(day => {
    day.hidden = !day.querySelector(".fd-row:not([hidden])");
  });
  const empty = root.querySelector("#fd-empty");
  if (empty) empty.hidden = !!root.querySelector(".fd-row:not([hidden])");
}

// ---------- сводка ----------

function summaryHtml(events) {
  const today = dayKey(new Date());
  const todays = events.filter(e => dayKey(parseTs(e.created_at)) === today);
  const count = t => todays.filter(e => parseAction(e).type === t).length;
  const people = [...new Map(todays.filter(e => e.actor).map(e => [e.actor, e])).values()];
  return `
    <div class="fd-summary">
      <div class="fd-sum-cell"><b>${todays.length}</b><span>событий сегодня</span></div>
      <div class="fd-sum-cell"><b>${count("status")}</b><span>смен статуса</span></div>
      <div class="fd-sum-cell"><b>${count("assign")}</b><span>назначений</span></div>
      <div class="fd-sum-cell fd-sum-people">
        <div class="fd-stack">${people.slice(0, 5).map(e => `<span class="avatar-bubble" data-avatar-for="${e.actor_telegram_id || ""}" title="${esc(e.actor)}">${esc(e.actor.charAt(0).toUpperCase())}</span>`).join("") || '<span class="fd-dim">никого</span>'}</div>
        <span>${people.length ? `${people.length} ${people.length === 1 ? "человек" : "человека"} в деле` : "сегодня тихо"}</span>
      </div>
    </div>`;
}

function headerHtml(isOwner) {
  return `
    <div class="page-header">
      <div>
        <h1>Лента</h1>
        <div class="sub">Все изменения в отчётах студии: кто, что и когда.</div>
      </div>
      <div class="page-header-actions">
        <label class="fd-search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="search" id="fd-q" placeholder="Отчёт, человек, статус…" value="${esc(query)}" aria-label="Поиск по ленте">
        </label>
      </div>
    </div>
    <div class="chip-row fd-filters">
      ${FILTERS.filter(([k]) => k !== "admin" || isOwner).map(([k, l]) => `<button type="button" class="qchip${activeFilter === k ? " on" : ""}" data-fd-filter="${k}">${l}</button>`).join("")}
    </div>`;
}

function wire(root) {
  root.querySelectorAll(".fd-row[data-open]:not([data-wired])").forEach(el => {
    el.dataset.wired = "1";
    el.addEventListener("click", () => openReportDetail(el.dataset.open));
    el.addEventListener("keydown", e => { if (e.key === "Enter") openReportDetail(el.dataset.open); });
  });
  loadAvatars(root);
}

export async function loadFeed() {
  const root = $("#feed-body");
  root.innerHTML = dialogSkeletonHtml(6);
  let d;
  try {
    [d] = await Promise.all([apiGet("/feed", { offset: 0, page_size: FEED_PAGE_SIZE }), ensureUsers()]);
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить ленту: ${esc(e.message)}</div>`;
    return false;
  }
  const events = d.events || [];
  // Точку «прочитано до» берём ДО отметки просмотра — иначе новых не
  // было бы никогда.
  const lastSeen = getFeedLastSeen();
  markFeedSeen(events[0]?.created_at);

  if (!events.length) {
    root.innerHTML = headerHtml(d.is_owner) + `<div class="empty-state">Пока тихо<div class="sub" style="margin-top:4px;">как только кто-то что-то сделает с отчётом — появится здесь</div></div>`;
    return;
  }

  let all = events.slice();
  const first = groupsHtml(collapse(all), lastSeen, null);
  let lastDay = first.lastDayKey;
  root.innerHTML = headerHtml(d.is_owner) + summaryHtml(all) + `
    <div class="fd-list" id="fd-list" data-count="${events.length}">${first.html}</div>
    <div class="empty-state" id="fd-empty" hidden>Под фильтр ничего не попало</div>
    ${d.has_more ? `<button class="btn feed-load-more" id="feed-loadmore">Показать ещё (${d.total - events.length})</button>` : ""}`;
  wire(root);
  applyFilters(root);

  root.querySelectorAll("[data-fd-filter]").forEach(b => b.addEventListener("click", () => {
    activeFilter = b.dataset.fdFilter;
    root.querySelectorAll("[data-fd-filter]").forEach(x => x.classList.toggle("on", x === b));
    applyFilters(root);
  }));
  root.querySelector("#fd-q").addEventListener("input", e => { query = e.target.value; applyFilters(root); });

  const more = $("#feed-loadmore");
  if (more) more.addEventListener("click", async () => {
    const list = $("#fd-list");
    const offset = parseInt(list.dataset.count, 10) || 0;
    more.disabled = true;
    more.textContent = "Загрузка…";
    try {
      const res = await apiGet("/feed", { offset, page_size: FEED_PAGE_SIZE });
      const fresh = res.events || [];
      all = all.concat(fresh);
      // Новая порция может продолжать последний день — тогда строки
      // дописываются в его группу, а не открывают дубль заголовка.
      const next = groupsHtml(collapse(fresh), lastSeen, lastDay);
      const lastGroup = list.querySelector(".fd-day:last-child");
      const cut = next.html.indexOf('<div class="fd-day"');
      const tail = cut < 0 ? next.html.replace(/<\/div>$/, "") : next.html.slice(0, cut).replace(/<\/div>$/, "");
      if (lastGroup && tail) lastGroup.insertAdjacentHTML("beforeend", tail);
      if (cut >= 0) list.insertAdjacentHTML("beforeend", next.html.slice(cut));
      lastDay = next.lastDayKey;
      list.dataset.count = offset + fresh.length;
      wire(root);
      applyFilters(root);
      if (res.has_more) {
        more.disabled = false;
        more.textContent = `Показать ещё (${res.total - offset - fresh.length})`;
      } else {
        more.remove();
      }
    } catch (e) {
      toast(`Не удалось загрузить ленту: ${e.message}`, "error");
      more.disabled = false;
    }
  });
}
