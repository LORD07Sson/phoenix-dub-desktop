// Вкладка «Тайтлы» (голосование, /api/public/*).
// Портировано из мини-аппа: loadVote/renderVoteTitles/voteBentoHtml/
// voteCardHtml/castVote/openTitleDetailPublic (miniapp/static/index.html).

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml, mediaUrl } from "./api.js";
import { $, esc } from "./utils.js";
import { openSeasonsAdminSheet } from "./titles-admin.js";
import { clearTitleHoverCache } from "./title-hover.js";

// Сборка URL с токеном — одна на всё приложение (api.js): раньше в
// четырёх файлах лежала своя копия, и все четыре подставляли в строку
// "null", когда токена ещё нет.
function imgProxy(url) {
  return url ? mediaUrl("/img_proxy", { url }) : "";
}

const TD_ICONS = {
  episodes: '<span class="td-ic square"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="M10 9.3v5.4l4.6-2.7z" fill="currentColor" stroke="none"></path></svg></span>',
  schedule: '<span class="td-ic square"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"></rect><path d="M3.5 9.5h17M8 2.5v4M16 2.5v4M7.2 13.2h3.4M7.2 16.8h6.6"></path></svg></span>',
  source: '<span class="td-ic round"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7.2"></circle><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"></circle></svg></span>',
  crew: '<span class="td-ic round"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.7" cy="9" r="2.5"></circle><path d="M3.8 17.8c0-2.7 2.1-4.4 4.9-4.4s4.9 1.7 4.9 4.4"></path><circle cx="16.2" cy="8.3" r="2"></circle><path d="M14.9 12.1c2 .2 3.6 1.6 3.6 3.8"></path></svg></span>',
};

function titleDetailMetaRowsHtml(det) {
  if (!det) return "";
  const rows = [];

  const epParts = [];
  if (det.episodes_aired != null && det.episodes_total) epParts.push(`${det.episodes_aired} из ${det.episodes_total} эп.`);
  else if (det.episodes_total) epParts.push(`${det.episodes_total} эп.`);
  if (det.duration_min) epParts.push(`по ~${det.duration_min} мин.`);
  if (epParts.length) rows.push(`<div class="td-meta-row">${TD_ICONS.episodes}<span>${esc(epParts.join(" "))}</span></div>`);

  const statusParts = [det.kind_label, det.status_label].filter(Boolean);
  if (statusParts.length) rows.push(`<div class="td-meta-row">${TD_ICONS.schedule}<span>${esc(statusParts.join(", "))}</span></div>`);

  if (det.source_label) rows.push(`<div class="td-meta-row">${TD_ICONS.source}<span>Первоисточник ${esc(det.source_label)}</span></div>`);

  const crewParts = [det.studio, det.author, det.director].filter(Boolean);
  if (crewParts.length) rows.push(`<div class="td-meta-row">${TD_ICONS.crew}<span>${esc(crewParts.join(" · "))}</span></div>`);

  return rows.join("");
}

function voteActivity(t) { return t.likes + t.dislikes; }

// Вид вкладки: карточки (постеры) или таблица с подробностями — как
// переключатель table/cards в мини-аппе. Личная настройка.
function viewKey() { return `phoenix_titles_view_${state.telegramId || "anon"}`; }
function getView() {
  try { return localStorage.getItem(viewKey()) === "table" ? "table" : "cards"; } catch (_) { return "cards"; }
}
function setView(v) {
  try { localStorage.setItem(viewKey(), v); } catch (_) { /* не критично */ }
}

// Подробности Shikimori/AniList (формат, эпизоды, студия, жанры) есть
// только в /public/titles/{id} — в списке сезона их нет. Догружаются
// после отрисовки, не больше 4 запросов разом, и кэшируются на сессию.
const detailsCache = new Map();
async function loadDetails(ids, onEach) {
  const queue = ids.filter(id => !detailsCache.has(id));
  ids.filter(id => detailsCache.has(id)).forEach(id => onEach(id, detailsCache.get(id)));
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      let det = null;
      try {
        const d = await apiGet(`/public/titles/${id}`);
        det = d.details && !Array.isArray(d.details) ? d.details : null;
      } catch (_) { /* без подробностей строка просто останется с прочерками */ }
      detailsCache.set(id, det);
      onEach(id, det);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
}

function approvalPct(t) {
  const total = voteActivity(t);
  return total ? Math.round((t.likes / total) * 100) : null;
}

function episodesText(det) {
  if (!det) return "";
  if (det.episodes_aired != null && det.episodes_total) return `${det.episodes_aired} / ${det.episodes_total}`;
  if (det.episodes_total) return String(det.episodes_total);
  return "";
}

