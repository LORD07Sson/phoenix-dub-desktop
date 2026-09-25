// Вкладка «Календарь» — неделя по часам (по мотивам Untitled UI Week view).
// Что в ней:
//  • выход серий онгоингов текущего сезона — по next_episode_at из
//    /public/titles/{id}: дальше и раньше серия повторяется раз в неделю
//    в то же время, номер серии считаем от episodes_aired;
//  • дедлайны отчётов (/reports?sort=deadline) — дата без времени, строка
//    «Весь день» сверху;
//  • дни рождения из /overview — тоже «Весь день».

import { state } from "./state.js";
import { fetchReminders, openRemindersSheet } from "./reminders.js";
import { apiGet, dialogSkeletonHtml, mediaUrl } from "./api.js";
import { $, esc, STATUS_COLOR_VAR } from "./utils.js";
import { openReportDetail } from "./report-detail.js";
import { switchTab } from "./tabs.js";
import { openBirthdaysSheet } from "./birthdays.js";

const HOUR_PX = 52;
const DAY_MS = 86400000;
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
// Цвета блоков серий: тайтл получает один и тот же оттенок всю неделю.
const TITLE_HUES = ["#3b5bdb", "#9c36b5", "#c2255c", "#e8590c", "#2b8a3e", "#1098ad", "#5f3dc4", "#d9480f"];

const FILTER_KEY = () => `project_calendar_filters_${state.telegramId || "anon"}`;
const LAYERS = { episodes: "Серии", deadlines: "Дедлайны", birthdays: "Дни рождения", reminders: "Мои напоминания" };

let weekStart = startOfWeek(new Date());
let nowTimer = null;
let requestSeq = 0;

function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7; // Пн = 0
  x.setDate(x.getDate() - wd);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function sameDay(a, b) { return ymd(a) === ymd(b); }
function hhmm(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function hueFor(id) { return TITLE_HUES[Math.abs(Number(id) || 0) % TITLE_HUES.length]; }

function getFilters() {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY()) || "null");
    if (v && typeof v === "object") return { episodes: v.episodes !== false, deadlines: v.deadlines !== false, birthdays: v.birthdays !== false, reminders: v.reminders !== false };
  } catch (_) { /* по умолчанию всё включено */ }
  return { episodes: true, deadlines: true, birthdays: true, reminders: true };
}
function setFilters(f) {
  try { localStorage.setItem(FILTER_KEY(), JSON.stringify(f)); } catch (_) { /* не критично */ }
}

// ---------- данные ----------

async function fetchAirings() {
  let seasons;
  try { seasons = (await apiGet("/public/seasons")).seasons || []; } catch (_) { return []; }
  if (!seasons.length) return [];
  // Эфир-сезоны отсортированы сервером от свежего к старому — онгоинги
  // живут в первом, реже во втором (длинные двухкуровые сериалы).
  const titles = [];
  for (const s of seasons.slice(0, 2)) {
    try { titles.push(...((await apiGet(`/public/seasons/${s.id}/titles`)).titles || [])); } catch (_) { /* пропускаем сезон */ }
  }
  const out = [];
  const queue = titles.slice();
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const d = await apiGet(`/public/titles/${t.id}`);
        const det = d.details && !Array.isArray(d.details) ? d.details : null;
        if (det && det.next_episode_at) out.push({ title: t, det });
      } catch (_) { /* без расписания */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return out;
}

async function fetchDeadlines(from, to) {
  const out = [];
  for (let page = 0; page < 5; page++) {
    let r;
    try { r = await apiGet("/reports", { sort: "deadline", page, page_size: 100 }); } catch (_) { break; }
    const list = r.reports || [];
    for (const rep of list) {
      if (rep.deadline && rep.deadline >= from && rep.deadline <= to) out.push(rep);
    }
    const last = list[list.length - 1];
    if (list.length < 100 || !last || !last.deadline || last.deadline > to) break;
  }
  return out;
}

