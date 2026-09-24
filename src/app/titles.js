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

// Баннер сезона (по мотивам AniVerse): крупный постер на размытом фоне,
// описание с Shikimori, голосование и лента «В тренде» — клик по постеру
// в ленте переключает баннер, без клика он сам листается раз в 9 секунд.
const HERO_COUNT = 5;
const HERO_ICONS = {
  heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.3v5.4l4.6-2.7z" fill="currentColor" stroke="none"/></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3-.5-3 0-6 1-8.5Z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg>',
};
let heroTimer = null;
let heroIndex = 0;

function heroTitles(titles) {
  return titles.slice().sort(TABLE_SORTS.rank).slice(0, HERO_COUNT);
}

function heroBodyHtml(t, rank, seasonName) {
  const det = detailsCache.get(t.id);
  const posterSrc = imgProxy(t.poster_url);
  const pct = approvalPct(t);
  const meta = [seasonName, det && det.kind_label, det && det.aired_on && det.aired_on.slice(0, 4)].filter(Boolean);
  const eps = episodesText(det);
  const leader = rank === 1 && t.likes > t.dislikes;
  return `
    <div class="tl-hero-bg"${posterSrc ? ` style="background-image:url('${posterSrc}')"` : ""}></div>
    ${posterSrc ? `<img class="tl-hero-poster" src="${posterSrc}" alt="" data-open-title-detail="${t.id}">` : ""}
    <div class="tl-hero-body">
      <span class="tl-hero-eyebrow">${leader ? "Лидер голосования" : `№${rank} в сезоне`}</span>
      <h2 class="tl-hero-name">${esc(t.name)}</h2>
      ${meta.length ? `<div class="tl-hero-meta">${meta.map(esc).join("<i></i>")}</div>` : ""}
      ${det && det.description ? `<p class="tl-hero-desc">${esc(det.description)}</p>` : (det === undefined ? `<p class="tl-hero-desc"><span class="tt-loading"></span></p>` : "")}
      <div class="tl-hero-stats">
        <span>${HERO_ICONS.heart}${pct == null ? "Нет голосов" : `${pct}% одобрения`}</span>
        ${eps ? `<span>${HERO_ICONS.play}${esc(eps)} эп.</span>` : ""}
        ${det && det.status_label ? `<span>${HERO_ICONS.flame}${esc(det.status_label)}</span>` : ""}
      </div>
      <div class="tl-hero-actions vote-actions">
        <button class="btn primary tl-hero-like${t.my_vote === 1 ? " on-like" : ""}" data-vote-title="${t.id}" data-vote-choice="1">${LIKE_ICON}Нравится <span>${t.likes}</span></button>
        <button class="btn tl-hero-dislike${t.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${t.id}" data-vote-choice="-1" title="Не то">${DISLIKE_ICON}<span>${t.dislikes}</span></button>
        <button class="btn tl-hero-more" data-open-title-detail="${t.id}">${HERO_ICONS.info}Подробнее</button>
      </div>
    </div>`;
}

function voteHeroHtml(titles, seasonName) {
  const list = heroTitles(titles);
  if (!list.length) return "";
  heroIndex = Math.min(heroIndex, list.length - 1);
  const totalVotes = titles.reduce((s, t) => s + voteActivity(t), 0);
  return `
    <section class="tl-hero" data-hero>
      <div class="tl-hero-stage in" data-hero-stage>${heroBodyHtml(list[heroIndex], heroIndex + 1, seasonName)}</div>
      <div class="tl-hero-dots">${list.map((t, i) => `<button type="button" class="tl-hero-dot${i === heroIndex ? " on" : ""}" data-hero-go="${i}" aria-label="${esc(t.name)}"></button>`).join("")}</div>
      <div class="tl-hero-strip">
        <div class="tl-hero-strip-head"><b>В тренде</b><span>${titles.length} тайтлов · ${totalVotes} голосов</span></div>
        <div class="tl-hero-strip-row">
          ${list.map((t, i) => {
            const src = imgProxy(t.poster_url);
            return `<button type="button" class="tl-hero-thumb${i === heroIndex ? " on" : ""}" data-hero-go="${i}" title="${esc(t.name)}">
              ${src ? `<img src="${src}" alt="" loading="lazy">` : `<span class="tt-poster-ph"></span>`}
              <span class="tl-hero-thumb-name">${esc(t.name)}</span>
            </button>`;
          }).join("")}
        </div>
      </div>
    </section>`;
}

