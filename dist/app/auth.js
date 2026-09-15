// Экран входа по коду из бота + экран загрузки при старте (splash).

import { invoke } from "./tauri.js";
import { state } from "./state.js";
import { api } from "./api.js";
import { $ } from "./utils.js";
import { refreshAll } from "./tabs.js";

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

export async function tryRestoreSession() {
  const token = await invoke("token_load");
  if (!token) { hideSplash(); return showAuth(); }
  state.token = token;
  try {
    const who = await api("GET", "/whoami");
    state.telegramId = who.telegram_id;
    showApp();
    hideSplash();
    await refreshAll();
  } catch (e) {
    // токен отозван/протух — просим войти заново, а не молча виснем.
    await invoke("token_clear").catch(() => {});
    hideSplash();
    showAuth(`Сессия истекла: ${e.message}`);
  }
}

export function showAuth(err) {
  $("#auth-screen").hidden = false;
  $("#app-screen").hidden = true;
  if (err) $("#auth-error").textContent = err;
  $("#code-input").focus();
}

export function showApp() {
  $("#auth-screen").hidden = true;
  $("#app-screen").hidden = false;
  $("#whoami").textContent = state.name ? `— ${state.name}` : "";
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
    state.token = result.token;
    state.telegramId = result.telegram_id;
    state.name = result.name;
    await invoke("token_save", { token: result.token });
    showApp();
    await refreshAll();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
$("#submit-code").addEventListener("click", submitCode);
$("#code-input").addEventListener("keydown", e => { if (e.key === "Enter") submitCode(); });

$("#logout-btn").addEventListener("click", async () => {
  await invoke("token_clear").catch(() => {});
  state.token = null;
  state.selected.clear();
  $("#code-input").value = "";
  showAuth();
});
