// Недавно открытые отчёты — MRU-список для командной палитры (тот же
// приём, что "Recent Files" в VS Code/Raycast): открыв карточку через
// поиск в палитре один раз, во второй заход не нужно снова набирать
// номер — она уже наверху списка с пустым запросом. Чисто локальная
// история просмотра, серверу такое знать незачем.

import { state } from "./state.js";

const MAX_RECENT = 8;

function storageKey() {
  return `phoenix_recent_reports_${state.telegramId || "anon"}`;
}

function readList() {
  try {
    const raw = localStorage.getItem(storageKey());
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function writeList(list) {
  try { localStorage.setItem(storageKey(), JSON.stringify(list.slice(0, MAX_RECENT))); } catch (_) { /* не критично */ }
}

// Вызывается из report-detail.js при каждом успешном открытии карточки —
// последний открытый уходит в начало, дубликаты убираются, а не копятся.
export function recordRecentReport(publicId, title) {
  if (!publicId) return;
  const list = readList().filter(x => x.publicId !== publicId);
  list.unshift({ publicId, title: title || "" });
  writeList(list);
}

export function recentReports() {
  return readList();
}