function cardMetaText(det) {
  if (!det) return "";
  return [det.kind_label, episodesText(det) && `${episodesText(det)} эп.`, det.studio].filter(Boolean).join(" · ");
}

const LIKE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.2 2.6L12.6 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/></svg>';
const DISLIKE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 13V4h3v9zM17 13l-4 7c-1.5 0-2.5-1-2.2-2.6l.6-3.4H5a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.2 4H17"/></svg>';

const TABLE_SORTS = {
  rank: (a, b) => (b.likes - b.dislikes) - (a.likes - a.dislikes) || voteActivity(b) - voteActivity(a),
  name: (a, b) => a.name.localeCompare(b.name, "ru"),
  votes: (a, b) => voteActivity(b) - voteActivity(a),
  approval: (a, b) => (approvalPct(b) ?? -1) - (approvalPct(a) ?? -1),
};
let tableSort = "rank";

function detailCellsHtml(det) {
  const loading = det === undefined;
  const dash = loading ? `<span class="tt-loading"></span>` : `<span class="tt-dim">—</span>`;
  const kind = det && [det.kind_label, det.status_label].filter(Boolean);
  const genres = det && det.genres && det.genres.length ? det.genres : null;
  return `
    <td class="tt-kind">${kind && kind.length ? `${esc(kind[0])}${kind[1] ? `<span class="tt-sub">${esc(kind[1])}</span>` : ""}` : dash}</td>
    <td class="tt-num">${det && episodesText(det) ? esc(episodesText(det)) : dash}</td>
    <td class="tt-studio">${det && det.studio ? esc(det.studio) : dash}</td>
    <td class="tt-genres">${genres ? genres.slice(0, 3).map(g => `<span class="tt-genre">${esc(g)}</span>`).join("") + (genres.length > 3 ? `<span class="tt-dim">+${genres.length - 3}</span>` : "") : dash}</td>`;
}

function approvalCellHtml(t) {
  const pct = approvalPct(t);
  return `
    <div class="tt-approval">
      <div class="tt-approval-track"><i style="width:${pct ?? 0}%;"></i></div>
      <span class="tt-approval-val">${pct == null ? "нет голосов" : `${pct}% · ${voteActivity(t)}`}</span>
    </div>`;
}

function titleRowHtml(t, rank) {
  const posterSrc = imgProxy(t.poster_url);
  const det = detailsCache.has(t.id) ? detailsCache.get(t.id) : undefined;
  return `
    <tr data-title-row="${t.id}">
      <td class="tt-rank">${rank}</td>
      <td class="tt-main" data-open-title-detail="${t.id}">
        <div class="tt-title">
          ${posterSrc ? `<img class="tt-poster" src="${posterSrc}" alt="" loading="lazy">` : `<span class="tt-poster tt-poster-ph"></span>`}
          <div class="tt-names">
            <span class="tt-name">${esc(t.name)}</span>
            <span class="tt-sub tt-original">${det && det.name_original ? esc(det.name_original) : ""}</span>
          </div>
        </div>
      </td>
      ${detailCellsHtml(det)}
      <td class="tt-approval-cell">${approvalCellHtml(t)}</td>
      <td class="tt-vote">
        <div class="vote-actions tt-vote-actions">
          <button class="vote-btn${t.my_vote === 1 ? " on-like" : ""}" data-vote-title="${t.id}" data-vote-choice="1" title="Нравится">${LIKE_ICON}<span>${t.likes}</span></button>
          <button class="vote-btn${t.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${t.id}" data-vote-choice="-1" title="Не то">${DISLIKE_ICON}<span>${t.dislikes}</span></button>
        </div>
      </td>
    </tr>`;
}

function titlesTableHtml(titles) {
  const ranked = titles.slice().sort(TABLE_SORTS.rank);
  const rankOf = new Map(ranked.map((t, i) => [t.id, i + 1]));
  const rows = titles.slice().sort(TABLE_SORTS[tableSort] || TABLE_SORTS.rank);
  const th = (key, label, cls = "") => key
    ? `<th class="${cls}${tableSort === key ? " sorted" : ""}" data-titles-sort="${key}">${label}</th>`
    : `<th class="${cls}">${label}</th>`;
  return `
    <div class="tt-wrap">
      <table class="tt-table">
        <thead><tr>
          ${th("rank", "#", "tt-rank")}${th("name", "Тайтл")}${th(null, "Формат")}${th(null, "Эп.", "tt-num")}
          ${th(null, "Студия")}${th(null, "Жанры")}${th("approval", "Одобрение")}${th("votes", "Голос")}
        </tr></thead>
        <tbody>${rows.map(t => titleRowHtml(t, rankOf.get(t.id))).join("")}</tbody>
      </table>
    </div>`;
}

