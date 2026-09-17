// Диалог «Настройки» (автозапуск, тема, режим разработчика, автообновление).

import { invoke, listen } from "./tauri.js";
import { state } from "./state.js";
import { apiGet, openSheet, toast, dismissSheet } from "./api.js";
import { $, esc } from "./utils.js";
import { applyTheme } from "./theme.js";
import { applyDensity, currentDensity } from "./density.js";
import { focusModePreferred, setFocusModePreferred } from "./focus-mode.js";
import { isDevModeOn, setDevModeOn } from "./devmode.js";
import { openAdminPanel } from "./admin.js";
import { tagLogger } from "./applog.js";

const updateLog = tagLogger("updates");

// Версию подставляет Vite на этапе сборки (define: __APP_VERSION__ в
// vite.config.js — читает файл VERSION, а в CI ещё и переменную
// PKG_VERSION, куда альфа-сборка кладёт "0.6.0-alpha.N+sha").
// Раньше здесь лежал литерал, который CI правил себе sed'ом по
// исходнику, — и в git он годами расходился и с VERSION, и с
// Cargo.toml: у собранного локально клиента в Настройках показывалась
// версия, которой нигде больше нет.
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

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

    <div class="settings-group">
      <div class="settings-group-title">🎨 Внешний вид</div>
      <div class="settings-row">
        <span>Тема</span>
        <select id="s-theme">
          <option value="dark">Тёмная</option>
          <option value="light">Светлая</option>
        </select>
      </div>
      <div class="settings-row">
        <span>Плотность таблиц</span>
        <select id="s-density">
          <option value="comfortable">Обычная</option>
          <option value="compact">Компактная</option>
        </select>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">🧭 Поведение</div>
      <div class="settings-row">
        <span>Запускать при старте системы</span>
        <input type="checkbox" id="s-autostart" ${autostartOn ? "checked" : ""}>
      </div>
      <div class="settings-row">
        <span>🧘 Фокус-режим при открытии отчёта</span>
        <input type="checkbox" id="s-focus-mode" ${focusModePreferred() ? "checked" : ""}>
      </div>
      ${state.isDeveloper ? `
      <div class="settings-row dev-pill-toggle">
        <span>🛠 Режим разработчика</span>
        <input type="checkbox" id="s-dev-mode" ${isDevModeOn() ? "checked" : ""}>
      </div>` : ""}
    </div>

    <div class="settings-group">
      <div class="settings-group-title">🔄 Обновления</div>
      <div class="settings-row">
        <span>Версия ${esc(APP_VERSION)}</span>
        <button class="btn" id="s-check-update">Проверить обновления</button>
      </div>
      <div class="settings-row">
        <span>🧪 Канал обновлений</span>
        <select id="s-update-channel">
          <option value="stable" ${updateChannel === "stable" ? "selected" : ""}>Стабильный</option>
          <option value="alpha" ${updateChannel === "alpha" ? "selected" : ""}>Альфа (тестовые сборки)</option>
        </select>
      </div>
      <div id="s-alpha-block" hidden>
        <div class="alpha-warn">⚠️ Альфа-сборки собираются на каждый коммит в main и не являются стабильными релизами — автоматического отката нет.</div>
        <div class="settings-row">
          <span>Текущий коммит</span>
          <code id="s-commit-current">—</code>
        </div>
        <div class="settings-row">
          <span>Последний коммит</span>
          <code id="s-commit-latest">—</code>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">🔐 Доступ и система</div>
      <div class="settings-row">
        <span>Доступ участников и состояние системы</span>
        <button class="btn" id="s-open-admin">🔐 Админ-панель</button>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">🩺 Диагностика</div>
      <div class="settings-row">
        <span>Файловые логи приложения (обновления, QC звука, инструменты ffmpeg, плеер)</span>
        <button class="btn" id="s-open-logs">📂 Открыть логи</button>
      </div>
    </div>

    <div class="settings-hint">
      <b>Ctrl+Shift+P</b> — показать/скрыть окно из любого места, даже когда оно свёрнуто в трей.<br>
      <b>⌨️</b> в шапке (или клавиша «?») — полный список горячих клавиш.<br>
      Крестик у окна сворачивает в трей — опрос новых назначений продолжает идти в фоне.
      ${state.isDeveloper ? "<br>Режим разработчика открывает правку чужих ролей/профиля/даты вступления/наград — на карточке коллеги (клик по тизеру команды)." : ""}
    </div>
    <div class="sheet-actions"><button class="btn primary" data-close>Готово</button></div>
  `);
  overlay.querySelector("#s-theme").value = document.documentElement.dataset.theme || "dark";
  overlay.querySelector("#s-theme").addEventListener("change", e => applyTheme(e.target.value));
  overlay.querySelector("#s-density").value = currentDensity();
  overlay.querySelector("#s-density").addEventListener("change", e => applyDensity(e.target.value));
  overlay.querySelector("#s-focus-mode").addEventListener("change", e => setFocusModePreferred(e.target.checked));
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
  overlay.querySelector("#s-open-logs").addEventListener("click", async () => {
    try {
      await invoke("open_log_folder");
    } catch (err) {
      toast(`Не удалось открыть папку с логами: ${err}`, "error");
    }
  });
  overlay.querySelector("[data-close]").addEventListener("click", () => dismissSheet(overlay));
}
$("#open-settings").addEventListener("click", openSettings);

// ---------- автообновление (Velopack) ----------
// Апдейтер целиком на Rust-стороне (см. check_for_update/
// download_and_apply_update в main.rs, Velopack + GithubSource читает
// релизы репозитория напрямую, без прокси на своём сервере). JS только
// вызывает команды и слушает событие "update-progress" для прогресс-бара.

// Автопроверка на каждом запуске (см. main.js) без троттлинга уходила в
// GitHub API без токена (60 запросов/час НА IP, не на пользователя — см.
// friendly_update_error в main.rs) при каждом старте приложения. На одном
// рабочем месте это несущественно, но студия — несколько компьютеров за
// одним офисным NAT, и совокупный поток запусков/перезапусков легко
// выбивает лимит даже без единого ручного клика «Проверить обновления».
// Ручная проверка из Настроек троттлингу не подчиняется — явный клик
// пользователя должен сходить на сервер всегда, даже если автопроверка
// была недавно.
const AUTO_CHECK_THROTTLE_MS = 4 * 60 * 60 * 1000; // 4 часа
const AUTO_CHECK_STORAGE_KEY = "phoenix_last_update_check_at";

export function maybeAutoCheckUpdates() {
  let last = 0;
  try {
    last = Number(localStorage.getItem(AUTO_CHECK_STORAGE_KEY) || 0);
  } catch {
    // localStorage недоступен (приватный режим и т.п.) — считаем, что
    // проверять можно, лучше лишний запрос, чем никогда не проверять.
  }
  if (Date.now() - last < AUTO_CHECK_THROTTLE_MS) return;
  try {
    localStorage.setItem(AUTO_CHECK_STORAGE_KEY, String(Date.now()));
  } catch {
    // не критично — просто не притормозит следующий запуск
  }
  checkForUpdates(true);
}

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
    // Тихую автопроверку при старте (silent=true) пользователь никогда
    // не видит тостом — раньше падение здесь (тот самый 403 на общем IP
    // студии) не оставляло вообще никакого следа. error-тост ниже уже
    // сам логируется через toast() (см. api.js), поэтому явный вызов
    // нужен именно на silent-ветке.
    if (!silent) toast(`Не удалось проверить обновления: ${e}`, "error");
    else updateLog.error(`тихая автопроверка при старте не удалась: ${e}`);
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
    // Закрытие клавишей Escape или кликом по фону — тоже ответ «позже».
    // Раньше Escape просто удалял оверлей из DOM, промис не резолвился
    // никогда, и checkForUpdates() оставался висеть на await до конца
    // жизни процесса.
    overlay.addEventListener("sheet-dismissed", () => resolve(false));
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
