// Диалог «Настройки» (автозапуск, тема, режим разработчика, автообновление).

import { invoke, listen } from "./tauri.js";
import { state } from "./state.js";
import { apiGet, openSheet, toast, dismissSheet } from "./api.js";
import { $, esc } from "./utils.js";
import { applyTheme, applyLook } from "./theme.js";
import { applyDensity, currentDensity } from "./density.js";
import { focusModePreferred, setFocusModePreferred } from "./focus-mode.js";
import { isDevModeOn, setDevModeOn } from "./devmode.js";
import { desktopNotifyEnabled, setDesktopNotifyEnabled } from "./desktop-notify.js";
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

  const ic = d => `<span class="st-ic"><svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg></span>`;
  const ICONS = {
    look: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 3.5a8.5 8.5 0 0 1 0 17" fill="currentColor" stroke="none" opacity=".35"/>',
    behave: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    update: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
    studio: '<path d="M4 20V9l8-5 8 5v11M9 20v-6h6v6"/>',
    diag: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    power: '<path d="M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>',
    focus: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/><circle cx="12" cy="12" r="2.5"/>',
    dev: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    density: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
    logs: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/>',
  };
  const TILES = [
    ["s-open-admin", "Админ-панель", "Доступ, заявки, система", '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>'],
    ["s-tile-notice", "Объявление", "Строка для всей команды", '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6"/>'],
    ["s-tile-tickets", "Тикеты", "Поддержка, переписка", '<path d="M4 6h16v9H9l-5 4z"/>'],
    ["s-tile-roles", "Роли", "Пайплайны и люди", '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 11l2 2 4-4"/>'],
    ["s-tile-bdays", "Дни рождения", "Бот поздравит сам", '<path d="M4 21h16M5 21v-7h14v7M12 14V9M9 5c0 1.7 1.3 3 3 3s3-1.3 3-3c0-1.2-3-3-3-3S9 3.8 9 5Z"/>'],
    ["s-tile-post", "Пост в канал", "Конструктор с превью", '<path d="M3 12l18-8-8 18-2-8-8-2Z"/>'],
    ["s-tile-mentions", "Упоминания", "Кого поднять в чате", '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>'],
    ...(state.isDeveloper ? [["s-tile-log", "Журнал действий", "Надзор за админами", '<path d="M6 3h9l4 4v14H6zM9 12h7M9 16h5"/>']] : []),
  ];
  const theme = document.documentElement.dataset.theme || "dark";
  const look = document.documentElement.dataset.look || "glow";
  const density = currentDensity();
  const sw = (id, on, extra = "") => `<label class="mn-switch st-switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""} ${extra}><span></span></label>`;

  const overlay = openSheet(`
    <div class="st-head">
      <h2>Настройки</h2>
      <button type="button" class="icon-btn" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="st-layout">
      <nav class="st-nav" aria-label="Разделы настроек">
        ${[["st-look", "Внешний вид", ICONS.look], ["st-behave", "Поведение", ICONS.behave], ["st-update", "Обновления", ICONS.update], ["st-studio", "Студия", ICONS.studio], ["st-diag", "Диагностика", ICONS.diag]]
          .map(([id, label, i], n) => `<button type="button" class="st-nav-btn${n === 0 ? " on" : ""}" data-st-go="${id}">${ic(i)}<span>${label}</span></button>`).join("")}
      </nav>
      <div class="st-body" id="st-body">

        <section class="st-sec" id="st-look">
          <h3>Внешний вид</h3>
          <div class="st-label">Тема</div>
          <div class="st-cards">
            <button type="button" class="st-card${theme === "dark" ? " on" : ""}" data-st-theme="dark"><span class="st-prev st-prev-dark"><i></i><i></i><i></i></span><b>Тёмная</b></button>
            <button type="button" class="st-card${theme === "light" ? " on" : ""}" data-st-theme="light"><span class="st-prev st-prev-light"><i></i><i></i><i></i></span><b>Светлая</b></button>
          </div>
          <div class="st-label">Стиль тёмной темы</div>
          <div class="st-cards">
            <button type="button" class="st-card${look === "glow" ? " on" : ""}" data-st-look="glow"><span class="st-prev st-prev-glow"><i></i><i></i><i></i></span><b>Золотое свечение</b><em>луч света и золотые кромки</em></button>
            <button type="button" class="st-card${look === "fire" ? " on" : ""}" data-st-look="fire"><span class="st-prev st-prev-fire"><i></i><i></i><i></i></span><b>Огонь</b><em>огненное свечение снизу</em></button>
          </div>
          <div class="st-row">
            ${ic(ICONS.density)}
            <div class="st-text"><b>Плотность таблиц</b><span>Сколько строк влезает в «Список»</span></div>
            <div class="seg-toggle" role="group" aria-label="Плотность">
              <button type="button" class="seg-btn${density === "comfortable" ? " active" : ""}" data-st-density="comfortable">Обычная</button>
              <button type="button" class="seg-btn${density === "compact" ? " active" : ""}" data-st-density="compact">Компактная</button>
            </div>
          </div>
          <select id="s-theme" hidden><option value="dark">Тёмная</option><option value="light">Светлая</option></select>
          <select id="s-density" hidden><option value="comfortable">Обычная</option><option value="compact">Компактная</option></select>
        </section>

        <section class="st-sec" id="st-behave">
          <h3>Поведение</h3>
          <div class="st-row">${ic(ICONS.power)}<div class="st-text"><b>Запускать при старте системы</b><span>Окно сразу уходит в трей и следит за назначениями</span></div>${sw("s-autostart", autostartOn)}</div>
          <div class="st-row">${ic(ICONS.bell)}<div class="st-text"><b>Уведомления на рабочий стол</b><span>Личные, упоминания, назначения и действия по вашим отчётам — когда окно свёрнуто или в трее</span></div>${sw("s-desktop-notify", desktopNotifyEnabled())}</div>
          <div class="st-row">${ic(ICONS.focus)}<div class="st-text"><b>Фокус-режим при открытии отчёта</b><span>Карточка отчёта на весь экран, остальное прячется</span></div>${sw("s-focus-mode", focusModePreferred())}</div>
          ${state.isDeveloper ? `<div class="st-row dev-pill-toggle">${ic(ICONS.dev)}<div class="st-text"><b>Режим разработчика</b><span>Правка чужих ролей, профиля, даты вступления и наград — на карточке коллеги</span></div>${sw("s-dev-mode", isDevModeOn())}</div>` : ""}
        </section>

        <section class="st-sec" id="st-update">
          <h3>Обновления</h3>
          <div class="st-version">
            <div class="st-version-logo">${ic('<path d="M5 5L19 19M19 5L5 19"/>')}</div>
            <div class="st-text"><b>Project Desktop</b><span>версия ${esc(APP_VERSION)}</span></div>
            <button class="btn primary" id="s-check-update">Проверить обновления</button>
          </div>
          <div class="st-row">
            ${ic(ICONS.update)}
            <div class="st-text"><b>Канал обновлений</b><span>Альфа — сборка на каждый коммит, для проверки нового</span></div>
            <div class="seg-toggle" role="group" aria-label="Канал">
              <button type="button" class="seg-btn${updateChannel === "stable" ? " active" : ""}" data-st-channel="stable">Стабильный</button>
              <button type="button" class="seg-btn${updateChannel === "alpha" ? " active" : ""}" data-st-channel="alpha">Альфа</button>
            </div>
          </div>
          <select id="s-update-channel" hidden>
            <option value="stable" ${updateChannel === "stable" ? "selected" : ""}>Стабильный</option>
            <option value="alpha" ${updateChannel === "alpha" ? "selected" : ""}>Альфа</option>
          </select>
          <div id="s-alpha-block" hidden>
            <div class="alpha-warn">Альфа-сборки собираются на каждый коммит в main и не являются стабильными релизами — автоматического отката нет.</div>
            <div class="st-commits">
              <div><span>Текущий коммит</span><code id="s-commit-current">—</code></div>
              <div><span>Последний коммит</span><code id="s-commit-latest">—</code></div>
            </div>
          </div>
        </section>

        <section class="st-sec" id="st-studio">
          <h3>Студия</h3>
          <div class="st-tiles">
            ${TILES.map(([id, title, sub, path]) => `<button type="button" class="st-tile" id="${id}">${ic(path)}<b>${title}</b><span>${sub}</span></button>`).join("")}
          </div>
        </section>

        <section class="st-sec" id="st-diag">
          <h3>Диагностика</h3>
          <div class="st-row">${ic(ICONS.logs)}<div class="st-text"><b>Файловые логи приложения</b><span>Обновления, QC звука, инструменты ffmpeg, плеер</span></div><button class="btn" id="s-open-logs">Открыть логи</button></div>
          <div class="st-keys">
            <div><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>P</kbd><span>показать или скрыть окно откуда угодно, даже из трея</span></div>
            <div><kbd>?</kbd><span>все горячие клавиши</span></div>
            <div><kbd>Ctrl</kbd><kbd>K</kbd><span>поиск по отчётам, тайтлам и людям</span></div>
            <div><kbd>✕</kbd><span>у окна — свернуть в трей, назначения продолжают отслеживаться</span></div>
          </div>
        </section>
      </div>
    </div>
  `, "wide");
  overlay.querySelector(".sheet").classList.add("st-sheet");
  overlay.querySelector("#s-theme").value = document.documentElement.dataset.theme || "dark";
  overlay.querySelector("#s-theme").addEventListener("change", e => applyTheme(e.target.value));
  overlay.querySelector("#s-density").value = currentDensity();
  overlay.querySelector("#s-density").addEventListener("change", e => applyDensity(e.target.value));
  overlay.querySelector("#s-focus-mode").addEventListener("change", e => setFocusModePreferred(e.target.checked));
  overlay.querySelector("#s-desktop-notify").addEventListener("change", e => setDesktopNotifyEnabled(e.target.checked));
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

  // Плитки и сегменты — поверх тех же скрытых <select>, что и раньше:
  // обработчики выше не поменялись.
  const pick = (attr, sel, value) => {
    overlay.querySelectorAll(`[${attr}]`).forEach(b => b.classList.toggle(b.classList.contains("seg-btn") ? "active" : "on", b.getAttribute(attr) === value));
    if (sel) { const el = overlay.querySelector(sel); el.value = value; el.dispatchEvent(new window.Event("change")); }
  };
  overlay.querySelectorAll("[data-st-theme]").forEach(b => b.addEventListener("click", () => pick("data-st-theme", "#s-theme", b.dataset.stTheme)));
  overlay.querySelectorAll("[data-st-density]").forEach(b => b.addEventListener("click", () => pick("data-st-density", "#s-density", b.dataset.stDensity)));
  overlay.querySelectorAll("[data-st-channel]").forEach(b => b.addEventListener("click", () => pick("data-st-channel", "#s-update-channel", b.dataset.stChannel)));
  overlay.querySelectorAll("[data-st-look]").forEach(b => b.addEventListener("click", () => {
    pick("data-st-look", null, b.dataset.stLook);
    applyLook(b.dataset.stLook);
    if (document.documentElement.dataset.theme === "light") toast("Стиль применяется в тёмной теме.");
  }));
  const tile = (id, fn) => { const el = overlay.querySelector(`#${id}`); if (el) el.addEventListener("click", fn); };
  tile("s-tile-notice", () => import("./team-notice.js").then(m => m.openNoticeEditor()));
  tile("s-tile-tickets", () => import("./tickets.js").then(m => m.openTicketsSheet()));
  tile("s-tile-roles", () => import("./roles.js").then(m => m.openRolesSheet()));
  tile("s-tile-bdays", () => import("./birthdays.js").then(m => m.openBirthdaysSheet()));
  tile("s-tile-post", () => { dismissSheet(overlay); import("./channel-post.js").then(m => m.openChannelPostSheet()); });
  tile("s-tile-mentions", () => import("./mentions.js").then(m => m.openMentionsSheet()));
  tile("s-tile-log", () => import("./admin-log.js").then(m => m.openAdminLogSheet()));

  // Навигация слева: клик — прокрутка к разделу, подсветка — по прокрутке.
  const body = overlay.querySelector("#st-body");
  overlay.querySelectorAll("[data-st-go]").forEach(b => b.addEventListener("click", () => {
    body.scrollTo({ top: overlay.querySelector(`#${b.dataset.stGo}`).offsetTop - body.offsetTop - 8, behavior: "smooth" });
  }));
  body.addEventListener("scroll", () => {
    let current = "st-look";
    overlay.querySelectorAll(".st-sec").forEach(sec => { if (sec.offsetTop - body.offsetTop - 40 <= body.scrollTop) current = sec.id; });
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) current = "st-diag";
    overlay.querySelectorAll("[data-st-go]").forEach(b => b.classList.toggle("on", b.dataset.stGo === current));
  });
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
const AUTO_CHECK_STORAGE_KEY = "project_last_update_check_at";

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
