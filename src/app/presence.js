// Presence — тот же /api/presence/ping, что и мини-апп шлёт, пока
// вкладка открыта: сервер считает человека «в сети» ещё
// _PRESENCE_ONLINE_WINDOW секунд после последнего пинга (см.
// api_presence_ping/_is_online в server.py) — на это и завязан
// online-статус в списке команды/профиле коллеги. Без него desktop-
// клиент никогда не засветился бы онлайн, только чат-бот и мини-апп.

import { state } from "./state.js";
import { apiPost } from "./api.js";

const PING_INTERVAL_MS = 60_000;

export async function pingPresence() {
  if (!state.token) return;
  try { await apiPost("/presence/ping", {}); } catch (_) { /* тихо — не критично, следующий пинг через минуту */ }
}

pingPresence();
setInterval(pingPresence, PING_INTERVAL_MS);
