// Всплывающая карточка при наведении на любой аватар в приложении
// (список, доска, тизер команды, топ-5 на «Обзоре») — краткий взгляд на
// роль/загрузку коллеги без открытия целого профиля (openUserProfile —
// заметно тяжелее, полноценный sheet, это только по клику). Все аватары
// уже несут data-avatar-for (см. avatarHtml в profile.js), поэтому здесь
// один делегированный обработчик на document, а не отдельный слушатель
// на каждую аватарку — их на доске/в списке легко наберётся десятки.

import { apiGet } from "./api.js";
import { esc } from "./utils.js";

const HOVER_DELAY_MS = 320;
const HIDE_DELAY_MS = 120;
// Данные профиля не меняются за секунды — держим в памяти на сессию,
// чтобы повторное наведение на того же коллегу не било лишним запросом.
const cache = new Map();

let popoverEl = null;
let showTimer = null;
let hideTimer = null;
let currentId = null;

function ensurePopover() {
  if (popoverEl) return popoverEl;
  popoverEl = document.createElement("div");
  popoverEl.className = "avatar-popover";
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
  const pop = ensurePopover();
  pop.innerHTML = `
    <div class="ap-name">${esc(d.display_name || d.name)}${d.is_online ? ' <span class="ap-online" title="в сети"></span>' : ""}</div>
    <div class="ap-role">${esc(d.role || "без роли")}</div>
    <div class="ap-stat">${d.assigned ?? 0} на руках · ${d.completed_total ?? 0} закрыто${d.overdue ? ` · <span class="ap-warn">${d.overdue} просрочено</span>` : ""}</div>
  `;
  pop.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 8;
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

async function loadAndShow(anchor, telegramId) {
  let data = cache.get(telegramId);
  if (!data) {
    try {
      data = await apiGet(`/user/${telegramId}`);
      cache.set(telegramId, data);
    } catch (_) {
      return; // необязательная подсказка — молча не показываем при ошибке сети
    }
  }
  if (currentId !== telegramId) return; // за время запроса курсор уже увели на другого
  renderPopover(anchor, data);
}

document.addEventListener("mouseover", e => {
  const el = e.target.closest("[data-avatar-for]");
  // .xl — большой аватар на самой странице открытого профиля: все эти
  // данные там и так уже на экране целиком, подсказка ни к чему.
  if (!el || el.classList.contains("xl") || !el.dataset.avatarFor) return;
  clearTimeout(hideTimer);
  if (currentId === el.dataset.avatarFor) return;
  clearTimeout(showTimer);
  currentId = el.dataset.avatarFor;
  const telegramId = el.dataset.avatarFor;
  showTimer = setTimeout(() => {
    if (currentId === telegramId) loadAndShow(el, telegramId);
  }, HOVER_DELAY_MS);
});

document.addEventListener("mouseout", e => {
  if (!e.target.closest("[data-avatar-for]")) return;
  clearTimeout(showTimer);
  scheduleHide();
});
