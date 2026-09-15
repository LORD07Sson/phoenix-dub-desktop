// Счётчик непрочитанных событий на иконке «Лента» в сайдбаре — тот же
// поллинг, что уже есть в notifications.js для новых назначений (раз
// в минуту), только считает НОВЫЕ события ленты с последнего просмотра
// вкладки, а не шлёт тост. У событий ленты нет отдельного id (см.
// /api/feed на сервере — объединяет report_activity и admin_log без
// сквозного счётчика), поэтому сравниваем сами timestamp-строки
// лексикографически — формат "YYYY-MM-DD HH:MM:SS" для этого подходит
// как есть, без парсинга дат.

import { apiGet } from "./api.js";
import { state } from "./state.js";

const POLL_INTERVAL_MS = 60_000;
const LAST_SEEN_KEY = "phoenix_feed_last_seen";

function getLastSeen() {
  try { return localStorage.getItem(LAST_SEEN_KEY) || ""; } catch (_) { return ""; }
}
function setLastSeen(ts) {
  try { localStorage.setItem(LAST_SEEN_KEY, ts); } catch (_) { /* приватный режим — не критично, просто без запоминания */ }
}

function renderBadge(count) {
  const btn = document.querySelector('.tab-btn[data-tab="feed"]');
  if (!btn) return;
  let badge = btn.querySelector(".tab-badge");
  if (!count) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tab-badge";
    btn.appendChild(badge);
  }
  badge.textContent = count > 9 ? "9+" : String(count);
}

// Вызывается из feed.js после успешной загрузки ленты — открыли
// вкладку, значит всё видели, счётчик сбрасывается и точка отсечения
// сдвигается на самое свежее событие из только что загруженного списка.
export function markFeedSeen(latestTimestamp) {
  if (latestTimestamp) setLastSeen(latestTimestamp);
  renderBadge(0);
}

async function pollFeed() {
  if (!state.token) return;
  if (state.activeTab === "feed") return; // сама вкладка и так открыта
  try {
    const r = await apiGet("/feed", { offset: 0, page_size: 30 });
    const events = r.events || [];
    const lastSeen = getLastSeen();
    if (!lastSeen) {
      // Первый запуск на этой машине — не заваливаем счётчиком всю
      // накопленную историю, просто запоминаем текущий момент как
      // точку отсечения для будущих сравнений.
      if (events[0]) setLastSeen(events[0].created_at);
      return;
    }
    const freshCount = events.filter(e => e.created_at > lastSeen).length;
    renderBadge(freshCount);
  } catch (_) { /* тихо — трей не должен спамить ошибками сети раз в минуту */ }
}

setInterval(pollFeed, POLL_INTERVAL_MS);
pollFeed();
