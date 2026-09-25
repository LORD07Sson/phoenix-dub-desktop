// Фокус-режим карточки отчёта — «zen mode», адаптированный под эту
// студию: пока открыта карточка одного отчёта (report-detail.js), можно
// спрятать шапку и боковую панель вкладок за самой карточкой, вместо
// обычной модалки поверх видимого (хоть и размытого) остального
// приложения. У этого экрана нет текста, который печатают (в отличие
// от zen mode в редакторах) — отвлекает именно контекст вокруг: лента,
// список, доска, видные сквозь блюр модалки.
//
// Работает только пока открыта ИМЕННО карточка отчёта (.report-detail-
// overlay, см. report-detail.js) — у остальных широких модалок
// (admin.js, profile.js, titles-admin.js — те же ".sheet-wide") прятать
// чужую шапку смысла нет, там сам диалог и есть вся суть экрана.

const PREF_KEY = "project-focus-mode-pref";

export function focusModePreferred() {
  try { return localStorage.getItem(PREF_KEY) === "1"; } catch (_) { return false; }
}
export function setFocusModePreferred(on) {
  try { localStorage.setItem(PREF_KEY, on ? "1" : "0"); } catch (_) {}
}

let active = false;
export function isFocusModeOn() { return active; }

// Кнопка живёт внутри .detail-head карточки и пересоздаётся на каждый
// render() (там вся innerHTML шторки переписывается разом) — поэтому
// состояние на неё накладывает не apply() сам по себе, а отдельный
// syncFocusButton(), который report-detail.js зовёт после каждого
// render() уже на новый DOM-узел.
function buttonLabel() { return active ? "Фокус: вкл" : "Фокус"; }
function buttonTitle() { return `${active ? "Выйти из фокус-режима" : "Фокус-режим"} (Ctrl+Shift+F)`; }

export function syncFocusButton(btn) {
  if (!btn) return;
  btn.textContent = buttonLabel();
  btn.title = buttonTitle();
  btn.classList.toggle("active", active);
}

function apply() {
  document.body.classList.toggle("focus-mode", active);
  document.querySelectorAll("[data-focus-toggle]").forEach(syncFocusButton);
}

export function enterFocusMode({ persist = true } = {}) {
  if (active) return;
  active = true;
  apply();
  if (persist) setFocusModePreferred(true);
}
export function exitFocusMode({ persist = true } = {}) {
  if (!active) return;
  active = false;
  apply();
  if (persist) setFocusModePreferred(false);
}
export function toggleFocusMode() {
  if (!document.querySelector(".report-detail-overlay")) return;
  if (active) exitFocusMode(); else enterFocusMode();
}

// Открытие карточки — включаем автоматически, если так стоит в
// настройке («всегда хочу фокус-режим при открытии отчёта», см.
// settings.js). persist:false — открытие само по себе не меняет
// сохранённую настройку, её меняет только явный тоггл кнопкой/хоткеем.
document.addEventListener("report-detail-opened", () => {
  if (focusModePreferred()) enterFocusMode({ persist: false });
});
// Закрытие карточки — выключаем режим (иначе шапка/сайдбар остались бы
// спрятаны и без самой карточки на экране), но опять же не трогаем
// сохранённую настройку — следующее открытие снова включит её сама.
document.addEventListener("report-detail-closed", () => {
  exitFocusMode({ persist: false });
});

// Ctrl/Cmd+Shift+F — не пересекается ни с чем из существующего набора
// (см. shortcuts-help.js): Ctrl+1..9 — вкладки, Ctrl+K — палитра,
// Ctrl+F — поиск в «Списке», Ctrl+Shift+P — показать/скрыть окно из
// трея (глобальный OS-хоткей, отдельный namespace, тут не конфликтует
// в принципе). Работает только пока открыта карточка отчёта — иначе
// молча ничего не делает, полю ввода "F" перехватывать незачем.
document.addEventListener("keydown", e => {
  // e.code — физическая клавиша, не зависит от раскладки (см. командную
  // палитру в command-palette.js: та же причина, что и там).
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.code !== "KeyF") return;
  if (!document.querySelector(".report-detail-overlay")) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
  toggleFocusMode();
});
