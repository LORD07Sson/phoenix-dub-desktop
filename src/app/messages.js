// Вкладка «Сообщения» — переписка внутри студии (доска Messages из
// дизайна Project):
//  • общий чат студии;
//  • каналы с темами, как форум: канал «Фрирен 2» → темы «Кастинг»,
//    «Серия 7 — правки»… (канал создаёт админ, тему — любой участник,
//    удаляет канал/тему только владелец);
//  • личные переписки один на один.
// Доступна всем участникам, не только админам. Свои сообщения справа,
// чужие слева; таймкоды («12:34») и @упоминания подсвечиваются, у @ —
// подсказка по именам. Своё сообщение можно удалить (владелец — и чужое
// в общем чате и темах).
//
// API: /chats (общий, личные, channels), /chats/{id}/messages,
// POST /chats/{id}/messages {text}, …/messages/{mid}/delete,
// POST /chats/{id}/read, POST /chats/{id}/clear {both}, POST /chats/dm, /channels*, /topics/{id}/delete.
// Ключ беседы: "general", "dm:<a>:<b>", "t:<topic_id>". Обновление — опрос.

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml, mediaUrl } from "./api.js";
import { $, esc, relTime } from "./utils.js";
import { loadAvatars, openUserProfile } from "./profile.js";

const POLL_MS = 7000;
const SEND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12l18-8-8 18-2-8-8-2Z"/></svg>';
const HASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const OPEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

let chats = [];      // общий + личные
let channels = [];   // [{id, name, poster_url, topics:[...] , unread}]
let people = [];
let canModerate = false;      // владелец: удаляет чужое, каналы и темы
let canCreateChannel = false; // админ: создаёт каналы
const expanded = new Set();   // раскрытые каналы в списке
let activeId = null;
let messages = [];
let filter = "all";
let query = "";
let pollTimer = null;

// ---------- помощники ----------