// Лидер сезона — только если реально есть за что бороться (хоть один
// голос с перевесом), иначе на свежем сезоне без голосов "лидером"
// стал бы случайный первый по порядку тайтл.
function voteSeasonTop(titles) {
  const ranked = titles.filter(t => t.likes > t.dislikes)
    .sort((a, b) => (b.likes - b.dislikes) - (a.likes - a.dislikes));
  return ranked[0] || null;
}

function voteBentoHtml(titles, top) {
  const totalVotes = titles.reduce((s, t) => s + voteActivity(t), 0);

  const statsHtml = `
    <div class="bcell"><h3>Тайтлов в сезоне</h3><div class="big-num">${titles.length}</div></div>
    <div class="bcell"><h3>Голосов подано</h3><div class="big-num">${totalVotes}</div></div>
  `;

  if (!top) return `<div class="bento">${statsHtml}</div>`;

  // Проверяем СОБРАННЫЙ адрес, а не только наличие poster_url: без
  // токена mediaUrl() вернёт пустую строку, а <img src=""> — это
  // запрос самой страницы и битая картинка вместо заглушки.
  const posterSrc = imgProxy(top.poster_url);
  const poster = posterSrc
    ? `<img class="vote-hero-poster" src="${posterSrc}" alt="" data-open-title-detail="${top.id}">`
    : `<div class="vote-hero-poster vote-poster-ph" data-open-title-detail="${top.id}">🎬</div>`;

  const heroHtml = `
    <div class="bcell wide vote-hero">
      ${poster}
      <div class="vote-hero-body">
        <div data-open-title-detail="${top.id}" style="cursor:pointer;">
          <span class="vote-hero-tag">🏆 Топ сезона</span>
          <div class="vote-hero-name">${esc(top.name)}</div>
        </div>
        <div class="vote-actions">
          <button class="vote-btn${top.my_vote === 1 ? " on-like" : ""}" data-vote-title="${top.id}" data-vote-choice="1">👍 <span>${top.likes}</span></button>
          <button class="vote-btn${top.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${top.id}" data-vote-choice="-1">👎 <span>${top.dislikes}</span></button>
        </div>
      </div>
    </div>`;

  return `<div class="bento">${statsHtml}${heroHtml}</div>`;
}

function voteCardHtml(t) {
  const posterSrc = imgProxy(t.poster_url);
  const poster = posterSrc
    ? `<img class="vote-poster" src="${posterSrc}" alt="" loading="lazy">`
    : `<div class="vote-poster vote-poster-ph">🎬</div>`;
  const voteCls = t.my_vote === 1 ? " voted-like" : (t.my_vote === -1 ? " voted-dislike" : "");

  return `
    <div class="vote-card${voteCls}">
      <div class="vote-card-tap" data-open-title-detail="${t.id}">
        ${poster}
        <div class="vote-name">${esc(t.name)}</div>
        <div class="vote-meta" data-card-meta="${t.id}">${esc(cardMetaText(detailsCache.get(t.id)))}</div>
      </div>
      <div class="vote-actions">
        <button class="vote-btn${t.my_vote === 1 ? " on-like" : ""}" data-vote-title="${t.id}" data-vote-choice="1">👍 <span>${t.likes}</span></button>
        <button class="vote-btn${t.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${t.id}" data-vote-choice="-1">👎 <span>${t.dislikes}</span></button>
      </div>
    </div>`;
}

