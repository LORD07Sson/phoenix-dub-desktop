// HTTP-клиент к тому же REST API, что и мини-апп (см. docs/API.md), плюс
// тосты и универсальная обёртка для модалок (openSheet/dialogSkeletonHtml) —
// используются буквально всеми остальными модулями.

import { state } from "./state.js";
import { $ } from "./utils.js";

export const API_BASE = "https://minitg.shitstudent.com:8443/api";

// Без явного таймаута fetch() ждёт ответа сколько угодно — если сеть
// до сервера просто медленная/легла (не сразу видимая ошибка, а тихое
// зависание соединения), пользователь смотрит на неподвижный скелетон
// без единого сигнала, что что-то пошло не так, и это неотличимо от
// зависшего интерфейса. 20с — заметно больше обычного отклика (доли
// секунды — единицы секунд), но не бесконечность.
const REQUEST_TIMEOUT_MS = 20_000;

// Токен могли отозвать прямо во время работы (вышли с другого
// устройства, админ снял доступ). Раньше это выглядело как бесконечные
// «401» в тостах до перезапуска — разлогин был только на старте, в
// tryRestoreSession. Теперь любой 401/403 один раз поднимает событие,
// на которое auth.js отвечает возвратом на экран входа. Событие, а не
// прямой вызов из api.js — чтобы не заводить цикл импортов
// api -> auth -> api.
let sessionExpiredFired = false;
function notifySessionExpired(detail) {
  if (sessionExpiredFired || !state.token) return;
  sessionExpiredFired = true;
  document.dispatchEvent(new CustomEvent("session-expired", { detail }));
}
export function armSessionExpiry() { sessionExpiredFired = false; }