function initial(name) { return esc(String(name || "?").replace(/^@/, "").charAt(0).toUpperCase() || "?"); }
function parseTs(iso) { return new Date(String(iso).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z")); }
function hhmm(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function dayKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(d) {
  const t = new Date(); const y = new Date(t); y.setDate(t.getDate() - 1);
  if (dayKey(d) === dayKey(t)) return "Сегодня";
  if (dayKey(d) === dayKey(y)) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}
function posterSrc(url) { return url ? mediaUrl("/img_proxy", { url }) : ""; }

// Беседа по ключу: общий/личная — из chats, тема — из каналов (с именем канала).
function findChat(id) {
  const c = chats.find(x => x.id === id);
  if (c) return c;
  for (const ch of channels) {
    const t = (ch.topics || []).find(x => x.id === id);
    if (t) return { ...t, channel_name: ch.name, channel_id: ch.id, poster_url: ch.poster_url, _topic: t, _channel: ch };
  }
  return null;
}
function recountChannel(ch) {
  ch.unread = (ch.topics || []).reduce((s, t) => s + (t.unread || 0), 0);
  ch.mentions = (ch.topics || []).reduce((s, t) => s + (t.mentions || 0), 0);
}

// Текст сообщения: экранируем, затем подсвечиваем таймкоды и @упоминания.
function richText(text) {
  let html = esc(text);
  html = html.replace(/(^|[\s(])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s.,!?)])/g,
    (_, pre, tc) => `${pre}<span class="ms-tc">${tc}</span>`);
  html = html.replace(/(^|\s)@([\p{L}\d_]{2,32})/gu, (_, pre, name) => {
    const me = (state.name || "").toLowerCase() === name.toLowerCase();
    return `${pre}<span class="ms-mention${me ? " me" : ""}">@${name}</span>`;
  });
  return html.replace(/\n/g, "<br>");
}

// ---------- список слева ----------

function chatAvatarHtml(c, lg) {
  const cls = lg ? " lg" : "";
  if (c.kind === "general") return `<span class="ms-chat-av general${cls}">${HASH_ICON}</span>`;
  if (c.kind === "dm" && c.peer) return `<span class="avatar-bubble ms-chat-av person${cls}" data-avatar-for="${c.peer.telegram_id}">${initial(c.peer.name)}</span>`;
  if (c.kind === "topic") {
    const src = posterSrc(c.poster_url);
    return src ? `<img class="ms-chat-av poster${cls}" src="${src}" alt="">` : `<span class="ms-chat-av channel${cls}">${HASH_ICON}</span>`;
  }
  return `<span class="ms-chat-av${cls}">${HASH_ICON}</span>`;
}

function lastLine(c) {
  const l = c.last;
  return l ? `${l.mine ? "Вы" : esc(l.author)}: ${esc(l.text)}` : "пока тихо";
}

function badges(c) {
  return `${c.mentions ? `<span class="ms-badge mention" title="Вас упомянули">@</span>` : ""}${c.unread ? `<span class="ms-badge">${c.unread}</span>` : ""}`;
}

function chatItemHtml(c) {
  return `
    <button type="button" class="ms-chat${c.id === activeId ? " active" : ""}" data-chat="${esc(c.id)}">
      ${chatAvatarHtml(c)}
      <span class="ms-chat-main">
        <span class="ms-chat-top"><b>${esc(c.title)}</b><time>${c.last ? esc(relTime(c.last.created_at)) : ""}</time></span>
        <span class="ms-chat-bottom"><span class="ms-chat-last">${lastLine(c)}</span>${badges(c)}</span>
      </span>
    </button>`;
}

function matches(c, q) {
  if (filter === "unread" && !c.unread) return false;
  if (filter === "mentions" && !(c.mentions || (c.kind === "dm" && c.unread))) return false;
  return !q || `${c.title} ${c.last ? c.last.text : ""}`.toLowerCase().includes(q);
}

function channelHtml(ch, q) {
  const nameHit = !q || ch.name.toLowerCase().includes(q);
  const topics = (ch.topics || []).filter(t => matches(t, nameHit && filter === "all" ? "" : q));
  if (!topics.length && !(nameHit && filter === "all")) return "";
  const open = expanded.has(ch.id) || (q && topics.length) || (ch.topics || []).some(t => t.id === activeId);
  const src = posterSrc(ch.poster_url);
  return `
    <div class="ms-channel${open ? " open" : ""}">
      <button type="button" class="ms-channel-row" data-channel="${ch.id}" aria-expanded="${open}">
        ${src ? `<img class="ms-chat-av poster" src="${src}" alt="">` : `<span class="ms-chat-av channel">${HASH_ICON}</span>`}
        <span class="ms-channel-name">${esc(ch.name)}</span>
        ${ch.mentions ? `<span class="ms-badge mention">@</span>` : ""}${ch.unread ? `<span class="ms-badge">${ch.unread}</span>` : ""}
        <span class="ms-chevron">${CHEVRON}</span>
      </button>
      ${open ? `<div class="ms-topics">
        ${topics.map(t => `
          <button type="button" class="ms-topic${t.id === activeId ? " active" : ""}" data-chat="${esc(t.id)}">
            <span class="ms-topic-hash">#</span>
            <span class="ms-chat-main">
              <span class="ms-chat-top"><b>${esc(t.title)}</b><time>${t.last ? esc(relTime(t.last.created_at)) : ""}</time></span>
              <span class="ms-chat-bottom"><span class="ms-chat-last">${lastLine(t)}</span>${badges(t)}</span>
            </span>
          </button>`).join("")}
        <form class="ms-new-topic" data-new-topic="${ch.id}">
          <input type="text" maxlength="80" placeholder="+ Новая тема" aria-label="Новая тема в канале ${esc(ch.name)}">
        </form>
      </div>` : ""}
    </div>`;
}

function listHtml() {
  const q = query.trim().toLowerCase();
  const general = chats.filter(c => c.kind === "general" && matches(c, q));
  const dms = chats.filter(c => c.kind === "dm" && matches(c, q));
  const chs = channels.map(ch => channelHtml(ch, q)).join("");
  const section = (title, extra) => `<div class="ms-section"><span>${title}</span>${extra || ""}</div>`;
  const html = general.map(chatItemHtml).join("")
    + ((chs || canCreateChannel) ? section("Каналы", canCreateChannel ? `<button type="button" class="ms-section-btn" id="ms-new-channel" title="Новый канал">${PLUS_ICON}</button>` : "") + (chs || `<div class="ms-empty-list small">Каналов пока нет</div>`) : "")
    + (dms.length ? section("Личные") + dms.map(chatItemHtml).join("") : "");
  return html || `<div class="ms-empty-list">${filter === "all" ? "Ничего не нашлось" : filter === "unread" ? "Всё прочитано" : "Вас пока не упоминали"}</div>`;
}

function renderList() {
  const el = $("#ms-list");
  if (!el) return;
  el.innerHTML = listHtml();
  loadAvatars(el);
  el.querySelectorAll("[data-chat]").forEach(b => b.addEventListener("click", () => openChat(b.dataset.chat)));
  el.querySelectorAll("[data-channel]").forEach(b => b.addEventListener("click", () => {
    const id = Number(b.dataset.channel);
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderList();
  }));
  el.querySelectorAll("[data-new-topic]").forEach(f => f.addEventListener("submit", async e => {
    e.preventDefault();
    const input = f.querySelector("input");
    const name = input.value.trim();
    if (!name) return;
    input.disabled = true;
    try {
      const r = await apiPost(`/channels/${f.dataset.newTopic}/topics`, { name });
      await refreshLists();
      expanded.add(Number(f.dataset.newTopic));
      await openChat(r.id);
    } catch (err) { toast(err.message, "error"); input.disabled = false; }
  }));
  el.querySelector("#ms-new-channel")?.addEventListener("click", openNewChannelDialog);
}

// ---------- лента ----------

function messagesHtml(c) {
  if (!messages.length) return `<div class="ms-empty">Здесь пока пусто — напишите первым.</div>`;
  const moderated = canModerate && (c.kind === "general" || c.kind === "topic");
  let html = "";
  let lastDay = null;
  let prev = null;
  for (const m of messages) {
    const d = parseTs(m.created_at);
    if (dayKey(d) !== lastDay) {
      html += `<div class="ms-day"><span>${esc(dayLabel(d))}</span></div>`;
      lastDay = dayKey(d);
      prev = null;
    }
    if (m.kind === "deleted") {
      html += `<div class="ms-msg ${m.mine ? "out" : "in"} deleted"><div class="ms-msg-col"><div class="ms-bubble ms-deleted">${m.mine ? "Вы удалили сообщение" : "Сообщение удалено"}</div></div></div>`;
      prev = null;
      continue;
    }
    // Подряд от одного человека в пределах 5 минут — без повторной шапки.
    const grouped = prev && prev.author_telegram_id === m.author_telegram_id && d - parseTs(prev.created_at) < 5 * 60000;
    const canDelete = m.mine || moderated;
    html += `
      <div class="ms-msg ${m.mine ? "out" : "in"}${grouped ? " grouped" : ""}">
        ${m.mine ? "" : `<span class="avatar-bubble ms-av" data-avatar-for="${m.author_telegram_id || ""}"${grouped ? ' style="visibility:hidden"' : ""}>${initial(m.author)}</span>`}
        <div class="ms-msg-col">
          ${grouped ? "" : `<div class="ms-meta">${m.mine ? "" : `<b>${esc(m.author)}</b>`}<time>${hhmm(d)}</time></div>`}
          <div class="ms-bubble-row">
            <div class="ms-bubble">${richText(m.text)}</div>
            ${canDelete ? `<button type="button" class="ms-del" data-del="${m.id}" title="${m.mine ? "Удалить сообщение" : "Удалить как владелец"}" aria-label="Удалить сообщение">${TRASH_ICON}</button>` : ""}
          </div>
        </div>
      </div>`;
    prev = m;
  }
  return html;
}

function peopleWord(n) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? "участник" : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "участника" : "участников");
}

