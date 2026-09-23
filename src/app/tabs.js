// Переключение вкладок + первичная/повторная загрузка данных активной.

import { state } from "./state.js";
import { apiGet, toast } from "./api.js";
import { $, $all, esc, STATUS_COLOR_VAR } from "./utils.js";
import { loadOverview } from "./Overview.jsx";
import { loadReports } from "./reports.js";
import { loadBoard } from "./board.js";
import { loadTitlesTab } from "./titles.js";
import { loadFeed } from "./feed.js";
import { loadProfile } from "./profile.js";
import { loadAnalytics } from "./analytics.js";
import { loadServices } from "./services.js";
import { loadTeam } from "./team.js";
import { clearDirectoryCache } from "./titles-admin.js";

// Загрузчики возвращают false, если данные взять не удалось (сеть/сервер)
// — см. loadActiveTab ниже.
const LOADERS = {
  overview: loadOverview,
  list: loadReports,
  board: loadBoard,
  titles: loadTitlesTab,
  feed: loadFeed,
  analytics: loadAnalytics,
  services: loadServices,
  team: loadTeam,
  profile: loadProfile,
};

// Контейнеры вкладок — чистятся при выходе из аккаунта, чтобы данные
// предыдущего пользователя не остались висеть в DOM.
const TAB_BODIES = ["#overview-body", "#board-body", "#titles-body", "#feed-body", "#analytics-body", "#services-body", "#team-body", "#profile-body", "#reports-body"];

// Последняя открытая вкладка переживает не только смену пользователя
// (см. комментарий у state.activeTab в state.js — это настройка
// интерфейса, а не сессии), но и полный перезапуск приложения: студия
// целыми днями держит одну и ту же вкладку (обычно «Доску»), и
// открывать заново «Обзор» после каждого закрытия окна — лишний клик,
// который набегает десятки раз в день.
const LAST_TAB_KEY = "phoenix-last-tab";

export function switchTab(name) {
  state.activeTab = name;
  try { localStorage.setItem(LAST_TAB_KEY, name); } catch (_) { /* не критично */ }
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $all(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === name));
  // force=true — каждый клик по вкладке идёт за свежими данными, а не
  // отдаёт то, что было загружено в прошлый раз (раньше loadedTabs
  // молча глушил повторную загрузку, и приходилось жать «Обновить»
  // руками, чтобы, например, «Обзор» показал только что изменённый
  // статус отчёта). Цена — один лишний запрос на каждый клик по уже
  // открытой вкладке, для дашборд-вкладок студии (Обзор/Доска/Тайтлы/
  // Аналитика/Сервисы/Команда) это то, чего и просили: не кэш, а
  // текущее состояние.
  loadActiveTab(true).catch(e => toast(`Не удалось открыть вкладку: ${e.message}`, "error"));
}
$all(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

// Возвращает промис самой загрузки (раньше не возвращала — refreshAll
// ниже отпускал кнопку «Обновить» сразу после ВЫЗОВА loadOverview()/
// loadReports() и т.п., а не после того, как они реально отработали,
// поэтому кнопка выглядела снятой с паузы за секунды до того, как
// данные на самом деле пришли).
//
// Вкладка помечается загруженной только после УСПЕШНОЙ загрузки:
// раньше пометка ставилась до запроса, и вкладка, единожды упавшая по
// сети, навсегда оставалась с текстом «Не удалось загрузить» — при
// возврате на неё повторного запроса уже не было.
export async function loadActiveTab(force) {
  const name = state.activeTab;
  if (!force && state.loadedTabs.has(name)) return;
  const loader = LOADERS[name];
  if (!loader) return;
  const ok = await loader();
  if (ok !== false) state.loadedTabs.add(name);
  else state.loadedTabs.delete(name);
}

// Вызывается один раз при старте, до первой загрузки данных — иначе
// пришлось бы дважды бить по сети (сначала «Обзор» по умолчанию из
// разметки, потом настоящая последняя вкладка). Просто переключает DOM
// и state.activeTab, саму загрузку данных всё ещё делает
// loadActiveTab()/refreshAll() ниже по цепочке вызовов в auth.js.
export function restoreLastTab() {
  let saved = null;
  try { saved = localStorage.getItem(LAST_TAB_KEY); } catch (_) { /* не критично */ }
  if (!saved || !LOADERS[saved]) return;
  state.activeTab = saved;
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === saved));
  $all(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === saved));
}

