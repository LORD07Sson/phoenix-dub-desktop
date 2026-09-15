// Вкладка «Тайтлы» (голосование, /api/public/*).
// Портировано из мини-аппа: loadVote/renderVoteTitles/voteBentoHtml/
// voteCardHtml/castVote/openTitleDetailPublic (miniapp/static/index.html).

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml, mediaUrl } from "./api.js";
import { $, esc } from "./utils.js";
import { openSeasonsAdminSheet } from "./titles-admin.js";

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

// Номер последнего запрошенного сезона: ответ на предыдущий запрос
// может прийти позже, чем на текущий (кликнули «Лето» → «Осень»), и
// раньше он молча затирал уже отрисованную сетку чужими тайтлами.
let titlesRequestSeq = 0;

function renderTitlesForSeason(seasons) {
  const root = $("#titles-body");
  root.innerHTML = `
    <div class="chip-row" style="justify-content:space-between;">
      <div class="chip-row" style="padding:0;">
        ${seasons.map(s => `<button class="qchip${s.id === state.titleSeasonId ? " on" : ""}" data-season="${s.id}">${esc(s.name)}</button>`).join("")}
      </div>
      <button class="btn ghost" id="titles-admin-btn" style="font-size:12px; padding:6px 10px;">🛠 Управление</button>
    </div>
    <div id="titles-grid">${dialogSkeletonHtml(3)}</div>
  `;
  root.querySelectorAll("[data-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.titleSeasonId = parseInt(btn.dataset.season, 10);
      renderTitlesForSeason(seasons);
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
    const top = voteSeasonTop(d.titles);
    const gridTitles = top ? d.titles.filter(t => t.id !== top.id) : d.titles;
    wrap.innerHTML = voteBentoHtml(d.titles, top) + `<div class="vote-grid">${gridTitles.map(voteCardHtml).join("")}</div>`;
    wireVoteButtons(wrap);
  }).catch(e => {
    const wrap = $("#titles-grid");
    if (wrap && seq === titlesRequestSeq) wrap.innerHTML = `<div class="bento-empty">Не удалось загрузить тайтлы: ${esc(e.message)}</div>`;
  });
}
