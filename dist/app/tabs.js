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

export function loadActiveTab(force) {
  const name = state.activeTab;
  if (!force && state.loadedTabs.has(name)) return;
  state.loadedTabs.add(name);
  if (name === "overview") loadOverview();
  else if (name === "list") loadReports();
  else if (name === "board") loadBoard();
  else if (name === "titles") loadTitlesTab();
  else if (name === "feed") loadFeed();
  else if (name === "profile") loadProfile();
}

export async function refreshAll() {
  await loadUsers();
  loadActiveTab(true);
}

export async function loadUsers() {
  try {
    const r = await apiGet("/assignable-users");
    state.users = r.users || [];
  } catch (_) { /* не критично для списка */ }
}

$("#refresh-btn").addEventListener("click", refreshAll);
