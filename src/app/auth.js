// Экран входа по коду из бота + экран загрузки при старте (splash).

import { invoke } from "./tauri.js";
import oopsFallGif from "../assets/oops-fall.gif";
import oopsFrierenGif from "../assets/friren.gif";
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

// Искры над «DUB» — случайные позиция, размер, скорость и снос, чтобы
// не шли строем. Создаются один раз, дальше крутятся на CSS.
function spawnEmbers() {
  const host = document.querySelector(".aw-embers");
  if (!host || host.childElementCount) return;
  for (let i = 0; i < 22; i++) {
    const b = document.createElement("b");
    b.style.setProperty("--x", `${Math.round(Math.random() * 100)}%`);
    b.style.setProperty("--s", `${(3 + Math.random() * 5).toFixed(1)}px`);
    b.style.setProperty("--d", `${(1.8 + Math.random() * 2).toFixed(2)}s`);
    b.style.setProperty("--w", `${(0.9 + Math.random() * 2.6).toFixed(2)}s`);
    b.style.setProperty("--dx", `${Math.round(Math.random() * 40 - 20)}px`);
    host.appendChild(b);
  }
}

// Надпись влетает заново при каждом показе экрана входа (после выхода
// тоже), а не только при первой загрузке окна.
function replayWordmark() {
  const word = document.querySelector(".auth-word");
  if (!word) return;
  word.querySelectorAll(".aw-part i").forEach(i => { i.style.animation = "none"; void i.offsetWidth; i.style.animation = ""; });
}

export function showAuth(err) {
  spawnEmbers();
  replayWordmark();
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
    showOops(e.message);
  } finally {
    btn.disabled = false;
  }
}

// Окошко «упала» над карточкой, когда код не подошёл или истёк: сверху
// падает персонаж с текстом ошибки, при новом вводе — уезжает. Картинок
// может быть несколько — берётся случайная.
const OOPS_MASCOTS = [
  {
    src: oopsFrierenGif,
    title: "Упс, Фрирен крутится и мутится",
    text: "…а код не подошёл, и это печально. Для эльфа тысяча лет — миг, а для кода и пара минут — вечность. Отправьте боту /desktop ещё раз.",
  },
  {
    src: oopsFallGif,
    title: "Упс, Бочи упала и не встаёт",
    text: "Код истёк быстрее, чем её социальная батарейка. Отправьте боту /desktop — она попробует подняться. Наверное.",
  },
];
let oopsTimer = null;
let oopsLeaveTimer = null;

function showOops(message) {
  const box = $("#auth-oops");
  if (!box) return;
  const expired = /истек|устар|expired|не найден|неверн|invalid|401/i.test(message || "");
  const mascot = OOPS_MASCOTS[Math.floor(Math.random() * OOPS_MASCOTS.length)];
  // Код не подошёл — шутит персонаж; другая ошибка (нет связи и т.п.) —
  // тот же персонаж, но с настоящим текстом ошибки, чтобы было понятно,
  // что делать.
  $("#auth-oops-title").textContent = expired ? mascot.title : "Упс, что-то пошло не так";
  $("#auth-oops-text").textContent = expired ? mascot.text : (message || "Попробуйте ещё раз.");
  $("#auth-oops-img").src = mascot.src;
  // Отменяем отложенное скрытие прошлого окошка — иначе при быстром
  // «стёр → ввёл новый неверный код» оно прятало уже новое.
  window.clearTimeout(oopsLeaveTimer);
  box.hidden = false;
  box.classList.remove("leave", "drop");
  void box.offsetWidth;
  box.classList.add("drop");
  window.clearTimeout(oopsTimer);
  oopsTimer = window.setTimeout(hideOops, 9000);
}

function hideOops() {
  const box = $("#auth-oops");
  if (!box || box.hidden || box.classList.contains("leave")) return;
  window.clearTimeout(oopsTimer);
  box.classList.add("leave");
  oopsLeaveTimer = window.setTimeout(() => { box.hidden = true; box.classList.remove("leave", "drop"); }, 320);
}
$("#submit-code").addEventListener("click", submitCode);
$("#code-input").addEventListener("keydown", e => { if (e.key === "Enter") submitCode(); });

// Шесть ячеек — только картинка поверх одного настоящего поля ввода:
// вставка из буфера, автозаполнение и ввод работают как обычно, а
// ячейки просто показывают цифры. Шестая цифра — сразу вход.
const CODE_LEN = 6;

function renderCodeCells() {
  const input = $("#code-input");
  // Только цифры и не больше шести: раньше поле брало до 8 символов, и
  // лишние цифры сидели невидимо за последней ячейкой — Backspace стирал
  // сначала их, а на экране ничего не менялось.
  const digits = input.value.replace(/\D/g, "").slice(0, CODE_LEN);
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

// Поле невидимое, поэтому курсор в нём держим всегда в конце: иначе клик
// по ячейке ставил его в середину, и ввод/стирание шли не туда, куда
// смотрит человек.
function caretToEnd() {
  const input = $("#code-input");
  const n = input.value.length;
  if (input.selectionStart !== n || input.selectionEnd !== n) input.setSelectionRange(n, n);
}

function codeChanged() {
  $("#auth-error").textContent = "";
  hideOops();
  const digits = renderCodeCells();
  caretToEnd();
  if (digits.length === CODE_LEN && !$("#submit-code").disabled) submitCode();
}

$("#code-input").addEventListener("input", codeChanged);
$("#code-input").addEventListener("keydown", e => {
  const input = e.currentTarget;
  if (e.key === "Backspace" || e.key === "Delete") {
    // Всегда стираем последнюю видимую цифру (с Ctrl — все).
    e.preventDefault();
    input.value = e.ctrlKey ? "" : input.value.slice(0, -1);
    codeChanged();
  } else if (e.key === "Escape") {
    e.preventDefault();
    input.value = "";
    codeChanged();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
    e.preventDefault();
  }
});
["focus", "click", "mouseup", "select"].forEach(ev => $("#code-input").addEventListener(ev, () => { renderCodeCells(); caretToEnd(); }));
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
