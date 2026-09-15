// Всплывающая карточка при наведении на обложку тайтла в «Тайтлах» —
// крупнее превью + прогресс серий, без открытия полного sheet
// (openTitleDetail в titles.js — тяжелее, целая карточка). Тот же
// приём, что и у аватаров (avatar-hover.js): делегированный
// обработчик на document, задержка перед показом, кэш ответов на
// сессию. Элементы-триггеры уже несут data-open-title-detail (тот же
// атрибут, что используется для клика — voteCardHtml/voteBentoHtml в
// titles.js), новый атрибут заводить не нужно.

import { API_BASE, apiGet } from "./api.js";
import { esc } from "./utils.js";
import { state } from "./state.js";

const HOVER_DELAY_MS = 320;
const HIDE_DELAY_MS = 120;
// Детали тайтла не меняются за секунды — держим в памяти на сессию,
// чтобы повторное наведение не било лишним запросом.
const cache = new Map();

let popoverEl = null;
let showTimer = null;
let hideTimer = null;
let currentId = null;

function imgProxy(url) {
  if (!url) return "";
  return `${API_BASE}/img_proxy?url=${encodeURIComponent(url)}&init_data=${encodeURIComponent(state.token)}`;
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
    if (popoverEl) popoverEl.hidden = true;
    currentId = null;
  }, HIDE_DELAY_MS);
}

function renderPopover(anchor, d) {
  // /public/titles/{id} возвращает details объектом, либо пустым
  // массивом, если их ещё не заполнили — тот же нормализующий
  // прищур, что в titles.js:openTitleDetail.
  const det = d.details && !Array.isArray(d.details) ? d.details : null;
  const poster = d.poster_url ? imgProxy(d.poster_url) : "";
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
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.right + 10;
  if (left + popRect.width > window.innerWidth - 8) left = rect.left - popRect.width - 10;
  if (left < 8) left = Math.max(8, window.innerWidth - popRect.width - 8);
  let top = rect.top;
  if (top + popRect.height > window.innerHeight - 8) top = window.innerHeight - popRect.height - 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

async function loadAndShow(anchor, titleId) {
  let data = cache.get(titleId);
  if (!data) {
    try {
      data = await apiGet(`/public/titles/${titleId}`);
      cache.set(titleId, data);
    } catch (_) {
      return; // необязательная подсказка — молча не показываем при ошибке сети
    }
  }
  if (currentId !== titleId) return; // за время запроса курсор уже увели на другой тайтл
  renderPopover(anchor, data);
}

document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-open-title-detail]");
  if (!el) return;
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
