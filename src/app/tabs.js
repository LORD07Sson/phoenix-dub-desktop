// Переключение вкладок + первичная/повторная загрузка данных активной.

import { state } from "./state.js";
import { apiGet, toast } from "./api.js";
import { $, $all } from "./utils.js";
import { loadOverview } from "./Overview.jsx";
import { loadReports } from "./reports.js";
import { loadBoard } from "./board.js";
import { loadTitlesTab } from "./titles.js";
import { loadFeed } from "./feed.js";
import { loadProfile } from "./profile.js";
import { clearDirectoryCache } from "./titles-admin.js";

// Загрузчики возвращают false, если данные взять не удалось (сеть/сервер)
// — см. loadActiveTab ниже.
const LOADERS = {
  overview: loadOverview,
  list: loadReports,
  board: loadBoard,
  titles: loadTitlesTab,
  feed: loadFeed,
  profile: loadProfile,
};

// Контейнеры вкладок — чистятся при выходе из аккаунта, чтобы данные
// предыдущего пользователя не остались висеть в DOM.
const TAB_BODIES = ["#overview-body", "#board-body", "#titles-body", "#feed-body", "#profile-body", "#reports-body"];

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
  // Переключение вкладки — не await: ловим падение сами, чтобы
  // неожиданная ошибка рендера не уходила в консоль необработанным
  // reject'ом.
  loadActiveTab().catch(e => toast(`Не удалось открыть вкладку: ${e.message}`, "error"));
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
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "⏳ Обновляю…";
  try {
    clearDirectoryCache();
    await loadUsers();
    await loadActiveTab(true);
  } finally {
    refreshInFlight = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

export async function loadUsers() {
  try {
    const r = await apiGet("/assignable-users");
    state.users = r.users || [];
  } catch (_) { /* не критично для списка */ }
}

$("#refresh-btn").addEventListener("click", refreshAll);