function threadHeadHtml(c) {
  const title = c.kind === "topic" ? `<span class="ms-head-channel">${esc(c.channel_name)}</span><span class="ms-head-sep">›</span>${esc(c.title)}` : esc(c.title);
  const sub = c.kind === "general" ? `Вся студия · ${c.participants.length} ${peopleWord(c.participants.length)}`
    : c.kind === "dm" ? `Личная переписка${c.peer && c.peer.username ? ` · @${esc(c.peer.username)}` : ""}`
    : `Тема канала${c.created_by ? ` · создал(а) ${esc(c.created_by)}` : ""}`;
  return `
    <div class="ms-head">
      ${chatAvatarHtml(c, true)}
      <div class="ms-head-text"><b>${title}</b><span>${sub}</span></div>
      ${c.kind === "general" ? `<div class="ms-people">${c.participants.slice(0, 6).map(p => `<span class="avatar-bubble" data-avatar-for="${p.telegram_id}" title="${esc(p.name)}">${initial(p.name)}</span>`).join("")}${c.participants.length > 6 ? `<span class="ms-people-more">+${c.participants.length - 6}</span>` : ""}</div>` : ""}
      ${c.kind === "dm" && c.peer ? `<button type="button" class="btn" data-open-profile="${c.peer.telegram_id}">${OPEN_ICON}Профиль</button>` : ""}
      ${c.kind === "dm" ? `<button type="button" class="btn" data-clear-dm title="Переписка пропадёт только у вас, у собеседника останется">${TRASH_ICON}Очистить</button>` : ""}
      ${c.kind === "dm" && canModerate ? `<button type="button" class="btn danger" data-clear-dm-both title="Удалить переписку целиком — у вас и у собеседника">${TRASH_ICON}У обоих</button>` : ""}
      ${c.kind === "topic" && canModerate ? `
        <button type="button" class="btn" data-del-topic="${c.topic_id}" title="Удалить тему со всей перепиской">${TRASH_ICON}Тему</button>
        <button type="button" class="btn danger" data-del-channel="${c.channel_id}" title="Удалить канал со всеми темами">${TRASH_ICON}Канал</button>` : ""}
    </div>`;
}