function wireHero(wrap, titles, seasonName) {
  const hero = wrap.querySelector("[data-hero]");
  window.clearInterval(heroTimer);
  if (!hero) return;
  const list = heroTitles(titles);
  const show = i => {
    heroIndex = (i + list.length) % list.length;
    const stage = hero.querySelector("[data-hero-stage]");
    stage.classList.remove("in");
    stage.innerHTML = heroBodyHtml(list[heroIndex], heroIndex + 1, seasonName);
    void stage.offsetWidth;
    stage.classList.add("in");
    hero.querySelectorAll("[data-hero-go]").forEach(b => b.classList.toggle("on", Number(b.dataset.heroGo) === heroIndex));
    wireVoteButtons(stage);
  };
  hero.querySelectorAll("[data-hero-go]").forEach(b => b.addEventListener("click", () => show(Number(b.dataset.heroGo))));
  let paused = false;
  hero.addEventListener("mouseenter", () => { paused = true; });
  hero.addEventListener("mouseleave", () => { paused = false; });
  if (list.length > 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    heroTimer = window.setInterval(() => {
      if (!hero.isConnected) { window.clearInterval(heroTimer); return; }
      if (!paused && !document.hidden) show(heroIndex + 1);
    }, 9000);
  }
  // Подробности (описание, серии) догружаются после отрисовки —
  // перерисовываем баннер, когда пришли данные для показанного тайтла.
  hero._refresh = id => { if (list[heroIndex] && list[heroIndex].id === id) show(heroIndex); };
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
    // Модель обновляем всегда, а не только из строки таблицы: баннер
    // перерисовывает слайд из этих объектов, и после «Нравится» →
    // другой тайтл → обратно там всплывал старый счётчик.
    const t = currentTitles.find(x => x.id === titleId);
    if (t) { t.likes = r.likes; t.dislikes = r.dislikes; t.my_vote = r.my_vote; }
    // Та же пара кнопок есть и в баннере, и в таблице/сетке — синхронизируем.
    document.querySelectorAll(`[data-vote-title="${titleId}"]`).forEach(b => {
      if (b === likeBtn || b === dislikeBtn) return;
      const like = b.dataset.voteChoice === "1";
      b.classList.toggle(like ? "on-like" : "on-dislike", r.my_vote === (like ? 1 : -1));
      setCount(b.querySelector("span"), like ? r.likes : r.dislikes);
    });
    const row = document.querySelector(`[data-title-row="${titleId}"]`);
    if (row && t) row.querySelector(".tt-approval-cell").innerHTML = approvalCellHtml(t);
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
let currentSeasonName = "";

function renderTitlesBody(wrap) {
  const view = getView();
  wrap.innerHTML = voteHeroHtml(currentTitles, currentSeasonName) + (view === "table"
    ? titlesTableHtml(currentTitles)
    : `<div class="vote-grid">${currentTitles.map(voteCardHtml).join("")}</div>`);
  wireVoteButtons(wrap);
  wireHero(wrap, currentTitles, currentSeasonName);
  wrap.querySelectorAll("[data-titles-sort]").forEach(th => {
    th.addEventListener("click", () => {
      tableSort = th.dataset.titlesSort;
      renderTitlesBody(wrap);
    });
  });
  const seq = titlesRequestSeq;
  // Сначала подробности тайтлов баннера — их описание видно сразу.
  const heroIds = heroTitles(currentTitles).map(t => t.id);
  loadDetails([...heroIds, ...currentTitles.map(t => t.id).filter(id => !heroIds.includes(id))], (id, det) => {
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
    const hero = wrap.querySelector("[data-hero]");
    if (hero && hero._refresh) hero._refresh(id);
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
      if (wrap && currentTitles.length) renderTitlesBody(wrap);
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
    currentSeasonName = (seasons.find(x => x.id === seasonId) || {}).name || "";
    heroIndex = 0;
    renderTitlesBody(wrap);
  }).catch(e => {
    const wrap = $("#titles-grid");
    if (wrap && seq === titlesRequestSeq) wrap.innerHTML = `<div class="bento-empty">Не удалось загрузить тайтлы: ${esc(e.message)}</div>`;
  });
}
