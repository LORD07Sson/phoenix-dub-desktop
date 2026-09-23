// Управление тайтлами/сезонами (админская часть — /api/seasons,
// /api/titles/*) — отдельно от голосования (titles.js, /api/public/*).
// Портировано из admin-веток мини-аппа (openSeasonsAdmin/openSeasonDetail/
// openTitleDetail в miniapp/static/index.html, admin/titles.py у бота —
// та же бизнес-логика). Открывается кнопкой «🛠 Управление» на вкладке
// «Тайтлы» — доступно любому админу (сервер и так перепроверяет
// _require_admin на каждый вызов), отдельного gate на кнопку не нужно.

import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml, mediaUrl } from "./api.js";
import { esc } from "./utils.js";

function imgProxy(url) {
  return url ? mediaUrl("/img_proxy", { url }) : "";
}

// Экспортируются — те же кэши переиспользует редактор пайплайна в
// report-detail.js (тот же список ролей/исполнителей, дважды его
// заводить незачем).
// Кэши живут до следующего «Обновить» (clearDirectoryCache зовёт
// refreshAll в tabs.js) — иначе только что заведённый коллега не
// появлялся в списках назначения до перезапуска приложения.
let META_ROLES_CACHE = null;
export async function loadRoles() {
  if (META_ROLES_CACHE) return META_ROLES_CACHE;
  try { META_ROLES_CACHE = (await apiGet("/meta")).roles || []; } catch (_) { META_ROLES_CACHE = []; }
  return META_ROLES_CACHE;
}

let ASSIGNABLE_CACHE = null;
export async function loadAssignable() {
  if (ASSIGNABLE_CACHE) return ASSIGNABLE_CACHE;
  try { ASSIGNABLE_CACHE = (await apiGet("/assignable-users")).users || []; } catch (_) { ASSIGNABLE_CACHE = []; }
  return ASSIGNABLE_CACHE;
}

export function clearDirectoryCache() {
  META_ROLES_CACHE = null;
  ASSIGNABLE_CACHE = null;
}

export function userOptionsHtml(users, selectedTelegramId) {
  return `<option value="">— не назначен —</option>` + users.map(u =>
    `<option value="${u.telegram_id}" ${String(u.telegram_id) === String(selectedTelegramId) ? "selected" : ""}>${esc(u.username ? "@" + u.username : u.name)}</option>`
  ).join("");
}

// ---------- Список сезонов ----------

export async function openSeasonsAdminSheet(onClose) {
  const overlay = openSheet(`<h2>Управление тайтлами</h2>${dialogSkeletonHtml(5)}`, "wide");
  const sheet = overlay.querySelector(".sheet");

  // Список сезонов/тайтлов на вкладке «Тайтлы» мог устареть, пока была
  // открыта эта шторка (создали/удалили/переименовали) — обновляем его
  // при закрытии ЛЮБЫМ способом (кнопка «Закрыть», клик по фону, ✕ у
  // конкретной строки не относится — тут это просто overlay.remove()),
  // поэтому наблюдаем за самим удалением из DOM, а не вешаем колбэк на
  // каждую отдельную кнопку.
  if (onClose) {
    new MutationObserver((_muts, obs) => {
      if (!overlay.isConnected) { obs.disconnect(); onClose(); }
    }).observe(document.body, { childList: true });
  }

  async function render() {
    let d;
    try {
      d = await apiGet("/seasons");
    } catch (e) {
      sheet.innerHTML = `<h2>Управление тайтлами</h2><div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    const rows = (d.seasons || []).map(s => `
      <div class="mini-row" data-open-season="${s.id}" style="cursor:pointer;">
        <span class="name">${esc(s.name)}</span>
        <span class="val">${s.titles_count} тайтлов</span>
        <button class="icon-btn" data-rename-season="${s.id}" data-season-name="${esc(s.name)}" title="Переименовать">✏️</button>
        <button class="icon-btn" data-delete-season="${s.id}" title="Удалить">✕</button>
      </div>
    `).join("");
    sheet.innerHTML = `
      <h2>Управление тайтлами</h2>
      <div class="detail-section">
        <h3>Эфир-сезоны</h3>
        <div>${rows || `<div class="no-assignee">Сезонов пока нет</div>`}</div>
        <div class="add-row">
          <input id="season-new" placeholder="Название сезона, например «Лето 2026»…">
          <button class="btn" id="season-add">+</button>
        </div>
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelectorAll("[data-open-season]").forEach(row => {
      row.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-rename-season],[data-delete-season]")) return;
        openSeasonDetailAdmin(parseInt(row.dataset.openSeason, 10));
      });
    });
    sheet.querySelectorAll("[data-rename-season]").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const name = prompt("Новое название сезона:", btn.dataset.seasonName);
        if (!name || !name.trim()) return;
        try {
          await apiPost(`/seasons/${btn.dataset.renameSeason}/rename`, { name: name.trim() });
          toast("Переименовано.");
          await render();
        } catch (e) { toast(`Не удалось переименовать: ${e.message}`, "error"); }
      });
    });
    sheet.querySelectorAll("[data-delete-season]").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm("Удалить сезон? Это возможно только если в нём нет тайтлов.")) return;
        try {
          await apiPost(`/seasons/${btn.dataset.deleteSeason}/delete`, {});
          toast("Сезон удалён.");
          await render();
        } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
      });
    });
    sheet.querySelector("#season-add").addEventListener("click", async () => {
      const input = sheet.querySelector("#season-new");
      const name = input.value.trim();
      if (!name) return;
      try {
        await apiPost("/seasons", { name });
        input.value = "";
        toast("Сезон создан.");
        await render();
      } catch (e) { toast(`Не удалось создать: ${e.message}`, "error"); }
    });
  }

  await render();
}

