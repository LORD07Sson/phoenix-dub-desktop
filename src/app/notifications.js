// Уведомления о новых назначениях — диф-опрос раз в минуту, сравниваем
// с прошлым срезом и шлём системный тост только на реально новые id.

import { sendNotification } from "./tauri.js";
import { state } from "./state.js";
import { apiGet } from "./api.js";

let knownAssigned = null; // Set — null значит «ещё не было первого опроса»
const POLL_INTERVAL_MS = 60_000;

// Вызывается при выходе из аккаунта: иначе первый же опрос после входа
// другим человеком считает ВЕСЬ его список новым (id-то другие) и
// вываливает системное уведомление «Вам назначено N новых отчётов».
export function resetAssignmentsBaseline() {
  knownAssigned = null;
}

async function pollAssignments() {
  if (!state.token) return;
  try {
    const r = await apiGet("/reports", { assignee: "me", page_size: 100 });
    const ids = new Set((r.reports || []).map(x => x.public_id));
    if (knownAssigned !== null) {
      const fresh = [...ids].filter(id => !knownAssigned.has(id));
      if (fresh.length) {
        sendNotification({
          title: "PHOENIX DUB",
          body: fresh.length === 1
            ? `Вам назначен отчёт ${fresh[0]}`
            : `Вам назначено ${fresh.length} новых отчётов`,
        });
      }
    }
    knownAssigned = ids;
  } catch (_) { /* тихо: трей не должен спамить ошибками сети раз в минуту */ }
}

setInterval(pollAssignments, POLL_INTERVAL_MS);
