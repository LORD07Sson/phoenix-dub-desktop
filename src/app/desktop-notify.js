// Системные уведомления Windows — общий выключатель из «Настроек» и одно
// правило: пока окно приложения в фокусе, всплывашку не показываем —
// человек и так видит колокольчик. Свёрнуто, в трее, за другим окном —
// показываем.

import { sendNotification } from "./tauri.js";

const KEY = "project_desktop_notify";

export function desktopNotifyEnabled() {
  try { return localStorage.getItem(KEY) !== "0"; } catch (_) { return true; }
}

export function setDesktopNotifyEnabled(on) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) { /* приватный режим — останется включено */ }
}

export function notifyDesktop(title, body) {
  if (!desktopNotifyEnabled() || document.hasFocus()) return;
  // sendNotification сама трогает window.Notification и в окружениях без
  // него бросает синхронно (см. qc.js) — уведомление не повод ронять опрос.
  try { sendNotification({ title, body }); } catch (_) { /* нет уведомлений — молчим */ }
}