function renderThread({ keepScroll } = {}) {
  const el = $("#ms-thread");
  if (!el) return;
  const c = findChat(activeId);
  if (!c) { el.innerHTML = `<div class="ms-empty">Выберите беседу слева</div>`; return; }
  const box = el.querySelector("#ms-msgs");
  const nearBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const draft = el.querySelector("#ms-input")?.value || "";
  const placeholder = c.kind === "general" ? "Написать всей студии… @ — упомянуть человека"
    : c.kind === "topic" ? `Написать в тему «${c.title}»… @ — упомянуть` : "Написать сообщение…";
  el.innerHTML = `
    ${threadHeadHtml(c)}
    <div class="ms-msgs" id="ms-msgs">${messagesHtml(c)}</div>
    <div class="ms-compose">
      <div class="ms-suggest" id="ms-suggest" hidden></div>
      <textarea id="ms-input" rows="1" maxlength="2000" placeholder="${esc(placeholder)}"></textarea>
      <button type="button" class="btn primary ms-send" id="ms-send" aria-label="Отправить" title="Отправить (Enter)">${SEND_ICON}</button>
    </div>`;
  loadAvatars(el);
  const msgs = el.querySelector("#ms-msgs");
  if (!keepScroll || nearBottom) msgs.scrollTop = msgs.scrollHeight;
  const input = el.querySelector("#ms-input");
  input.value = draft;
  autoGrow(input);
  wireThread(el, c);
}