// ---------- Тайтлы внутри сезона ----------

async function openSeasonDetailAdmin(seasonId) {
  const overlay = openSheet(dialogSkeletonHtml(5), "wide");
  const sheet = overlay.querySelector(".sheet");

  async function render() {
    let d;
    try {
      d = await apiGet(`/seasons/${seasonId}`);
    } catch (e) {
      sheet.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }
    const rows = (d.titles || []).map(t => `
      <div class="mini-row" data-open-title="${t.id}" style="cursor:pointer;">
        <span class="name">${esc(t.name)}</span>
        <span class="val">${t.pct != null ? `${t.pct}%` : "—"} · ${t.episodes_count} эп. · ${t.crew_count} в составе</span>
      </div>
    `).join("");
    sheet.innerHTML = `
      <h2>${esc(d.name)}</h2>
      <div class="detail-section">
        <h3>Тайтлы</h3>
        <div>${rows || `<div class="no-assignee">Тайтлов пока нет</div>`}</div>
        <div class="add-row">
          <input id="title-new" placeholder="Название тайтла…">
          <button class="btn" id="title-add">+</button>
        </div>
        <div class="add-row" style="margin-top:6px;">
          <input id="title-shiki" placeholder="…или ссылка на Shikimori (shikimori.one, .io, .me — /animes/…)">
          <button class="btn" id="title-shiki-add">Добавить</button>
        </div>
      </div>
      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    sheet.querySelectorAll("[data-open-title]").forEach(row => {
      row.addEventListener("click", () => openTitleAdminDetail(parseInt(row.dataset.openTitle, 10), () => render()));
    });
    sheet.querySelector("#title-add").addEventListener("click", async () => {
      const input = sheet.querySelector("#title-new");
      const name = input.value.trim();
      if (!name) return;
      try {
        await apiPost(`/seasons/${seasonId}/titles`, { name });
        input.value = "";
        toast("Тайтл создан.");
        await render();
      } catch (e) { toast(`Не удалось создать: ${e.message}`, "error"); }
    });
    // Создание в один шаг по ссылке на Shikimori — тот же create_title,
    // что и у обычной кнопки «+», плюс сразу постер и персонажи (см.
    // /api/seasons/{id}/titles/from-shikimori на сервере: parse id из
    // ссылки → fetch_shikimori_by_id → create_title → fetch_title_characters).
    // Двухшаговый путь (создать по имени → «🔍 Найти» внутри карточки
    // тайтла) остаётся — годится, если по ссылке тайтл не нашёлся или
    // нужен именно AniList.
    sheet.querySelector("#title-shiki-add").addEventListener("click", async () => {
      const input = sheet.querySelector("#title-shiki");
      const raw = input.value.trim();
      if (!raw) return;
      const shikiId = parseShikimoriId(raw);
      if (!shikiId) {
        toast("Не похоже на ссылку Shikimori — вставьте адрес страницы тайтла (…/animes/59193-…) или его номер.", "error");
        return;
      }
      const btn = sheet.querySelector("#title-shiki-add");
      btn.disabled = true;
      btn.textContent = "Добавляю…";
      try {
        // На сервер уходит только номер: его разбор ссылки знает лишь
        // домены shikimori.one/.me, а голый id принимает всегда.
        const res = await apiPost(`/seasons/${seasonId}/titles/from-shikimori`, { url: String(shikiId) });
        input.value = "";
        toast(`Тайтл создан: ${res.name}${res.characters_count ? ` · ${res.characters_count} персонажей` : ""}`);
        await render();
      } catch (e) {
        toast(`Не удалось добавить по ссылке: ${e.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Добавить";
      }
    });
  }

  await render();
}