async function castVote(titleId, choice, btn) {
  // Пара кнопок 👍/👎 живёт в двух разных обёртках: .vote-actions (карточка
  // сезона и герой-блок) и .td-vote-cta (шторка тайтла). Раньше тут был
  // closest(".vote-card") || closest(".vote-hero") — в шторке ни того, ни
  // другого предка нет, card был null, и клик по «Нравится» падал
  // TypeError ещё до запроса: голосовать из детальной карточки было
  // нельзя вообще, причём молча.
  const group = btn.closest(".vote-actions, .td-vote-cta");
  if (!group) return;
  const pendingHost = btn.closest(".vote-card") || group;
  const likeBtn = group.querySelector('[data-vote-choice="1"]');
  const dislikeBtn = group.querySelector('[data-vote-choice="-1"]');
  const already = btn.classList.contains(choice === 1 ? "on-like" : "on-dislike");
  const vote = already ? 0 : choice;

  pendingHost.classList.add("vote-pending");
  try {
    const r = await apiPost(`/public/titles/${titleId}/vote`, { vote });
    likeBtn.classList.toggle("on-like", r.my_vote === 1);
    dislikeBtn.classList.toggle("on-dislike", r.my_vote === -1);
    // В шторке у кнопок текстовые подписи («👍 Нравится») без <span> со
    // счётчиком — числа там показывают отдельные .td-stat-pill.
    setCount(likeBtn.querySelector("span"), r.likes);
    setCount(dislikeBtn.querySelector("span"), r.dislikes);
    const row = btn.closest("[data-title-row]");
    if (row) {
      const t = currentTitles.find(x => x.id === titleId);
      if (t) {
        t.likes = r.likes; t.dislikes = r.dislikes; t.my_vote = r.my_vote;
        row.querySelector(".tt-approval-cell").innerHTML = approvalCellHtml(t);
      }
    }
    const sheet = btn.closest(".sheet");
    if (sheet) {
      setCount(sheet.querySelector(".td-stat-pill.like"), `👍 ${r.likes}`);
      setCount(sheet.querySelector(".td-stat-pill.dislike"), `👎 ${r.dislikes}`);
    }
  } catch (e) {
    toast(e.message, "error");
  } finally {
    pendingHost.classList.remove("vote-pending");
  }
}

function setCount(el, value) {
  if (el) el.textContent = value;
}

function wireVoteButtons(root) {
  root.querySelectorAll("[data-vote-title]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      castVote(parseInt(btn.dataset.voteTitle, 10), parseInt(btn.dataset.voteChoice, 10), btn);
    });
  });
  root.querySelectorAll("[data-open-title-detail]").forEach(el => {
    el.addEventListener("click", () => openTitleDetail(parseInt(el.dataset.openTitleDetail, 10)));
  });
}

async function openTitleDetail(titleId) {
  const overlay = openSheet(dialogSkeletonHtml(4));
  let d;
  try {
    d = await apiGet(`/public/titles/${titleId}`);
  } catch (e) {
    overlay.querySelector(".sheet").innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить тайтл: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const det = d.details && Array.isArray(d.details) ? null : d.details;
  const poster = imgProxy(d.poster_url);
  const posterHtml = poster ? `<img class="td-poster" src="${poster}" alt="">` : `<div class="td-poster">🎬</div>`;
  const bgHtml = poster ? `<div class="td-bg" style="background-image:url(${poster})"></div>` : "";

  overlay.querySelector(".sheet").innerHTML = `
    <div class="td-hero">
      ${bgHtml}
      <div class="td-poster-wrap">${posterHtml}</div>
    </div>
    <div class="td-body">
      <div class="td-name">${esc(d.name)}</div>
      ${det && det.name_original ? `<div class="td-name-original">${esc(det.name_original)}</div>` : ""}
      ${d.season_name ? `<div class="td-chip">${esc(d.season_name)}</div>` : ""}
      <div class="td-stat-row">
        <span class="td-stat-pill like">👍 ${d.likes}</span>
        <span class="td-stat-pill dislike">👎 ${d.dislikes}</span>
      </div>
      <div class="td-vote-cta">
        <button class="${d.my_vote === 1 ? "on-like" : ""}" data-vote-title="${d.id}" data-vote-choice="1">👍 Нравится</button>
        <button class="${d.my_vote === -1 ? "on-dislike" : ""}" data-vote-title="${d.id}" data-vote-choice="-1">👎 Не то</button>
      </div>
      ${det ? `
      <div class="td-meta">${titleDetailMetaRowsHtml(det)}</div>
      ${det.genres && det.genres.length ? `<div class="td-genre-row">${det.genres.map(g => `<span class="td-genre-chip">${esc(g)}</span>`).join("")}</div>` : ""}
      ${det.description ? `<div class="td-desc">${esc(det.description)}</div>` : ""}
      ` : ""}
    </div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  wireVoteButtons(overlay);
}

export async function loadTitlesTab() {
  // Вкладку открыли заново или нажали «Обновить» — подробности (счётчик
  // серий, статус) берём свежие, а не из кэша прошлого показа.
  detailsCache.clear();
  clearTitleHoverCache();
  const root = $("#titles-body");
  root.innerHTML = dialogSkeletonHtml(3);
  let d;
  try {
    d = await apiGet("/public/seasons");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить сезоны: ${esc(e.message)}</div>`;
    return false;
  }
  d.seasons = d.seasons || [];
  if (!d.seasons.length) {
    root.innerHTML = `<div class="empty-state"><div style="font-size:34px; margin-bottom:8px;">📅</div>Эфир-сезонов пока нет.</div>`;
    return;
  }
  if (state.titleSeasonId == null || !d.seasons.some(s => s.id === state.titleSeasonId)) {
    state.titleSeasonId = d.seasons[0].id;
  }
  renderTitlesForSeason(d.seasons);
}