// ---------- поведение ----------

function autoGrow(t) { t.style.height = "auto"; t.style.height = `${Math.min(160, t.scrollHeight)}px`; }

function wireThread(el, c) {
  const input = el.querySelector("#ms-input");
  const suggest = el.querySelector("#ms-suggest");
  el.querySelector("[data-open-profile]")?.addEventListener("click", e => openUserProfile(Number(e.currentTarget.dataset.openProfile)));
  // Личная переписка: «Очистить» — только у себя (у собеседника всё
  // остаётся, новое сообщение снова покажет беседу); «У обоих» — владелец
  // удаляет её целиком с обеих сторон.
  const clearDm = async both => {
    const who = c.peer ? c.peer.name : "собеседником";
    const q = both
      ? `Удалить всю переписку с ${who} у вас обоих? Вернуть нельзя.`
      : `Очистить переписку с ${who}? Она пропадёт только у вас, у собеседника останется.`;
    if (!confirm(q)) return;
    try {
      await apiPost(`/chats/${encodeURIComponent(c.id)}/clear`, { both });
      toast(both ? "Переписка удалена у обоих" : "Переписка очищена", "success");
      activeId = "general";
      await refreshLists();
      await openChat(activeId);
    } catch (e) { toast(e.message, "error"); }
  };
  el.querySelector("[data-clear-dm]")?.addEventListener("click", () => clearDm(false));
  el.querySelector("[data-clear-dm-both]")?.addEventListener("click", () => clearDm(true));
  el.querySelector("[data-del-topic]")?.addEventListener("click", async () => {
    if (!confirm(`Удалить тему «${c.title}» со всей перепиской? Вернуть нельзя.`)) return;
    try {
      await apiPost(`/topics/${c.topic_id}/delete`, {});
      activeId = "general";
      await refreshLists();
      await openChat(activeId);
    } catch (e) { toast(e.message, "error"); }
  });
  el.querySelector("[data-del-channel]")?.addEventListener("click", async () => {
    if (!confirm(`Удалить канал «${c.channel_name}» со всеми темами и перепиской? Вернуть нельзя.`)) return;
    try {
      await apiPost(`/channels/${c.channel_id}/delete`, {});
      activeId = "general";
      await refreshLists();
      await openChat(activeId);
    } catch (e) { toast(e.message, "error"); }
  });
  el.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    const m = messages.find(x => String(x.id) === b.dataset.del);
    if (!confirm(m && !m.mine ? `Удалить сообщение ${m.author}? Текст сотрётся у всех.` : "Удалить сообщение? Текст сотрётся у всех.")) return;
    b.disabled = true;
    try {
      const r = await apiPost(`/chats/${encodeURIComponent(c.id)}/messages/${b.dataset.del}/delete`, {});
      messages = r.messages || messages;
      renderThread({ keepScroll: true });
    } catch (e) { toast(e.message, "error"); b.disabled = false; }
  }));
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    autoGrow(input);
    try {
      const r = await apiPost(`/chats/${encodeURIComponent(c.id)}/messages`, { text });
      messages = r.messages || messages;
      const target = c._topic || chats.find(x => x.id === c.id);
      if (target) target.last = { author: state.name, text, created_at: new Date().toISOString(), mine: true };
      renderList();
      renderThread();
      $("#ms-input")?.focus();
    } catch (e) {
      input.value = text;
      toast(`Не отправилось: ${e.message}`, "error");
    }
  };
  el.querySelector("#ms-send").addEventListener("click", send);
  input.addEventListener("input", () => { autoGrow(input); updateSuggest(input, suggest, c); });
  input.addEventListener("keydown", e => {
    if (!suggest.hidden && (e.key === "Enter" || e.key === "Tab")) {
      const first = suggest.querySelector("[data-pick]");
      if (first) { e.preventDefault(); pickMention(input, suggest, first.dataset.pick); return; }
    }
    if (e.key === "Escape") { suggest.hidden = true; return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
}

// Подсказка @упоминаний: в личке — собеседник, иначе все участники.
function updateSuggest(input, box, c) {
  const before = input.value.slice(0, input.selectionStart);
  const m = before.match(/(^|\s)@([\p{L}\d_]*)$/u);
  if (!m) { box.hidden = true; return; }
  const q = m[2].toLowerCase();
  const pool = c.kind === "dm" ? c.participants.filter(p => String(p.telegram_id) !== String(state.telegramId)) : people;
  const hits = pool.filter(p => String(p.name).toLowerCase().includes(q)).slice(0, 6);
  if (!hits.length) { box.hidden = true; return; }
  box.innerHTML = hits.map(p => `<button type="button" class="ms-pick" data-pick="${esc(p.name)}"><span class="avatar-bubble" data-avatar-for="${p.telegram_id}">${initial(p.name)}</span>${esc(p.name)}</button>`).join("");
  box.hidden = false;
  loadAvatars(box);
  box.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("mousedown", e => { e.preventDefault(); pickMention(input, box, b.dataset.pick); }));
}

function pickMention(input, box, name) {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos).replace(/@([\p{L}\d_]*)$/u, `@${name.replace(/\s+/g, "_")} `);
  input.value = before + input.value.slice(pos);
  input.setSelectionRange(before.length, before.length);
  box.hidden = true;
  input.focus();
}