export async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["X-Init-Data"] = state.token;
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); // DevSkim: ignore DS172411 — функция, не строка
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Сервер не отвечает — проверьте соединение и попробуйте снова.");
    throw new Error(`Нет связи с сервером: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) {
    let detail = resp.status;
    try { detail = (await resp.json()).detail ?? detail; } catch (_) {}
    // /desktop/pair — единственный запрос без токена: там 401 значит
    // «неверный код», а не «сессия протухла», выкидывать со входа на
    // вход незачем.
    if ((resp.status === 401 || resp.status === 403) && path !== "/desktop/pair") {
      notifySessionExpired(String(detail));
    }
    throw new Error(String(detail));
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

export function apiGet(path, params) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)) : "";
  return api("GET", path + qs);
}
export function apiPost(path, body) { return api("POST", path, body || {}); }
export function apiDelete(path) { return api("DELETE", path); }

// Адрес картинки, которую отдаёт наш же API (аватар, баннер, постер
// через img_proxy). Заголовок X-Init-Data к <img src> не приделать,
// поэтому единственная точка, где auth уезжает в query, вынесена сюда.
//
// Раньше туда клали сам dsk_-токен (живёт месяцами) — он оседал в
// access-логах сервера при каждой картинке (см. SECURITY.md). Теперь
// вместо него — mediaToken: короткоживущий (см. _MEDIA_TOKEN_TTL на
// сервере, сейчас 5 минут) обменник, который ни на что, кроме этих
// трёх картиночных ручек, прав не даёт. mediaUrl() остаётся синхронной
// функцией (её вызывают десятки мест, собирая <img src="..."> строкой
// за один проход) — токен уже должен быть в state к этому моменту,
// см. ensureMediaToken() ниже и её вызов в auth.js сразу после
// state.token.
export function mediaUrl(path, params) {
  if (!state.mediaToken) return "";
  const qs = new URLSearchParams({ ...(params || {}), mtok: state.mediaToken });
  return `${API_BASE}${path}?${qs}`;
}

// Обновляет state.mediaToken заранее, до истечения — а не по факту 401
// от уже отрисованной картинки (её тогда пришлось бы перерисовывать).
// MEDIA_TOKEN_REFRESH_SLACK_MS — запас до истечения, с которым токен
// считается «пора обновить»: сервер даёт 5 минут, обновляем на
// четвёртой, чтобы не словить протухание прямо во время рендера длинного
// списка аватарок.
const MEDIA_TOKEN_REFRESH_SLACK_MS = 60_000;
let mediaTokenPromise = null;

export async function ensureMediaToken() {
  if (!state.token) return;
  if (state.mediaToken && Date.now() < state.mediaTokenExpiresAt - MEDIA_TOKEN_REFRESH_SLACK_MS) return;
  // Несколько мест могут дёрнуть ensureMediaToken() одновременно
  // (несколько картинок рендерятся разом) — один запрос на всех,
  // а не по одному на каждую.
  if (mediaTokenPromise) return mediaTokenPromise;
  mediaTokenPromise = (async () => {
    try {
      const res = await apiPost("/media/token", {});
      state.mediaToken = res.token;
      state.mediaTokenExpiresAt = Date.now() + res.expires_in * 1000;
    } catch (_) {
      // Сеть подвела — оставляем старый токен (если был) до следующей
      // попытки, картинки просто продолжат грузиться на нём же, пока он
      // не протухнет на сервере.
    } finally {
      mediaTokenPromise = null;
    }
  })();
  return mediaTokenPromise;
}

// Фоновое обновление — тот же приём, что presence.js (pingPresence):
// проверка раз в минуту, сам ensureMediaToken() решает, нужно ли
// реально сходить на сервер (нет токена/сессии — тихо выходит).
const MEDIA_TOKEN_CHECK_INTERVAL_MS = 60_000;
setInterval(ensureMediaToken, MEDIA_TOKEN_CHECK_INTERVAL_MS);

export function openSheet(html, variant) {
  const tpl = $(variant === "wide" ? "#tpl-overlay-wide" : "#tpl-overlay").content.cloneNode(true);
  const overlay = tpl.querySelector(".overlay");
  overlay.querySelector(".sheet").innerHTML = html;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) dismissSheet(overlay); });
  return overlay;
}

// Закрытие «снаружи» (клик по фону, Escape) — в отличие от прямого
// overlay.remove() шлёт самому оверлею событие "sheet-dismissed".
// Модалкам, которые отдают ответ промисом (диалог обновления), это
// нужно, чтобы не зависнуть в await навсегда, когда пользователь
// закрыл их клавишей, а не кнопкой.
export function dismissSheet(overlay) {
  if (!overlay || !overlay.isConnected) return;
  overlay.remove();
  overlay.dispatchEvent(new CustomEvent("sheet-dismissed"));
}

// Escape закрывает верхнюю модалку. Живёт здесь, рядом с openSheet, а
// не в reports.js (где раньше соседствовал с Ctrl+F поиска по списку) —
// к вкладке «Список» это поведение отношения не имеет.
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const overlays = document.querySelectorAll(".overlay");
  if (overlays.length) dismissSheet(overlays[overlays.length - 1]);
});

// Иконка на тосте — беглый взгляд должен отличить "готово" от "ошибка"
// раньше, чем глаза дойдут до текста (особенно на периферии зрения,
// пока смотришь на таблицу, а не на toast-root в углу). Раньше кроме
// цвета левой полоски у error других сигналов не было.
const TOAST_ICON = { info: "", error: "⚠️", success: "✓" };

// action — необязательная кликабельная кнопка внутри тоста, например
// «Показать в папке» после скачивания/экспорта файла: действие само по
// себе неважное настолько, чтобы держать под него отдельный диалог, но
// и незаметно потерять его после закрытия шторки не хочется.
export function toast(text, kind = "info", action = null) {
  const root = $("#toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.kind = kind;
  const duration = action ? 7000 : 4200;
  const icon = TOAST_ICON[kind] || "";
  el.innerHTML = `${icon ? `<span class="toast-icon">${icon}</span>` : ""}<span class="toast-text"></span>${action ? `<button type="button" class="toast-action"></button>` : ""}<span class="toast-progress" style="animation-duration:${duration}ms;"></span>`;
  el.querySelector(".toast-text").textContent = text;
  root.appendChild(el);
  const remove = () => {
    el.classList.add("toast-out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  const timer = setTimeout(remove, duration); // DevSkim: ignore DS172411 — вызов функции, не строки, данные не внешние
  if (action) {
    const actionBtn = el.querySelector(".toast-action");
    actionBtn.textContent = action.label;
    // stopPropagation — иначе клик по кнопке действия попадал бы и на
    // обработчик тоста целиком (закрытие по клику) одновременно с
    // самим действием.
    actionBtn.addEventListener("click", e => {
      e.stopPropagation();
      clearTimeout(timer);
      action.onClick();
      remove();
    });
  }
  el.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

// Скелетон-заглушка для модалок, пока грузятся реальные данные
// (карточка отчёта, QC-анализ) — вместо одного спиннера с текстом.
export function dialogSkeletonHtml(lines = 4) {
  const rows = Array.from({ length: lines }, (_, i) =>
    `<div class="skeleton-row" style="animation-delay:${i * 60}ms;"></div>`).join("");
  return `<div class="skeleton-wrap">${rows}</div>`;
}
