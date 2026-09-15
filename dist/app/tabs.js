// Переключение вкладок + первичная/повторная загрузка данных активной.

import { state } from "./state.js";
import { apiGet } from "./api.js";
import { $, $all } from "./utils.js";
import { loadOverview } from "./overview.js";
import { loadReports } from "./reports.js";
import { loadBoard } from "./board.js";
import { loadTitlesTab } from "./titles.js";
import { loadFeed } from "./feed.js";
import { loadProfile } from "./profile.js";

export function switchTab(name) {
  state.activeTab = name;
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $all(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === name));
  loadActiveTab();
}
$all(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

// Возвращает промис самой загрузки (раньше не возвращала — refreshAll
// ниже отпускал кнопку «Обновить» сразу после ВЫЗОВА loadOverview()/
// loadReports() и т.п., а не после того, как они реально отработали,
// поэтому кнопка выглядела снятой с паузы за секунды до того, как
// данные на самом деле пришли).
export function loadActiveTab(force) {
  const name = state.activeTab;
  if (!force && state.loadedTabs.has(name)) return Promise.resolve();
  state.loadedTabs.add(name);
  if (name === "overview") return loadOverview();
  if (name === "list") return loadReports();
  if (name === "board") return loadBoard();
  if (name === "titles") return loadTitlesTab();
  if (name === "feed") return loadFeed();
  if (name === "profile") return loadProfile();
  return Promise.resolve();
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