// ---------- личные: «Новый диалог» ----------

function renderPicker() {
  const q = ($("#ms-picker-q")?.value || "").trim().toLowerCase();
  const list = $("#ms-picker-list");
  const hits = people.filter(p => !q || `${p.name} ${p.username || ""}`.toLowerCase().includes(q));
  list.innerHTML = hits.length ? hits.map(p => `
    <button type="button" class="ms-pick" data-dm="${p.telegram_id}">
      <span class="avatar-bubble" data-avatar-for="${p.telegram_id}">${initial(p.name)}</span>
      <span>${esc(p.name)}${p.username ? ` <i>@${esc(p.username)}</i>` : ""}</span>
    </button>`).join("") : `<div class="ms-empty-list">Никого не нашлось</div>`;
  loadAvatars(list);
  list.querySelectorAll("[data-dm]").forEach(b => b.addEventListener("click", () => startDm(Number(b.dataset.dm))));
}

// «Написать» с других экранов (Команда): вкладка может быть ещё не
// загружена — тогда переписку откроет loadMessages после списков.
let pendingDm = null;
export function openDmWith(telegramId) {
  if ($("#ms-list") && chats.length) startDm(telegramId);
  else pendingDm = telegramId;
}

// Открыть конкретную беседу по ключу (general, dm:…, t:…) — из центра
// уведомлений. Тот же приём: вкладка может быть ещё не загружена.
let pendingKey = null;
export function openChatKey(key) {
  if ($("#ms-list") && chats.length && findChat(key)) openChat(key);
  else pendingKey = key;
}

async function startDm(telegramId) {
  $("#ms-picker").hidden = true;
  try {
    const c = await apiPost("/chats/dm", { telegram_id: telegramId });
    if (!chats.some(x => x.id === c.id)) chats.push(c);
    await openChat(c.id);
    $("#ms-input")?.focus();
  } catch (e) { toast(e.message, "error"); }
}

// ---------- каналы: «Новый канал» ----------