// Номер тайтла из того, что вставили: голый id («59193»), кусок адреса
// («59193-mushoku-tensei…»), или ссылка на любом зеркале Shikimori —
// shikimori.one/.me/.io/.org, с www и без, с префиксом архивных тайтлов
// «z» (…/animes/z5114-…). Раньше сервер узнавал только .one и .me, и
// ссылка с shikimori.io молча не распознавалась.
export function parseShikimoriId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const bare = /^z?(\d+)(?:-[\w-]*)?$/i.exec(raw);
  if (bare) return Number(bare[1]);
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (_) {
    return null;
  }
  if (!/(^|\.)shikimori\.[a-z]+$/i.test(url.hostname)) return null;
  const m = /\/animes\/z?(\d+)/i.exec(url.pathname);
  return m ? Number(m[1]) : null;
}

// ---------- Детальная карточка тайтла (состав, персонажи, серии) ----------

async function openTitleAdminDetail(titleId, onClose) {
  const overlay = openSheet(dialogSkeletonHtml(6), "wide");
  const sheet = overlay.querySelector(".sheet");

  if (onClose) {
    new MutationObserver((_muts, obs) => {
      if (!overlay.isConnected) { obs.disconnect(); onClose(); }
    }).observe(document.body, { childList: true });
  }

  async function render() {
    let d, roles, assignable;
    try {
      [d, roles, assignable] = await Promise.all([apiGet(`/titles/${titleId}`), loadRoles(), loadAssignable()]);
    } catch (e) {
      sheet.innerHTML = `<div class="no-assignee">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }

    const posterSrc = imgProxy(d.poster_url);
    const posterHtml = posterSrc
      ? `<img src="${posterSrc}" alt="" style="width:80px; height:110px; object-fit:cover; border-radius:8px;">`
      : `<div style="width:80px; height:110px; border-radius:8px; background:var(--surface-2); display:flex; align-items:center; justify-content:center; font-size:28px;">🎬</div>`;

    const crewRows = (d.crew || []).map(c => `
      <div class="mini-row">
        <span class="name">${esc(c.role)}</span>
        <span class="val">${esc(c.name || "не назначен")}</span>
        <button class="icon-btn" data-crew-remove="${esc(c.role)}" title="Убрать роль">✕</button>
      </div>
    `).join("");

    const charRows = (d.characters || []).map(c => `
      <div class="mini-row" data-char="${c.id}">
        <span class="name">${esc(c.name)}${c.original_va_name ? ` <span class="meta" style="color:var(--ink-dim); font-size:11px;">(ориг. ${esc(c.original_va_name)})</span>` : ""}</span>
        <select class="field-input" data-char-voice="${c.id}" style="max-width:180px;">${userOptionsHtml(assignable, c.voiced_by ? c.voiced_by.telegram_id : null)}</select>
        <button class="icon-btn" data-char-delete="${c.id}" title="Удалить персонажа">✕</button>
      </div>
    `).join("");

    const episodeRows = (d.episode_groups || []).map(g => `
      <div class="mini-row">
        <span class="name">${esc(g.label)}</span>
        <span class="val">${g.completed}/${g.total} готово · ${g.pct}%</span>
      </div>
    `).join("");

    sheet.innerHTML = `
      <div class="detail-head">
        <h2>${esc(d.name)}</h2>
        <button class="icon-btn" data-close style="flex:none;">✕</button>
      </div>
      <div class="detail-id">${esc(d.season_name || "")} · создан ${esc(d.created_at || "")}</div>

      <div class="detail-section" style="display:flex; gap:14px;">
        ${posterHtml}
        <div style="flex:1;">
          <div class="add-row">
            <input id="meta-search-q" placeholder="Название для поиска на Shikimori/AniList…" value="${esc(d.name)}">
            <button class="btn" id="meta-search-btn">Найти</button>
          </div>
          <div id="meta-candidates"></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Состав</h3>
        <div id="crew-list">${crewRows || `<div class="no-assignee">Состав пуст</div>`}</div>
        <div class="add-row">
          <select id="crew-role-new" class="field-input"><option value="">— роль —</option>${roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select>
          <select id="crew-user-new" class="field-input">${userOptionsHtml(assignable, null)}</select>
          <button class="btn" id="crew-add">Назначить</button>
        </div>
      </div>

      <div class="detail-section">
        <h3>Персонажи ${d.characters.length ? `(${d.characters.length})` : ""}</h3>
        <div id="char-list">${charRows || `<div class="no-assignee">Персонажей пока нет — найдите тайтл на Shikimori/AniList выше и подтвердите</div>`}</div>
        ${d.characters.length ? `<button class="btn ghost" id="char-delete-all" style="margin-top:8px;">Удалить всех персонажей</button>` : ""}
      </div>

      <div class="detail-section">
        <h3>Серии ${d.episode_groups.length ? `(${d.episode_groups.length})` : ""}</h3>
        <div>${episodeRows || `<div class="no-assignee">Серий пока нет</div>`}</div>
        <div class="add-row">
          <input id="ep-label-new" placeholder="Номер/название серии, например «Серия 5»…">
          <input id="ep-deadline-new" type="date">
          <button class="btn" id="ep-add">Создать</button>
        </div>
      </div>

      <div class="sheet-actions">
        <button class="btn danger" id="btn-delete-title" style="margin-right:auto;">Удалить тайтл</button>
        <button class="btn ghost" id="btn-rename-title">Переименовать</button>
        <button class="btn" data-close>Закрыть</button>
      </div>
    `;

    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));

    sheet.querySelector("#meta-search-btn").addEventListener("click", async () => {
      const q = sheet.querySelector("#meta-search-q").value.trim();
      if (!q) return;
      const box = sheet.querySelector("#meta-candidates");
      box.innerHTML = `<div class="no-assignee">Ищу…</div>`;
      try {
        const res = await apiPost(`/titles/${titleId}/meta/search`, { query: q });
        const candidates = res.candidates || [];
        box.innerHTML = candidates.length ? candidates.map(c => `
          <div class="mini-row">
            ${imgProxy(c.poster_url) ? `<img src="${imgProxy(c.poster_url)}" alt="" style="width:34px; height:46px; object-fit:cover; border-radius:4px;">` : ""}
            <span class="name">${esc(c.name)} <span class="meta" style="color:var(--ink-dim); font-size:11px;">(${esc(c.source)})</span></span>
            <button class="btn" data-confirm-candidate data-source="${esc(c.source)}" data-source-id="${esc(c.source_id)}" data-poster="${esc(c.poster_url || "")}">Подтвердить</button>
          </div>
        `).join("") : `<div class="no-assignee">Ничего не найдено</div>`;
        box.querySelectorAll("[data-confirm-candidate]").forEach(btn => {
          btn.addEventListener("click", async () => {
            // Раньше source и source_id склеивались через ":" в один
            // атрибут БЕЗ экранирования (единственное место в проекте,
            // где чужие данные шли в HTML-атрибут напрямую) и потом
            // разбирались split(":") — ломалось на любом id с
            // двоеточием. Теперь два отдельных экранированных атрибута.
            const { source, sourceId } = btn.dataset;
            btn.disabled = true;
            try {
              await apiPost(`/titles/${titleId}/meta/confirm`, { source, source_id: sourceId, poster_url: btn.dataset.poster || null });
              toast("Подтверждено — постер и персонажи обновлены.");
              await render();
            } catch (e) { toast(`Не удалось подтвердить: ${e.message}`, "error"); btn.disabled = false; }
          });
        });
      } catch (e) { box.innerHTML = `<div class="no-assignee">Ошибка поиска: ${esc(e.message)}</div>`; }
    });

    sheet.querySelectorAll("[data-crew-remove]").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await apiPost(`/titles/${titleId}/crew/remove`, { role: btn.dataset.crewRemove });
          await render();
        } catch (e) { toast(`Не удалось убрать роль: ${e.message}`, "error"); }
      });
    });
    sheet.querySelector("#crew-add").addEventListener("click", async () => {
      const role = sheet.querySelector("#crew-role-new").value;
      // Number, а не строка из value: в остальных вызовах API
      // telegram_id уходит числом, и расхождение типов на сервере —
      // лишний повод для «молча не сработало».
      const rawUser = sheet.querySelector("#crew-user-new").value;
      const telegram_id = rawUser ? Number(rawUser) : null;
      if (!role) { toast("Выберите роль.", "error"); return; }
      try {
        await apiPost(`/titles/${titleId}/crew`, { role, telegram_id });
        toast("Состав обновлён.");
        await render();
      } catch (e) { toast(`Не удалось назначить: ${e.message}`, "error"); }
    });

    sheet.querySelectorAll("[data-char-voice]").forEach(sel => {
      sel.addEventListener("change", async () => {
        try {
          await apiPost(`/titles/${titleId}/characters/${sel.dataset.charVoice}/voice`, { telegram_id: sel.value ? Number(sel.value) : null });
          toast("Актёр озвучки обновлён.");
        } catch (e) { toast(`Не удалось назначить: ${e.message}`, "error"); }
      });
    });
    sheet.querySelectorAll("[data-char-delete]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Удалить этого персонажа?")) return;
        try {
          await apiPost(`/titles/${titleId}/characters/delete`, { ids: [parseInt(btn.dataset.charDelete, 10)] });
          await render();
        } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
      });
    });
    const deleteAllBtn = sheet.querySelector("#char-delete-all");
    if (deleteAllBtn) deleteAllBtn.addEventListener("click", async () => {
      if (!confirm("Удалить ВСЕХ персонажей тайтла?")) return;
      try {
        await apiPost(`/titles/${titleId}/characters/delete`, { all: true });
        await render();
      } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
    });

    sheet.querySelector("#ep-add").addEventListener("click", async () => {
      const episode_label = sheet.querySelector("#ep-label-new").value.trim();
      const deadline = sheet.querySelector("#ep-deadline-new").value || null;
      if (!episode_label) { toast("Укажите номер/название серии.", "error"); return; }
      try {
        const res = await apiPost(`/titles/${titleId}/episodes`, { episode_label, deadline });
        toast(`Создано отчётов: ${res.created.length}.`);
        await render();
      } catch (e) { toast(`Не удалось создать серию: ${e.message}`, "error"); }
    });

    sheet.querySelector("#btn-rename-title").addEventListener("click", async () => {
      const name = prompt("Новое название тайтла:", d.name);
      if (!name || !name.trim()) return;
      try {
        await apiPost(`/titles/${titleId}/rename`, { name: name.trim() });
        toast("Переименовано.");
        await render();
      } catch (e) { toast(`Не удалось переименовать: ${e.message}`, "error"); }
    });
    sheet.querySelector("#btn-delete-title").addEventListener("click", async () => {
      if (!confirm(`Удалить тайтл «${d.name}»? Возможно только если у него нет серий.`)) return;
      try {
        await apiPost(`/titles/${titleId}/delete`, {});
        toast("Тайтл удалён.");
        overlay.remove();
      } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
    });
  }

  await render();
}

