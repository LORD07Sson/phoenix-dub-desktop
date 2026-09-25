// Студия переименована из PHOENIX в Project — вместе с ней сменился
// префикс ключей localStorage (тема, избранное, недавние, отметки
// «прочитано» и т.д.). Один раз переносим старые «phoenix…» в «project…»,
// чтобы после обновления у людей ничего не пропало. Импортируется первым
// в main.js и pin-window.js — раньше модулей, которые читают эти ключи.

const OLD = "phoenix", NEW = "project";

try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(OLD)) continue;
    const next = NEW + key.slice(OLD.length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch (_) { /* хранилище недоступно — переносить нечего */ }
