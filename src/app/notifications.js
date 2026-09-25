// Уведомления о новых назначениях — диф-опрос раз в минуту, сравниваем
// с прошлым срезом и шлём системный тост только на реально новые id.

import { notifyDesktop } from "./desktop-notify.js";
import { state } from "./state.js";
import { apiGet } from "./api.js";

let knownAssigned = null; // Set — null значит «ещё не было первого опроса»
const POLL_INTERVAL_MS = 60_000;

// Счётчик на вкладке «Я» — сколько назначенных на меня отчётов я ещё не
// видел в профиле (badge-me в мини-аппе). В отличие от системного тоста
// выше, переживает перезапуск: «видел» — это открыл вкладку «Я», а не
// «приложение было запущено, пока назначали».
function seenKey() { return `project_me_seen_reports_${state.telegramId || "anon"}`; }
function getSeen() {
  try {
    const raw = localStorage.getItem(seenKey());
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch (_) { return null; }
}
function setSeen(ids) {
  try { localStorage.setItem(seenKey(), JSON.stringify([...ids])); } catch (_) { /* не критично */ }
}

function renderMeBadge(count) {
  const btn = document.querySelector('.tab-btn[data-tab="profile"]');
  if (!btn) return;
  let badge = btn.querySelector(".tab-badge");
  if (!count) { if (badge) badge.remove(); btn.title = "Я"; return; }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    btn.appendChild(badge);
  }
  badge.textContent = count > 9 ? "9+" : String(count);
  btn.title = `Я — новых назначений: ${count}`;
}

// Вызывается из profile.js после загрузки своей вкладки «Я».
export function markMyReportsSeen(ids) {
  const all = new Set([...(getSeen() || []), ...(ids || []), ...(knownAssigned || [])]);
  setSeen(all);
  renderMeBadge(0);
}

function updateMeBadge(ids) {
  if (state.activeTab === "profile") { markMyReportsSeen(ids); return; }
  const seen = getSeen();
  // Первый запуск на этой машине — всё текущее считаем уже виденным,
  // а не пугаем счётчиком на всю накопленную работу.
  if (!seen) { setSeen(ids); renderMeBadge(0); return; }
  renderMeBadge([...ids].filter(id => !seen.has(id)).length);
}

// Вызывается при выходе из аккаунта: иначе первый же опрос после входа
// другим человеком считает ВЕСЬ его список новым (id-то другие) и
// вываливает системное уведомление «Вам назначено N новых отчётов».
export function resetAssignmentsBaseline() {
  knownAssigned = null;
  renderMeBadge(0);
}

async function pollAssignments() {
  if (!state.token || !state.isAdmin) return;
  try {
    const r = await apiGet("/reports", { assignee: "me", page_size: 100 });
    const ids = new Set((r.reports || []).map(x => x.public_id));
    if (knownAssigned !== null) {
      const fresh = [...ids].filter(id => !knownAssigned.has(id));
      if (fresh.length) {
        notifyDesktop("Project", fresh.length === 1
          ? `Вам назначен отчёт ${fresh[0]}`
          : `Вам назначено ${fresh.length} новых отчётов`);
      }
    }
    knownAssigned = ids;
    updateMeBadge(ids);
  } catch (_) { /* тихо: трей не должен спамить ошибками сети раз в минуту */ }
}

// Сразу при старте — иначе первую минуту после входа новые назначения
// молча не отслеживаются (тот же приём, что у presence.js/feed-badge.js).
pollAssignments();
setInterval(pollAssignments, POLL_INTERVAL_MS);