// Полный список (/birthdays); на старом сервере без него — 5 ближайших
// из /overview.
async function fetchBirthdays() {
  try { return (await apiGet("/birthdays")).birthdays || []; } catch (_) { /* старый сервер */ }
  try { return (await apiGet("/overview")).birthdays || []; } catch (_) { return []; }
}

// Серии недели: next_episode_at ± k недель, пока номер серии в пределах
// 1..episodes_total.
function airingsForWeek(airings, start) {
  const end = addDays(start, 7);
  const events = [];
  for (const { title, det } of airings) {
    const next = new Date(det.next_episode_at);
    if (Number.isNaN(next.getTime())) continue;
    const nextNum = (det.next_episode ?? ((det.episodes_aired || 0) + 1));
    const k0 = Math.floor((start - next) / (7 * DAY_MS));
    for (let k = k0; k <= k0 + 1; k++) {
      const at = new Date(next.getTime() + k * 7 * DAY_MS);
      if (at < start || at >= end) continue;
      const num = nextNum + k;
      if (num < 1 || (det.episodes_total && num > det.episodes_total)) continue;
      events.push({
        kind: "episode", at, id: title.id, name: title.name, poster: title.poster_url,
        num, total: det.episodes_total, minutes: det.duration_min || 24, color: hueFor(title.id),
      });
    }
  }
  return events;
}

// ---------- разметка ----------

function headerHtml(start) {
  const end = addDays(start, 6);
  const today = new Date();
  const range = start.getMonth() === end.getMonth()
    ? `${start.getDate()}–${end.getDate()} ${MONTHS_SHORT[end.getMonth()]} ${end.getFullYear()}`
    : `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTHS_SHORT[end.getMonth()]} ${end.getFullYear()}`;
  const f = getFilters();
  const monthName = start.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  return `
    <div class="page-header">
      <div>
        <h1>Календарь</h1>
        <div class="sub">Выход серий, дедлайны и дни рождения команды.</div>
      </div>
      <div class="page-header-actions cal-layers">
        ${Object.entries(LAYERS).map(([k, label]) => `<button type="button" class="qchip cal-layer cal-layer-${k}${f[k] ? " on" : ""}" data-cal-layer="${k}" aria-pressed="${f[k]}"><i></i>${label}</button>`).join("")}
      </div>
    </div>
    <div class="cal-card">
      <div class="cal-toolbar">
        <div class="cal-datechip"><span>${MONTHS_SHORT[today.getMonth()].toUpperCase()}</span><b>${today.getDate()}</b></div>
        <div class="cal-title">
          <b>${esc(monthName.charAt(0).toUpperCase() + monthName.slice(1))}</b>
          <span>${esc(range)}</span>
        </div>
        <div class="cal-nav">
          <button type="button" class="icon-btn" data-cal-nav="-1" title="Прошлая неделя" aria-label="Прошлая неделя"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
          <button type="button" class="btn" data-cal-nav="0">Сегодня</button>
          <button type="button" class="icon-btn" data-cal-nav="1" title="Следующая неделя" aria-label="Следующая неделя"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
        </div>
      </div>
      <div class="cal-body" id="cal-body">${dialogSkeletonHtml(3)}</div>
    </div>`;
}

