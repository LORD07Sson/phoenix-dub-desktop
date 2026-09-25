// Избранные отчёты — чисто локальная фишка десктопа, серверу о ней
// ничего не известно (нет такого поля в API, см. docs/API.md). Звёздочка
// в списке отмечает отчёты, за которыми хочется следить отдельно от
// фильтров/статусов — например, свои текущие серии вперемешку с чужими,
// за которыми присматриваешь. Хранится в localStorage на пользователя
// (машина в студии общая, см. тот же приём в feed-badge.js), переживает
// перезапуск приложения, но не путешествует между устройствами.

import { state } from "./state.js";

function storageKey() {
  return `project_favorites_${state.telegramId || "anon"}`;
}

function readSet() {
  try {
    const raw = localStorage.getItem(storageKey());
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (_) {
    return new Set();
  }
}

function writeSet(set) {
  try { localStorage.setItem(storageKey(), JSON.stringify([...set])); } catch (_) { /* приватный режим — просто не запомнится */ }
}

export function isFavorite(publicId) {
  return readSet().has(publicId);
}

export function toggleFavorite(publicId) {
  const set = readSet();
  const on = !set.has(publicId);
  if (on) set.add(publicId); else set.delete(publicId);
  writeSet(set);
  return on;
}

export function favoritesCount() {
  return readSet().size;
}

export function favoriteIds() {
  return readSet();
}