async function openNewChannelDialog() {
  const overlay = openSheet(`<h2>Новый канал</h2>${dialogSkeletonHtml(4)}`);
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("ms-channel-sheet");
  let titles = [];
  try { titles = (await apiGet("/channels/titles")).titles || []; } catch (_) { /* без тайтлов — только своё название */ }
  const taken = new Set(channels.map(c => c.title_id).filter(Boolean));
  sheet.innerHTML = `
    <h2>Новый канал</h2>
    <p class="tn-hint">Канал — как папка с темами. Можно сделать канал под тайтл (будет постер) или просто по теме: «Звук», «Общие вопросы». Первая тема «Общее» появится сама.</p>
    <form class="ms-channel-form" id="ms-cf">
      <input id="ms-cf-name" type="text" maxlength="120" placeholder="Своё название, например «Звук»" aria-label="Название канала">
      <button class="btn primary" type="submit">Создать</button>
    </form>
    ${titles.length ? `<div class="ms-cf-label">или под тайтл</div>
    <div class="ms-cf-titles">
      ${titles.map(t => `
        <button type="button" class="ms-cf-title${taken.has(t.id) ? " taken" : ""}" data-title="${t.id}"${taken.has(t.id) ? " disabled title=\"Канал уже есть\"" : ""}>
          ${t.poster_url ? `<img src="${posterSrc(t.poster_url)}" alt="">` : `<span class="ms-chat-av channel">${HASH_ICON}</span>`}
          <span><b>${esc(t.name)}</b><i>${esc(t.season || "")}${taken.has(t.id) ? " · канал уже есть" : ""}</i></span>
        </button>`).join("")}
    </div>` : ""}
    <div class="sheet-actions"><button class="btn" data-close>Отмена</button></div>`;
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  const create = async body => {
    try {
      const r = await apiPost("/channels", body);
      overlay.remove();
      await refreshLists();
      expanded.add(r.id);
      const ch = channels.find(x => x.id === r.id);
      if (ch && ch.topics && ch.topics[0]) await openChat(ch.topics[0].id); else renderList();
      toast("Канал создан.");
    } catch (e) { toast(e.message, "error"); }
  };
  sheet.querySelector("#ms-cf").addEventListener("submit", e => {
    e.preventDefault();
    const name = sheet.querySelector("#ms-cf-name").value.trim();
    if (name) create({ name });
  });
  sheet.querySelectorAll("[data-title]").forEach(b => b.addEventListener("click", () => create({ title_id: Number(b.dataset.title) })));
}

// ---------- загрузка и опрос ----------

async function openChat(id) {
  activeId = id;
  renderList();
  const el = $("#ms-thread");
  el.innerHTML = dialogSkeletonHtml(5);
  try {
    const d = await apiGet(`/chats/${encodeURIComponent(id)}/messages`);
    if (activeId !== id) return;
    messages = d.messages || [];
    const c = findChat(id);
    const target = c && (c._topic || chats.find(x => x.id === id));
    if (target && target.unread) {
      target.unread = 0; target.mentions = 0;
      if (c._channel) recountChannel(c._channel);
      renderList();
      updateNavBadge();
      const lastId = messages.length ? messages[messages.length - 1].id : null;
      apiPost(`/chats/${encodeURIComponent(id)}/read`, { last_id: lastId }).catch(() => {});
    }
    renderThread();
    $("#ms-input")?.focus();
  } catch (e) {
    el.innerHTML = `<div class="ms-empty">Не удалось открыть беседу: ${esc(e.message)}</div>`;
  }
}

function updateNavBadge() {
  const btn = document.querySelector('.tab-btn[data-tab="messages"]');
  if (!btn) return;
  const n = chats.reduce((s, c) => s + (c.unread || 0), 0) + channels.reduce((s, c) => s + (c.unread || 0), 0);
  let b = btn.querySelector(".tab-badge");
  if (!n) { b?.remove(); return; }
  if (!b) { b = document.createElement("span"); b.className = "tab-badge"; btn.appendChild(b); }
  b.textContent = n > 99 ? "99+" : String(n);
}

async function refreshLists() {
  const d = await apiGet("/chats");
  // Только что открытая личка без сообщений на сервере ещё не значится —
  // не теряем её из списка между опросами.
  const pending = chats.filter(c => c.kind === "dm" && !c.last && !(d.chats || []).some(x => x.id === c.id));
  chats = (d.chats || []).concat(pending);
  channels = d.channels || [];
  people = d.people || people;
  canModerate = !!d.can_moderate;
  canCreateChannel = !!d.can_create_channel;
  renderList();
  updateNavBadge();
}

