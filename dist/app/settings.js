// Диалог «Настройки» (автозапуск, тема, режим разработчика, автообновление).

import { invoke, checkUpdate, relaunch } from "./tauri.js";
import { state } from "./state.js";
import { apiGet, openSheet, toast } from "./api.js";
import { $, esc } from "./utils.js";
import { applyTheme } from "./theme.js";
import { isDevModeOn, setDevModeOn } from "./devmode.js";

const APP_VERSION = "0.5.0"; // подставляется автоматически из VERSION при сборке в CI (build.yml)

async function openSettings() {
  let autostartOn = false;
  try { autostartOn = await invoke("is_autostart"); } catch (_) {}

  // Переключатель dev-режима виден только реальным разработчикам студии
  // (state.isDeveloper — из /api/me, is_developer сервер сам проверяет
  // по OWNER_IDS на каждый /api/dev/* запрос, фронту тут не доверяют).
  if (state.isDeveloper == null) {
    try { state.isDeveloper = !!(await apiGet("/me")).is_developer; } catch (_) { state.isDeveloper = false; }
  }

  const overlay = openSheet(`
    <h2>Настройки</h2>
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>Запускать при старте системы</span>
      <input type="checkbox" id="s-autostart" ${autostartOn ? "checked" : ""}>
    </div>
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>Тема</span>
      <select id="s-theme">
        <option value="dark">Тёмная</option>
        <option value="light">Светлая</option>
      </select>
    </div>
    ${state.isDeveloper ? `
    <div class="row dev-pill-toggle" style="align-items:center; justify-content:space-between;">
      <span>🛠 Режим разработчика</span>
      <input type="checkbox" id="s-dev-mode" ${isDevModeOn() ? "checked" : ""}>
    </div>` : ""}
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>Версия ${esc(APP_VERSION)}</span>
      <button class="btn" id="s-check-update" style="padding:5px 12px; font-size:12.5px;">Проверить обновления</button>
    </div>
    <p style="color:var(--ink-soft); font-size:12.5px;">
      Ctrl+Shift+P — показать/скрыть окно из любого места, даже когда оно свёрнуто в трей.<br>
      Крестик у окна сворачивает в трей — опрос новых назначений продолжает идти в фоне.
      ${state.isDeveloper ? "<br>Режим разработчика открывает правку чужих ролей/профиля/даты вступления/наград — на карточке коллеги (клик по тизеру команды)." : ""}
    </p>
    <div class="sheet-actions"><button class="btn primary" data-close>Готово</button></div>
  `);
  overlay.querySelector("#s-theme").value = document.documentElement.dataset.theme || "dark";
  overlay.querySelector("#s-theme").addEventListener("change", e => applyTheme(e.target.value));
  overlay.querySelector("#s-autostart").addEventListener("change", async e => {
    try {
      await invoke("set_autostart", { enabled: e.target.checked });
    } catch (err) {
      toast(`Не удалось изменить автозапуск: ${err}`, "error");
      e.target.checked = !e.target.checked;
    }
  });
  const devToggle = overlay.querySelector("#s-dev-mode");
  if (devToggle) devToggle.addEventListener("change", e => setDevModeOn(e.target.checked));
  overlay.querySelector("#s-check-update").addEventListener("click", () => checkForUpdates(false));
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}
$("#open-settings").addEventListener("click", openSettings);

// ---------- автообновление ----------
// tauri-plugin-updater/tauri-plugin-process — заменяются на Velopack
// в отдельном PR #7 (main.rs на этой ветке ещё со старым апдейтером).

export async function checkForUpdates(silent) {
  try {
    const update = await checkUpdate();
    if (!update) {
      if (!silent) toast("У вас уже последняя версия.");
      return;
    }
    const yes = await confirmUpdateSheet(update);
    if (!yes) return;
    await installUpdate(update);
  } catch (e) {
    if (!silent) toast(`Не удалось проверить обновления: ${e}`, "error");
  }
}

function confirmUpdateSheet(update) {
  return new Promise(resolve => {
    const overlay = openSheet(`
      <h2>Доступно обновление ${esc(update.version)}</h2>
      <div style="color:var(--ink-soft); font-size:13px; white-space:pre-wrap; max-height:200px; overflow:auto; margin-bottom:6px;">${esc(update.body || "Без описания изменений.")}</div>
      <div class="sheet-actions">
        <button class="btn ghost" data-no>Позже</button>
        <button class="btn primary" data-yes>Обновить и перезапустить</button>
      </div>
    `);
    overlay.querySelector("[data-no]").addEventListener("click", () => { overlay.remove(); resolve(false); });
    overlay.querySelector("[data-yes]").addEventListener("click", () => { overlay.remove(); resolve(true); });
    overlay.addEventListener("click", e => { if (e.target === overlay) resolve(false); });
  });
}

async function installUpdate(update) {
  const overlay = openSheet(`
    <h2>Устанавливаю обновление…</h2>
    <div class="update-progress-track"><div class="update-progress-fill" id="upd-fill"></div></div>
    <div id="upd-status" style="color:var(--ink-soft); font-size:12.5px;">Скачивание…</div>
  `);
  const fill = overlay.querySelector("#upd-fill");
  const statusEl = overlay.querySelector("#upd-status");
  let total = 0, downloaded = 0;
  try {
    await update.downloadAndInstall(event => {
      if (event.event === "Started") {
        total = event.data.contentLength || 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength || 0;
        if (total) {
          const pct = Math.min(100, Math.round((downloaded / total) * 100));
          fill.style.width = pct + "%";
          statusEl.textContent = `Скачано ${pct}%`;
        }
      } else if (event.event === "Finished") {
        fill.style.width = "100%";
        statusEl.textContent = "Устанавливаю…";
      }
    });
    statusEl.textContent = "Готово — перезапуск…";
    await relaunch();
  } catch (e) {
    statusEl.textContent = `Ошибка: ${e}`;
    statusEl.style.color = "var(--s-stop)";
  }
}
