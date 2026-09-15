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