async function poll() {
  if (!document.querySelector("#ms-list")?.isConnected || document.hidden) return;
  // Пока человек печатает новую тему — список не перерисовываем.
  if (document.activeElement && document.activeElement.closest?.("[data-new-topic]")) return;
  try {
    await refreshLists();
    if (activeId) {
      const r = await apiGet(`/chats/${encodeURIComponent(activeId)}/messages`);
      const fresh = r.messages || [];
      const changed = fresh.length !== messages.length || fresh.some((m, i) => messages[i] && m.kind !== messages[i].kind);
      if (changed) { messages = fresh; renderThread({ keepScroll: true }); }
    }
  } catch (_) { /* тихо: следующий опрос попробует снова */ }
}

function shellHtml() {
  return `
    <div class="ms-layout">
      <aside class="ms-side">
        <div class="ms-side-head">
          <div class="ms-side-title"><h1>Сообщения</h1><button type="button" class="btn ms-new" id="ms-new" title="Написать человеку лично">${PLUS_ICON}Новый диалог</button></div>
          <div class="ms-picker" id="ms-picker" hidden>
            <input type="search" id="ms-picker-q" placeholder="Кому написать?" aria-label="Кому написать">
            <div class="ms-picker-list" id="ms-picker-list"></div>
          </div>
          <label class="fd-search ms-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input type="search" id="ms-q" placeholder="Канал, тема, человек, текст…" aria-label="Поиск по беседам" value="${esc(query)}">
          </label>
          <div class="seg-toggle ms-filters" role="group" aria-label="Фильтр бесед">
            ${[["all", "Все"], ["unread", "Непрочитанные"], ["mentions", "Упоминания"]].map(([k, l]) => `<button type="button" class="seg-btn${filter === k ? " active" : ""}" data-ms-filter="${k}">${l}</button>`).join("")}
          </div>
        </div>
        <div class="ms-list" id="ms-list"></div>
      </aside>
      <section class="ms-thread" id="ms-thread"></section>
    </div>`;
}

export async function loadMessages() {
  const root = $("#messages-body");
  root.innerHTML = shellHtml();
  root.querySelector("#ms-q").addEventListener("input", e => { query = e.target.value; renderList(); });
  root.querySelectorAll("[data-ms-filter]").forEach(b => b.addEventListener("click", () => {
    filter = b.dataset.msFilter;
    root.querySelectorAll("[data-ms-filter]").forEach(x => x.classList.toggle("active", x === b));
    renderList();
  }));
  $("#ms-list").innerHTML = dialogSkeletonHtml(6);
  root.querySelector("#ms-new").addEventListener("click", () => {
    const pk = $("#ms-picker");
    pk.hidden = !pk.hidden;
    if (!pk.hidden) { renderPicker(); $("#ms-picker-q").focus(); }
  });
  root.querySelector("#ms-picker-q").addEventListener("input", renderPicker);
  root.querySelector("#ms-picker-q").addEventListener("keydown", e => { if (e.key === "Escape") $("#ms-picker").hidden = true; });
  try {
    await refreshLists();
  } catch (e) {
    $("#ms-list").innerHTML = `<div class="ms-empty-list">Не удалось загрузить беседы: ${esc(e.message)}</div>`;
    return false;
  }
  if (!activeId || !findChat(activeId)) activeId = chats[0] ? chats[0].id : null;
  if (pendingDm) { const tid = pendingDm; pendingDm = null; await startDm(tid); }
  else if (pendingKey && findChat(pendingKey)) { const k = pendingKey; pendingKey = null; await openChat(k); }
  else if (activeId) await openChat(activeId); else renderThread();
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(poll, POLL_MS);
}