export function clearTabDom() {
  for (const sel of TAB_BODIES) {
    const el = $(sel);
    if (el) el.innerHTML = "";
  }
  const bulk = $("#bulk-bar");
  if (bulk) bulk.hidden = true;
  const statusbar = $("#statusbar");
  if (statusbar) statusbar.textContent = "";
  // Фильтры списка и сохранённые пресеты — личные: следующий вошедший на
  // общей машине не должен начинать с выборки предыдущего.
  for (const sel of ["#search-input", "#status-filter", "#priority-filter", "#assignee-filter", "#season-filter", "#title-filter"]) {
    const el = $(sel);
    if (el) el.value = "";
  }
  const presets = $("#preset-chips");
  if (presets) presets.innerHTML = "";
  const more = $("#list-more");
  if (more) more.hidden = true;
}

let refreshInFlight = false;

export async function refreshAll() {
  // Защита от повторных нажатий — раньше вторая (нетерпеливая) кнопка
  // во время ещё идущей загрузки просто запускала ещё один параллельный
  // раунд запросов, и субъективно "подвисание" только усиливалось:
  // сеть и так медленная, а тут догоняющий запрос той же вкладки.
  if (refreshInFlight) return;
  refreshInFlight = true;
  const btn = $("#refresh-btn");
  const label = btn.querySelector(".btn-lbl") || btn;
  btn.disabled = true;
  const originalText = label.textContent;
  label.textContent = "Обновляю…";
  try {
    clearDirectoryCache();
    await loadUsers();
    await loadActiveTab(true);
  } finally {
    refreshInFlight = false;
    btn.disabled = false;
    label.textContent = originalText;
  }
}

export async function loadUsers() {
  try {
    const r = await apiGet("/assignable-users");
    state.users = r.users || [];
  } catch (_) { /* не критично для списка */ }
}

$("#refresh-btn").addEventListener("click", refreshAll);

// Вложенные пункты под «Доской» в сайдбаре — статусы с точкой-цветом и
// числом справа. Перенесено вживую с референса пользователя (Dribbble:
// Xentra Digital Marketing Dashboard, dribbble.com/shots/27265906) —
// там под «Projects» раскрыт список статусов с их количеством, тем же
// приёмом, что уже красит колонки самой доски (STATUS_COLOR_VAR). Число
// берём из /overview (то же, что уже питает донат-чарт «Структура
// загрузки») — отдельным, независимым от активной вкладки запросом
// при входе, тем же способом, что pingPresence()/loadTitlebarTeam()
// в auth.js: сайдбар виден всегда, не только когда открыт «Обзор».
export async function loadSidebarStatusCounts() {
  const el = $("#sidebar-board-sub");
  if (!el) return;
  try {
    const d = await apiGet("/overview");
    const statuses = (d.reports && d.reports.statuses) || [];
    if (!statuses.length) { el.hidden = true; return; }
    el.innerHTML = statuses.map(s => `
      <div class="sidebar-sub-item" data-goto-status="${esc(s.status)}">
        <span class="dot" style="background:var(${STATUS_COLOR_VAR[s.status] || "--s-draft"})"></span>
        <span class="lbl">${esc(s.label)}</span>
        <span class="cnt">${s.count}</span>
      </div>
    `).join("");
    el.hidden = false;
    el.querySelectorAll("[data-goto-status]").forEach(row => {
      row.addEventListener("click", () => switchTab("board"));
    });
  } catch (_) { /* не критично — сайдбар просто останется без раскладки по статусам */ }
}
