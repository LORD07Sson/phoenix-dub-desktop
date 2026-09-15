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

export function openSheet(html, variant) {
  const tpl = $(variant === "wide" ? "#tpl-overlay-wide" : "#tpl-overlay").content.cloneNode(true);
  const overlay = tpl.querySelector(".overlay");
  overlay.querySelector(".sheet").innerHTML = html;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

export function toast(text, kind = "info") {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  if (kind === "error") el.style.borderLeftColor = "var(--s-stop)";
  const duration = 4200;
  el.innerHTML = `<span class="toast-text"></span><span class="toast-progress" style="animation-duration:${duration}ms;"></span>`;
  el.querySelector(".toast-text").textContent = text;
  root.appendChild(el);
  const remove = () => {
    el.classList.add("toast-out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  const timer = setTimeout(remove, duration); // DevSkim: ignore DS172411 — вызов функции, не строки, данные не внешние
  el.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

// Скелетон-заглушка для модалок, пока грузятся реальные данные
// (карточка отчёта, QC-анализ) — вместо одного спиннера с текстом.
export function dialogSkeletonHtml(lines = 4) {
  const rows = Array.from({ length: lines }, (_, i) =>
    `<div class="skeleton-row" style="animation-delay:${i * 60}ms;"></div>`).join("");
  return `<div class="skeleton-wrap">${rows}</div>`;
}
