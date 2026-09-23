// Всплывающая карточка при наведении на обложку тайтла в «Тайтлах» —
// крупнее превью + прогресс серий, без открытия полного sheet
// (openTitleDetail в titles.js — тяжелее, целая карточка). Тот же
// приём, что и у аватаров (avatar-hover.js): делегированный
// обработчик на document, задержка перед показом, кэш ответов на
// сессию. Элементы-триггеры уже несут data-open-title-detail (тот же
// атрибут, что используется для клика — voteCardHtml/voteBentoHtml в
// titles.js), новый атрибут заводить не нужно.

import { apiGet, mediaUrl } from "./api.js";
import { esc } from "./utils.js";

const HOVER_DELAY_MS = 320;
const HIDE_DELAY_MS = 120;
// Детали тайтла (в т.ч. счётчик вышедших серий) держим 10 минут: повторное
// наведение не бьёт лишним запросом, но и новая серия не прячется до
// перезапуска приложения, как было при кэше «на всю сессию».
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map(); // id -> { at, data }

let popoverEl = null;
let showTimer = null;
let hideTimer = null;
let currentId = null;

function imgProxy(url) {
  return url ? mediaUrl("/img_proxy", { url }) : "";
}

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement("div");
  popoverEl.className = "title-popover";
  popoverEl.hidden = true;
  document.body.appendChild(popoverEl);
  popoverEl.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  popoverEl.addEventListener("mouseleave", scheduleHide);
  return popoverEl;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (popoverEl) popoverEl.classList.remove("shown");
    currentId = null;
  }, HIDE_DELAY_MS);
}

function renderPopover(anchor, d) {
  // /public/titles/{id} возвращает details объектом, либо пустым
  // массивом, если их ещё не заполнили — тот же нормализующий
  // прищур, что в titles.js:openTitleDetail.
  const det = d.details && !Array.isArray(d.details) ? d.details : null;
  const poster = imgProxy(d.poster_url);
  const epLine = det && det.episodes_total
    ? (det.episodes_aired != null ? `${det.episodes_aired} из ${det.episodes_total} эп.` : `${det.episodes_total} эп.`)
    : "";
  const statusLine = det ? [det.kind_label, det.status_label].filter(Boolean).join(", ") : "";

  const pop = ensurePopover();
  pop.innerHTML = `
    ${poster ? `<img class="tp-poster" src="${poster}" alt="">` : `<div class="tp-poster tp-poster-ph">🎬</div>`}
    <div class="tp-body">
      <div class="tp-name">${esc(d.name)}</div>
      ${epLine ? `<div class="tp-line">${esc(epLine)}</div>` : ""}
      ${statusLine ? `<div class="tp-line tp-dim">${esc(statusLine)}</div>` : ""}
    </div>
  `;
  pop.hidden = false;
  pop.classList.remove("shown");
  const rect = anchorBox(anchor);
  const popRect = pop.getBoundingClientRect();
  // Справа от постера, если не помещается — слева; по вертикали по
  // центру постера, но в пределах окна.
  let left = rect.right + 12;
  let side = "right";
  if (left + popRect.width > window.innerWidth - 8) { left = rect.left - popRect.width - 12; side = "left"; }
  if (left < 8) left = 8;
  let top = rect.top + rect.height / 2 - popRect.height / 2;
  top = Math.min(Math.max(8, top), window.innerHeight - popRect.height - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.dataset.side = side;
  requestAnimationFrame(() => pop.classList.add("shown"));
}

// Обёртка карточки (.vote-card-tap) — display:contents, собственного
// прямоугольника у неё нет, getBoundingClientRect() отдаёт нули, и окно
// улетало в левый верхний угол поверх боковой панели. Меряем то, что
// реально нарисовано: постер внутри, иначе первого потомка с размером.
function anchorBox(anchor) {
  // В таблице — вся ячейка с постером и названием (иначе окно закрывало
  // само название), на «Топе сезона» — постер.
  const candidates = [anchor.querySelector(".tt-title, .vote-hero-poster"), anchor, ...anchor.children];
  for (const el of candidates) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r;
  }
  return anchor.getBoundingClientRect();
}

async function loadAndShow(anchor, titleId) {
  const hit = cache.get(titleId);
  let data = hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.data : null;
  if (!data) {
    try {
      data = await apiGet(`/public/titles/${titleId}`);
      cache.set(titleId, { at: Date.now(), data });
    } catch (_) {
      return; // необязательная подсказка — молча не показываем при ошибке сети
    }
  }
  if (currentId !== titleId) return; // за время запроса курсор уже увели на другой тайтл
  if (!anchor.isConnected) return; // сетку успели перерисовать (смена сезона и т.п.)
  renderPopover(anchor, data);
}

export function clearTitleHoverCache() {
  cache.clear();
}

document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-open-title-detail]");
  if (!el) return;
  // Карточка сезона и так показывает крупный постер, название и
  // подробности — всплывающее окно там только дублировало её и
  // перекрывало соседей. Оставлено для таблицы и «Топа сезона», где
  // постер маленький.
  if (el.closest(".vote-card")) return;
  const titleId = el.dataset.openTitleDetail;
  if (!titleId) return;
  clearTimeout(hideTimer);
  if (currentId === titleId) return;
  clearTimeout(showTimer);
  currentId = titleId;
  showTimer = setTimeout(() => {
    if (currentId === titleId) loadAndShow(el, titleId);
  }, HOVER_DELAY_MS);
});

document.addEventListener("mouseout", e => {
  if (!e.target.closest("[data-open-title-detail]")) return;
  clearTimeout(showTimer);
  scheduleHide();
});
