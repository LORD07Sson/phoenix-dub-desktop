// Кнопки окна в своей полосе заголовка (свернуть / развернуть / закрыть).
//
// У окна выключены системные decorations (tauri.conf.json), потому что
// системный заголовок был ВТОРОЙ полосой над шапкой приложения: чужой
// серый прямоугольник поверх фирменного стекла и 32 потерянных пикселя
// высоты. Всё, что рисовала система, рисуем сами.
//
// Перетаскивание окна за полосу делает сам Tauri по атрибуту
// data-tauri-drag-region в index.html — своего кода на это не нужно.
// Изменение размера тянущей рамкой тоже остаётся системным: tao
// сохраняет у окна WS_THICKFRAME и без заголовка, поэтому и края, и
// Aero Snap (клавиша Win + стрелки, приклеивание к краю экрана)
// работают как у любого другого окна Windows.
//
// Чего своей полосой не получить — всплывающего меню Snap Layouts по
// наведению на кнопку «развернуть» (Windows 11): оно требует ответа
// HTMAXBUTTON на WM_NCHITTEST, то есть перехвата оконной процедуры на
// нативной стороне. Само приклеивание к краям при этом работает, так
// что потеря невелика.

import { appWindow } from "./tauri.js";
import { $ } from "./utils.js";

// Крестик у окна сворачивает в трей, а не выходит из приложения (см.
// main.rs: CloseRequested -> prevent_close + hide) — фоновый опрос
// новых назначений должен продолжать идти. Зовём тот же close(), что и
// системная кнопка, чтобы поведение осталось ровно прежним.
async function syncMaximizedClass() {
  let maximized = false;
  try { maximized = await appWindow.isMaximized(); } catch { /* окно закрывается */ }
  document.body.classList.toggle("window-maximized", maximized);
  const btn = $("#win-maximize");
  if (btn) {
    btn.title = maximized ? "Свернуть в окно" : "Развернуть";
    btn.setAttribute("aria-label", btn.title);
  }
}

export function installWindowChrome() {
  $("#win-minimize")?.addEventListener("click", () => appWindow.minimize());
  $("#win-maximize")?.addEventListener("click", async () => {
    await appWindow.toggleMaximize();
    syncMaximizedClass();
  });
  $("#win-close")?.addEventListener("click", () => appWindow.close());

  // Двойной клик по пустому месту полосы — развернуть/свернуть, как у
  // любого окна Windows. Именно по .titlebar/.titlebar-left, а не по
  // кнопкам внутри: двойной клик по «Обновить» не должен разворачивать
  // окно.
  $("#titlebar")?.addEventListener("dblclick", async e => {
    if (e.target.closest("button")) return;
    await appWindow.toggleMaximize();
    syncMaximizedClass();
  });

  // Окно могли развернуть мимо нашей кнопки — Aero Snap, двойной клик
  // по краю, Win+↑. Без подписки на resize иконка кнопки осталась бы
  // врать про текущее состояние.
  appWindow.onResized(syncMaximizedClass).catch(() => {});
  syncMaximizedClass();
}
