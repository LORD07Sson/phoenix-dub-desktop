// Диалог «Настройки» (автозапуск, тема, режим разработчика, автообновление).

import { invoke, listen } from "./tauri.js";
import { state } from "./state.js";
import { apiGet, openSheet, toast } from "./api.js";
import { $, esc } from "./utils.js";
import { applyTheme } from "./theme.js";
import { isDevModeOn, setDevModeOn } from "./devmode.js";
import { openAdminPanel } from "./admin.js";

const APP_VERSION = "0.5.0"; // подставляется автоматически из VERSION при сборке в CI (build.yml)

// Альфа-сборки несут короткий коммит как SemVer build-metadata —
// "0.5.8-alpha.90+78ab7a92" (см. build-alpha.yml) — само сравнение
// версий Velopack'ом на него не смотрит (SemVer build-metadata в
// приоритет не участвует), тут его просто вытаскиваем для отображения.
function commitFromVersion(version) {
  const m = /\+([0-9a-f]{6,40})$/i.exec(version || "");
  return m ? m[1] : null;
}

async function openSettings() {
  let autostartOn = false;
  try { autostartOn = await invoke("is_autostart"); } catch (_) {}
  let updateChannel = "stable";
  try { updateChannel = await invoke("get_update_channel"); } catch (_) {}

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
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>🧪 Канал обновлений</span>
      <select id="s-update-channel">
        <option value="stable" ${updateChannel === "stable" ? "selected" : ""}>Стабильный</option>
        <option value="alpha" ${updateChannel === "alpha" ? "selected" : ""}>Альфа (тестовые сборки)</option>
      </select>
    </div>
    <div id="s-alpha-block" hidden>
      <div class="alpha-warn">⚠️ Альфа-сборки собираются на каждый коммит в main и не являются стабильными релизами — автоматического отката нет.</div>
      <div class="row" style="align-items:center; justify-content:space-between;">
        <span>Текущий коммит</span>
        <code id="s-commit-current">—</code>
      </div>
      <div class="row" style="align-items:center; justify-content:space-between;">
        <span>Последний коммит</span>
        <code id="s-commit-latest">—</code>
      </div>
    </div>
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>Доступ участников и состояние системы</span>
      <button class="btn" id="s-open-admin" style="padding:5px 12px; font-size:12.5px;">🔐 Админ-панель</button>
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

  // Блок "текущий/последний коммит" — только для альфа-канала (у
  // стабильных сборок нет вшитого коммита, см. commitFromVersion).
  // "Последний" узнаём тем же check_for_update, которым пользуется
  // обычная проверка обновлений — лишнего эндпоинта не нужно, только
  // здесь мы его не открываем диалогом, а просто вытаскиваем коммит.
  async function refreshAlphaBlock(channel) {
    const block = overlay.querySelector("#s-alpha-block");
    block.hidden = channel !== "alpha";
    if (channel !== "alpha") return;

    const currentSha = commitFromVersion(APP_VERSION) || "?";
    const currentEl = overlay.querySelector("#s-commit-current");
    const latestEl = overlay.querySelector("#s-commit-latest");
    currentEl.textContent = currentSha;
    currentEl.title = APP_VERSION;
    latestEl.textContent = "…";
    latestEl.title = "";
    try {
      const update = await invoke("check_for_update");
      // update === null у Velopack означает "на канале нечего ставить" —
      // не то же самое, что ошибка запроса (см. catch ниже), различаем
      // текстом, чтобы не гадать по одному "?" в обоих случаях.
      if (update) {
        latestEl.textContent = commitFromVersion(update.version) || "?";
        latestEl.title = update.version;
      } else {
        latestEl.textContent = "нет новее";
        latestEl.title = "check_for_update вернул null — Velopack считает текущую версию актуальной для этого канала.";
      }
    } catch (e) {
      latestEl.textContent = "?";
      latestEl.title = `Ошибка check_for_update: ${e}`;
    }
  }
  refreshAlphaBlock(updateChannel);

  overlay.querySelector("#s-update-channel").addEventListener("change", async e => {
    const channel = e.target.value;
    try {
      await invoke("set_update_channel", { channel });
      toast(channel === "alpha" ? "Альфа-канал включён." : "Возвращено на стабильный канал.");
      await refreshAlphaBlock(channel);
    } catch (err) {
      toast(`Не удалось сменить канал: ${err}`, "error");
    }
  });
  overlay.querySelector("#s-open-admin").addEventListener("click", openAdminPanel);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}
$("#open-settings").addEventListener("click", openSettings);

// ---------- автообновление (Velopack) ----------
// Апдейтер целиком на Rust-стороне (см. check_for_update/
// download_and_apply_update в main.rs, Velopack + GithubSource читает
// релизы репозитория напрямую, без прокси на своём сервере). JS только
// вызывает команды и слушает событие "update-progress" для прогресс-бара.

export async function checkForUpdates(silent) {
  try {
    const update = await invoke("check_for_update");
    if (!update) {
      if (!silent) toast("У вас уже последняя версия.");
      return;
    }
    const yes = await confirmUpdateSheet(update);
    if (!yes) return;
    await installUpdate();
  } catch (e) {
    if (!silent) toast(`Не удалось проверить обновления: ${e}`, "error");
  }
}

function confirmUpdateSheet(update) {
  return new Promise(resolve => {
    const overlay = openSheet(`
      <h2>Доступно обновление ${esc(update.version)}</h2>
      <div style="color:var(--ink-soft); font-size:13px; white-space:pre-wrap; max-height:200px; overflow:auto; margin-bottom:6px;">${esc(update.notes || "Без описания изменений.")}</div>
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

async function installUpdate() {
  const overlay = openSheet(`
    <h2>Устанавливаю обновление…</h2>
    <div class="update-progress-track"><div class="update-progress-fill" id="upd-fill"></div></div>
    <div id="upd-status" style="color:var(--ink-soft); font-size:12.5px;">Скачивание…</div>
  `);
  const fill = overlay.querySelector("#upd-fill");
  const statusEl = overlay.querySelector("#upd-status");
  const unlisten = await listen("update-progress", event => {
    const pct = Math.max(0, Math.min(100, event.payload));
    fill.style.width = pct + "%";
    statusEl.textContent = pct < 100 ? `Скачано ${pct}%` : "Устанавливаю…";
  });
  try {
    // При успехе download_and_apply_update завершает процесс изнутри
    // (apply_updates_and_restart) — этот await просто никогда не
    // вернётся управлением дальше в обычном сценарии, окно закроется
    // само. Ветка catch — только на случай реальной ошибки.
    await invoke("download_and_apply_update");
  } catch (e) {
    unlisten();
    statusEl.textContent = `Ошибка: ${e}`;
    statusEl.style.color = "var(--s-stop)";
  }
}