function gridHtml(start, data) {
  const f = getFilters();
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const episodes = f.episodes ? airingsForWeek(data.airings, start) : [];
  const allDay = days.map(() => []);
  if (f.deadlines) {
    for (const r of data.deadlines) {
      const i = days.findIndex(d => ymd(d) === r.deadline);
      if (i >= 0) allDay[i].push({ kind: "deadline", r });
    }
  }
  if (f.reminders) {
    for (const r of data.reminders || []) {
      const i = days.findIndex(d => ymd(d) === r.date);
      if (i >= 0) allDay[i].push({ kind: "reminder", r });
    }
  }
  if (f.birthdays) {
    for (const b of data.birthdays) {
      const i = days.findIndex(d => d.getMonth() + 1 === b.month && d.getDate() === b.day);
      if (i >= 0) allDay[i].push({ kind: "birthday", b });
    }
  }
  const hasAllDay = allDay.some(x => x.length);

  const head = days.map((d, i) => `
    <div class="cal-dayhead${sameDay(d, today) ? " today" : ""}${i >= 5 ? " weekend" : ""}">
      <span>${WEEKDAYS[i]}</span><b>${d.getDate()}</b>
    </div>`).join("");

  const allDayRow = hasAllDay ? `
    <div class="cal-allday">
      <div class="cal-gutter-lbl">Весь день</div>
      ${allDay.map(items => `<div class="cal-allday-cell">${items.map(it => it.kind === "reminder"
        ? `<div class="cal-chip cal-chip-rem" role="button" tabindex="0" data-cal-rem title="${esc(it.r.text)}"><svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/></svg><span>${esc(it.r.text)}</span></div>`
        : it.kind === "deadline"
        ? `<button type="button" class="cal-chip cal-chip-deadline" data-cal-report="${esc(it.r.public_id)}" style="--c: var(${STATUS_COLOR_VAR[it.r.status] || "--s-draft"})" title="${esc(it.r.title)}"><i></i><span>${esc(it.r.title)}</span></button>`
        : `<div class="cal-chip cal-chip-bday" title="День рождения" role="button" tabindex="0" data-cal-bday><svg viewBox="0 0 24 24"><path d="M4 21h16M5 21v-7h14v7M12 14V9M9 5c0 1.7 1.3 3 3 3s3-1.3 3-3c0-1.2-3-3-3-3S9 3.8 9 5Z"/></svg><span>${esc(it.b.name)}</span></div>`).join("")}</div>`).join("")}
    </div>` : "";

  const hours = Array.from({ length: 24 }, (_, h) => `<div class="cal-hour"><span>${h ? `${String(h).padStart(2, "0")}:00` : ""}</span></div>`).join("");

  const cols = days.map((d, i) => {
    const evs = episodes.filter(e => sameDay(e.at, d)).sort((a, b) => a.at - b.at);
    // Пересекающиеся серии делят колонку по ширине.
    const lanes = [];
    const placed = evs.map(e => {
      const top = (e.at.getHours() + e.at.getMinutes() / 60) * HOUR_PX;
      const h = Math.max(54, (e.minutes / 60) * HOUR_PX);
      let lane = lanes.findIndex(endPx => endPx <= top);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = top + h;
      return { e, top, h, lane };
    });
    const width = 100 / Math.max(1, lanes.length);
    return `
      <div class="cal-col${sameDay(d, today) ? " today" : ""}${i >= 5 ? " weekend" : ""}">
        ${placed.map(({ e, top, h, lane }) => {
          const poster = e.poster ? mediaUrl("/img_proxy", { url: e.poster }) : "";
          const past = e.at.getTime() + e.minutes * 60000 < Date.now();
          return `
          <button type="button" class="cal-ev${past ? " past" : ""}" data-cal-title="${e.id}" style="--c:${e.color}; top:${top}px; height:${h}px; left:calc(${lane * width}% + 3px); width:calc(${width}% - 6px);" title="${esc(e.name)} — серия ${e.num}">
            ${poster && h >= 70 ? `<img src="${poster}" alt="" loading="lazy">` : ""}
            <b>${esc(e.name)}</b>
            <span>Серия ${e.num}${e.total ? ` из ${e.total}` : ""} · ${hhmm(e.at)}</span>
          </button>`;
        }).join("")}
      </div>`;
  }).join("");

  const empty = !episodes.length && !hasAllDay;
  return `
    <div class="cal-grid-head"><div class="cal-gutter"></div>${head}</div>
    ${allDayRow}
    <div class="cal-scroll" id="cal-scroll">
      <div class="cal-grid" style="--hour:${HOUR_PX}px">
        <div class="cal-hours">${hours}</div>
        <div class="cal-cols">${cols}<div class="cal-now" id="cal-now" hidden><span></span></div></div>
      </div>
    </div>
    ${empty ? `<div class="cal-empty">На этой неделе в календаре пусто${data.airings.length ? "" : " — у тайтлов сезона пока нет расписания серий"}.</div>` : ""}`;
}

