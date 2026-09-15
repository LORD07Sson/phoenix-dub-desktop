// Мелкие чистые хелперы без состояния — используются почти всеми модулями.

export function $(sel) { return document.querySelector(sel); }
export function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  const a = parts[0] ? parts[0][0] : "";
  const b = parts[1] ? parts[1][0] : "";
  return (a + b).toUpperCase() || "?";
}

export function isOverdue(r) {
  if (!r.deadline || r.status === "completed" || r.status === "cancelled") return false;
  return r.deadline < new Date().toISOString().slice(0, 10);
}

export function pluralColleagues(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "коллега";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "коллеги";
  return "коллег";
}

// Относительное время ("5 мин назад") — используется в ленте и (в будущем)
// где угодно ещё, где приходит серверная дата вида "YYYY-MM-DD HH:MM:SS".
export function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + (iso.indexOf("Z") === -1 && iso.indexOf("+") === -1 ? "Z" : ""));
  if (isNaN(d.getTime())) return iso;
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч назад`;
  const diffD = Math.round(diffH / 24);
  return `${diffD} дн назад`;
}

export function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Заметка с тайм-кодом — «[4:12] шум на вдохе». Отдельного поля под время
// в API заметок нет (см. docs/API.md), поэтому оно живёт префиксом в самом
// тексте: боту и мини-аппу это просто первые символы строки, ничего не
// ломается, а десктоп вытаскивает время регуляркой и показывает меткой.
const NOTE_TIME_RE = /^\[(\d{1,3}):([0-5]\d)(?::([0-5]\d))?\]\s*/;

export function parseNoteTime(text) {
  const m = NOTE_TIME_RE.exec(String(text || ""));
  if (!m) return null;
  const [, a, b, c] = m;
  const seconds = c ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
  return { seconds, label: c ? `${a}:${b}:${c}` : `${a}:${b}`, rest: String(text).slice(m[0].length) };
}

// То же самое в обратную сторону — для кнопки «находки QC в заметки».
export function noteTimePrefix(seconds) {
  return `[${formatTime(seconds)}] `;
}

// Строка из поля ввода: «4:12», «04:12», «1:02:03». Пусто — время не
// указано (обычная заметка), мусор — null, и вызывающий ругается.
export function secondsFromTimeInput(value) {
  const v = String(value || "").trim();
  if (!v) return 0;
  const m = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(v);
  if (!m) return null;
  const [, a, b, c] = m;
  return c ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
}

export function formatRange(start, end) {
  const dur = end - start;
  if (dur < 1) return `${formatTime(start)} (~${Math.round(dur * 1000)} мс)`;
  return `${formatTime(start)}–${formatTime(end)}`;
}

export const MONTHS_RU = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export const STATUS_DOT_CLASS = {
  draft: "draft", working: "work", review: "review",
  revision: "fix", completed: "done", cancelled: "stop",
};

export const PRIORITY_LABELS = { low: "Низкий", normal: "Обычный", high: "Высокий", urgent: "Срочный" };

export const STATUS_COLOR_VAR = {
  draft: "--s-draft", working: "--s-work", review: "--s-review",
  revision: "--s-fix", completed: "--s-done", cancelled: "--s-stop",
};

export const BADGE_RARITY_ORDER = { legendary: 0, epic: 1, rare: 2, common: 3, custom: 0 };

// Нативное контекстное меню по правому клику — не привязано к одной
// вкладке, чтобы можно было переиспользовать где угодно (сейчас —
// строки «Команда» в profile.js). Одно меню в DOM на всё приложение,
// закрывается по клику вовне/Escape/скроллу — обычное поведение любого
// контекстного меню в десктопном приложении.
let menuEl = null;
function closeContextMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  document.removeEventListener("click", closeContextMenu);
  document.removeEventListener("contextmenu", closeOnNextContextMenu, true);
  window.removeEventListener("blur", closeContextMenu);
  window.removeEventListener("scroll", closeContextMenu, true);
  document.removeEventListener("keydown", onMenuKeydown);
}
function onMenuKeydown(e) { if (e.key === "Escape") closeContextMenu(); }
// Правый клик по другому месту, пока меню открыто, должен закрыть его,
// а не оставить старое висящим поверх нового контента.
function closeOnNextContextMenu() { closeContextMenu(); }

// items: [{ label, danger?, action() }]
export function showContextMenu(x, y, items) {
  closeContextMenu();
  menuEl = document.createElement("div");
  menuEl.className = "context-menu";
  menuEl.innerHTML = items.map((it, i) =>
    `<button class="context-menu-item${it.danger ? " danger" : ""}" data-i="${i}">${esc(it.label)}</button>`
  ).join("");
  document.body.appendChild(menuEl);

  const rect = menuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menuEl.style.left = `${Math.max(8, left)}px`;
  menuEl.style.top = `${Math.max(8, top)}px`;

  menuEl.querySelectorAll(".context-menu-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const item = items[Number(btn.dataset.i)];
      closeContextMenu();
      if (item && item.action) item.action();
    });
  });
  setTimeout(() => {
    document.addEventListener("click", closeContextMenu);
    document.addEventListener("contextmenu", closeOnNextContextMenu, true);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("scroll", closeContextMenu, true);
    document.addEventListener("keydown", onMenuKeydown);
  }, 0);
}