let currentTitles = [];

function renderTitlesBody(wrap, top) {
  const view = getView();
  const gridTitles = top ? currentTitles.filter(t => t.id !== top.id) : currentTitles;
  wrap.innerHTML = voteBentoHtml(currentTitles, top) + (view === "table"
    ? titlesTableHtml(currentTitles)
    : `<div class="vote-grid">${gridTitles.map(voteCardHtml).join("")}</div>`);
  wireVoteButtons(wrap);
  wrap.querySelectorAll("[data-titles-sort]").forEach(th => {
    th.addEventListener("click", () => {
      tableSort = th.dataset.titlesSort;
      renderTitlesBody(wrap, top);
    });
  });
  const seq = titlesRequestSeq;
  loadDetails(currentTitles.map(t => t.id), (id, det) => {
    if (seq !== titlesRequestSeq || !wrap.isConnected) return;
    const row = wrap.querySelector(`[data-title-row="${id}"]`);
    if (row) {
      row.querySelectorAll(".tt-kind, .tt-num, .tt-studio, .tt-genres").forEach(td => td.remove());
      row.querySelector(".tt-main").insertAdjacentHTML("afterend", detailCellsHtml(det));
      const orig = row.querySelector(".tt-original");
      if (orig && det && det.name_original) orig.textContent = det.name_original;
    }
    const meta = wrap.querySelector(`[data-card-meta="${id}"]`);
    if (meta) meta.textContent = cardMetaText(det);
  });
}

// Номер последнего запрошенного сезона: ответ на предыдущий запрос
// может прийти позже, чем на текущий (кликнули «Лето» → «Осень»), и
// раньше он молча затирал уже отрисованную сетку чужими тайтлами.
let titlesRequestSeq = 0;

function renderTitlesForSeason(seasons) {
  const root = $("#titles-body");
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Тайтлы</h1>
        <div class="sub">Голосование за тайтлы эфир-сезона: что студия берёт в работу.</div>
      </div>
      <div class="page-header-actions">
        <div class="seg-toggle" role="group" aria-label="Вид">
          <button type="button" class="seg-btn${getView() === "cards" ? " active" : ""}" data-titles-view="cards" aria-pressed="${getView() === "cards"}">Карточки</button>
          <button type="button" class="seg-btn${getView() === "table" ? " active" : ""}" data-titles-view="table" aria-pressed="${getView() === "table"}">Таблица</button>
        </div>
        <button class="btn" id="titles-admin-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/></svg>Управление</button>
      </div>
    </div>
    <div class="chip-row" style="padding:0 0 14px;">
      ${seasons.map(s => `<button class="qchip${s.id === state.titleSeasonId ? " on" : ""}" data-season="${s.id}">${esc(s.name)}</button>`).join("")}
    </div>
    <div id="titles-grid">${dialogSkeletonHtml(3)}</div>
  `;
  root.querySelectorAll("[data-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.titleSeasonId = parseInt(btn.dataset.season, 10);
      renderTitlesForSeason(seasons);
    });
  });
  root.querySelectorAll("[data-titles-view]").forEach(btn => {
    btn.addEventListener("click", () => {
      setView(btn.dataset.titlesView);
      root.querySelectorAll("[data-titles-view]").forEach(b => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      const wrap = $("#titles-grid");
      if (wrap && currentTitles.length) renderTitlesBody(wrap, voteSeasonTop(currentTitles));
    });
  });
  root.querySelector("#titles-admin-btn").addEventListener("click", () => {
    openSeasonsAdminSheet(() => loadTitlesTab());
  });

  const seq = ++titlesRequestSeq;
  const seasonId = state.titleSeasonId;
  apiGet(`/public/seasons/${seasonId}/titles`).then(d => {
    const wrap = $("#titles-grid");
    if (!wrap || seq !== titlesRequestSeq) return; // успели переключить сезон/вкладку, пока грузилось
    if (!d.titles.length) {
      wrap.innerHTML = `<div class="empty-state"><div style="font-size:34px; margin-bottom:8px;">🎬</div>Тайтлов в этом сезоне пока нет.</div>`;
      return;
    }
    currentTitles = d.titles;
    renderTitlesBody(wrap, voteSeasonTop(d.titles));
  }).catch(e => {
    const wrap = $("#titles-grid");
    if (wrap && seq === titlesRequestSeq) wrap.innerHTML = `<div class="bento-empty">Не удалось загрузить тайтлы: ${esc(e.message)}</div>`;
  });
}