function placeNowLine(root) {
  const line = root.querySelector("#cal-now");
  if (!line) return;
  const now = new Date();
  const i = Math.floor((startOfWeek(now) - weekStart) / DAY_MS) === 0 ? (now.getDay() + 6) % 7 : -1;
  if (i < 0) { line.hidden = true; return; }
  line.hidden = false;
  line.style.top = `${(now.getHours() + now.getMinutes() / 60) * HOUR_PX}px`;
  line.style.setProperty("--day", i);
  line.querySelector("span").textContent = hhmm(now);
}

let cache = null; // { airings, birthdays, deadlines, from, to }

async function renderWeek() {
  const root = $("#calendar-body");
  const body = root.querySelector("#cal-body");
  const seq = ++requestSeq;
  const from = ymd(weekStart);
  const to = ymd(addDays(weekStart, 6));
  if (!cache) {
    const [airings, birthdays, rem] = await Promise.all([fetchAirings(), fetchBirthdays(), fetchReminders()]);
    cache = { airings, birthdays, reminders: rem ? rem.reminders : [], deadlines: [], from: null, to: null };
  }
  if (cache.from !== from) {
    cache.deadlines = await fetchDeadlines(from, to);
    cache.from = from; cache.to = to;
  }
  if (seq !== requestSeq || !body.isConnected) return;
  body.innerHTML = gridHtml(weekStart, cache);
  body.querySelectorAll("[data-cal-report]").forEach(b => b.addEventListener("click", () => openReportDetail(b.dataset.calReport)));
  body.querySelectorAll("[data-cal-rem]").forEach(b => b.addEventListener("click", () => openRemindersSheet(() => { cache = null; renderWeek(); })));
  body.querySelectorAll("[data-cal-bday]").forEach(b => b.addEventListener("click", () => openBirthdaysSheet(() => { cache = null; renderWeek(); })));
  body.querySelectorAll("[data-cal-title]").forEach(b => b.addEventListener("click", () => {
    switchTab("titles");
  }));
  placeNowLine(body);
  // Открываем на самой ранней серии недели (японский эфир у нас — день
  // и вечер), без серий — на текущем часе.
  const scroll = body.querySelector("#cal-scroll");
  if (scroll) {
    const tops = [...body.querySelectorAll(".cal-ev")].map(el => parseFloat(el.style.top));
    const target = tops.length ? Math.min(...tops) : new Date().getHours() * HOUR_PX;
    scroll.scrollTop = Math.max(0, target - HOUR_PX);
  }
}

function renderShell() {
  const root = $("#calendar-body");
  root.innerHTML = headerHtml(weekStart);
  root.querySelectorAll("[data-cal-nav]").forEach(b => b.addEventListener("click", () => {
    const dir = Number(b.dataset.calNav);
    weekStart = dir === 0 ? startOfWeek(new Date()) : addDays(weekStart, dir * 7);
    renderShell();
  }));
  root.querySelectorAll("[data-cal-layer]").forEach(b => b.addEventListener("click", () => {
    const f = getFilters();
    f[b.dataset.calLayer] = !f[b.dataset.calLayer];
    setFilters(f);
    renderShell();
  }));
  return renderWeek();
}

export async function loadCalendar() {
  cache = null;
  window.clearInterval(nowTimer);
  nowTimer = window.setInterval(() => {
    const body = document.querySelector("#cal-body");
    if (!body || !body.isConnected) { window.clearInterval(nowTimer); return; }
    placeNowLine(body);
  }, 60000);
  try {
    await renderShell();
  } catch (e) {
    const body = document.querySelector("#cal-body");
    if (body) body.innerHTML = `<div class="bento-empty">Не удалось загрузить календарь: ${esc(e.message)}</div>`;
    return false;
  }
}
