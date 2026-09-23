// Экран входа по коду из бота + экран загрузки при старте (splash).

import { invoke } from "./tauri.js";
import { state, resetSessionState } from "./state.js";
import { api, apiGet, armSessionExpiry, ensureMediaToken } from "./api.js";
import { $ } from "./utils.js";
import { refreshAll, clearTabDom, restoreLastTab, loadSidebarStatusCounts } from "./tabs.js";
import { resetAssignmentsBaseline } from "./notifications.js";
import { resetFeedBadge } from "./feed-badge.js";
import { pingPresence } from "./presence.js";
import { loadTitlebarTeam } from "./profile.js";

// Экран загрузки при старте — тот же маскот/прогресс-бар, что и в
// мини-аппе (см. #splash в miniapp/static/index.html). Держим минимум
// 700мс, чтобы не мигать на мгновенном /whoami, и прячем сразу же,
// как только известно, куда вести — в приложение или на экран входа.
const SPLASH_MIN_MS = 700;
const splashShownAt = Date.now();
export function hideSplash() {
  const el = $("#app-splash");
  if (!el || el.dataset.hidden) return;
  el.dataset.hidden = "1";
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  // DevSkim: ignore DS172411 — оба таймера вызывают функции, не строки, данные не внешние
  setTimeout(() => {
    el.classList.add("hide");
    setTimeout(() => el.remove(), 400);
  }, wait);
}

// Имя в шапке. Отдельной функцией, потому что при восстановлении сессии
// оно приходит не сразу: /whoami отдаёт только {telegram_id, is_admin}
// (см. docs/API.md), имя есть лишь в ответе на вход по коду и в /me —
// раньше showApp() читал state.name, который после перезапуска всегда
// был null, и шапка молча оставалась пустой у всех, кроме только что
// вошедших.
export function setDisplayName(name) {
  state.name = name || null;
  const el = $("#whoami");
  if (el) el.textContent = state.name ? `— ${state.name}` : "";
}

// Один запрос /me на старте закрывает сразу двоих: имя для шапки и
// is_developer для переключателя в Настройках (иначе его дёргает сам
// диалог настроек при первом открытии).
async function hydrateIdentity() {
  try {
    const me = await apiGet("/me");
    setDisplayName(me.display_name || me.name);
    state.isDeveloper = !!me.is_developer;
  } catch (_) { /* не критично: шапка просто останется без имени */ }
}

export async function tryRestoreSession() {
  const token = await invoke("token_load");
  if (!token) { hideSplash(); return showAuth(); }
  state.token = token;
  try {
    const who = await api("GET", "/whoami");
    state.telegramId = who.telegram_id;
    await ensureMediaToken();
    showApp();
    restoreLastTab();
    hideSplash();
    hydrateIdentity();
    await refreshAll();
  } catch (e) {
    // токен отозван/протух — просим войти заново, а не молча виснем.
    await invoke("token_clear").catch(() => {});
    resetSessionState();
    hideSplash();
    showAuth(`Сессия истекла: ${e.message}`);
  }
}

export function showAuth(err) {
  $("#auth-screen").hidden = false;
  $("#app-screen").hidden = true;
  // Полоса заголовка теперь общая для всех экранов (окно без системных
  // decorations, см. window-chrome.js), поэтому кнопки приложения в ней
  // прячем отдельно — до входа «Обновить» и «Выйти» бессмысленны.
  $("#titlebar-apps").hidden = true;
  // Всегда перезаписываем, а не только при наличии err: иначе после
  // «Сессия истекла: …» и обычного выхода старое сообщение продолжало
  // висеть над формой входа.
  $("#auth-error").textContent = err || "";
  $("#code-input").focus();
}

export function showApp() {
  $("#auth-screen").hidden = true;
  $("#app-screen").hidden = false;
  $("#titlebar-apps").hidden = false;
  setDisplayName(state.name);
  // Первый пинг присутствия — сразу, а не через минуту: модуль
  // presence.js стартует при загрузке страницы, когда токена ещё нет,
  // и его первый заход всегда уходил впустую.
  pingPresence();
  loadTitlebarTeam();
  loadSidebarStatusCounts();
}

async function submitCode() {
  const code = $("#code-input").value.trim();
  const errEl = $("#auth-error");
  errEl.textContent = "";
  if (!/^\d{4,8}$/.test(code)) {
    errEl.textContent = "Введите код из сообщения бота.";
    return;
  }
  const btn = $("#submit-code");
  btn.disabled = true;
  try {
    const os = navigator.platform || "desktop";
    const result = await api("POST", "/desktop/pair", { code, label: `Desktop (${os})` });
    armSessionExpiry();
    state.token = result.token;
    state.telegramId = result.telegram_id;
    setDisplayName(result.name);
    await invoke("token_save", { token: result.token });
    await ensureMediaToken();
    showApp();
    restoreLastTab();
    await refreshAll();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
$("#submit-code").addEventListener("click", submitCode);
$("#code-input").addEventListener("keydown", e => { if (e.key === "Enter") submitCode(); });

// Шесть ячеек — только картинка поверх одного настоящего поля ввода:
// вставка из буфера, автозаполнение и ввод работают как обычно, а
// ячейки просто показывают цифры. Шестая цифра — сразу вход.
function renderCodeCells() {
  const input = $("#code-input");
  const digits = input.value.replace(/\D/g, "");
  if (digits !== input.value) input.value = digits;
  const cells = document.querySelectorAll(".code-cell");
  const focused = document.activeElement === input;
  cells.forEach((c, i) => {
    c.textContent = digits[i] || "";
    c.classList.toggle("filled", !!digits[i]);
    c.classList.toggle("active", focused && i === Math.min(digits.length, cells.length - 1));
  });
  return digits;
}
$("#code-input").addEventListener("input", () => {
  $("#auth-error").textContent = "";
  const digits = renderCodeCells();
  if (digits.length === 6 && !$("#submit-code").disabled) submitCode();
});
$("#code-input").addEventListener("focus", renderCodeCells);
$("#code-input").addEventListener("blur", renderCodeCells);
renderCodeCells();

// Полный выход: и состояние, и уже отрисованные данные на вкладках, и
// точки отсчёта фоновых опросов. Без сброса последних следующий
// вошедший на этой машине получал системное уведомление «вам назначено
// N новых отчётов» на весь свой список (diff считался относительно
// списка предыдущего пользователя).
function logout() {
  resetSessionState();
  resetAssignmentsBaseline();
  resetFeedBadge();
  clearTabDom();
  armSessionExpiry();
  $("#code-input").value = "";
  renderCodeCells();
  showAuth();
}

$("#logout-btn").addEventListener("click", async () => {
  await invoke("token_clear").catch(() => {});
  logout();
});

document.addEventListener("session-expired", async e => {
  // Мы уже на экране входа (например, 401 прилетел из самого
  // tryRestoreSession) — там сообщение покажут без нас.
  if ($("#app-screen").hidden) return;
  await invoke("token_clear").catch(() => {});
  logout();
  $("#auth-error").textContent = `Сессия истекла (${e.detail}) — войдите заново.`;
});
