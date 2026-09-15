// Вкладка «Доска» (канбан по статусам, /api/board).
// Список статусов и их порядок приходят прямо в ответе /api/board
// (d.statuses) — не дублируем их отдельной константой на клиенте.
//
// Цветные колонки + перетаскивание карточек между статусами — раньше
// доска была плоской (все колонки серые, перенести карточку можно было
// только через диалог смены статуса из карточки отчёта). Верхняя
// полоска колонки и левая полоска карточки — один и тот же цвет
// статуса (STATUS_COLOR_VAR, те же переменные, что у точки-индикатора
// и у доната на Обзоре/профиле) — глазами отличить колонки друг от
// друга теперь можно без чтения подписи.
//
// Перетаскивание — на Pointer Events, а НЕ на нативном HTML5 Drag and
// Drop (draggable/dragstart/dragover/drop): в реальном WebView2 эти
// события по факту не доставляются надёжно (известный, давний баг —
// https://github.com/MicrosoftEdge/WebView2Feedback/issues/5237,
// dragover/drop просто не срабатывают в части сценариев хостинга) —
// то же самое, что уже было со внешним import map в этом проекте:
// «работает по стандарту» и «работает в конкретном WebView2» —
// разные вещи. Pointer Events (pointerdown/move/up) — обычный,
// надёжно доставляемый в любом Chromium-движке механизм, руками
// реализующий тот же «взял — перенёс — отпустил».

import { apiGet, apiPost, toast, dialogSkeletonHtml } from "./api.js";
import { $, esc, isOverdue, STATUS_DOT_CLASS, STATUS_COLOR_VAR, PRIORITY_LABELS } from "./utils.js";
import { assigneesHtml } from "./reports.js";
import { openReportDetail } from "./report-detail.js";

const PRIORITY_COLOR_VAR = { urgent: "--s-stop", high: "--ember", normal: "--ink-soft", low: "--ink-dim" };
const DRAG_THRESHOLD_PX = 6;

// pointerup снимает .dragging до того, как браузер успевает выстрелить
// следующим click по тому же элементу, поэтому проверять класс внутри
// самого click-обработчика уже поздно — вместо этого запоминаем момент
// окончания настоящего (превысившего порог) драга и в click просто
// смотрим, не только ли что это было — тот же приём, что и у любого
// самодельного drag&drop на pointer events.
const lastDragEndAt = new WeakMap();

function boardCardHtml(r, status) {
  const overdue = isOverdue(r);
  const accent = `var(${STATUS_COLOR_VAR[status] || "--s-draft"})`;
  const prColor = `var(${PRIORITY_COLOR_VAR[r.priority] || "--ink-soft"})`;
  return `
    <div class="board-card" data-open="${esc(r.public_id)}" data-id="${esc(r.public_id)}" style="border-left: 3px solid ${accent};">
      <div class="id">${esc(r.public_id)}</div>
      <div class="ttl">${esc(r.title)}</div>
      ${r.priority ? `<div class="pr" style="color:${prColor};">${r.priority === "urgent" ? "⚡ " : ""}${esc(PRIORITY_LABELS[r.priority] || r.priority)}</div>` : ""}
      <div class="foot">
        ${assigneesHtml(r.assignees)}
        <span class="deadline ${overdue ? "overdue" : ""}">${overdue ? "⏰ " : ""}${esc(r.deadline || "—")}</span>
      </div>
    </div>`;
}

// Ручной drag одной карточки — от pointerdown до pointerup. Ниже
// DRAG_THRESHOLD_PX это просто клик (открываем карточку отчёта),
// выше — тащим клон-«призрак» под курсором и подсвечиваем колонку,
// над которой он сейчас висит (document.elementFromPoint, не события
// самой колонки — с ручным драгом других dragenter/dragover всё равно
// нет).
function wireCardDrag(card) {
  card.addEventListener("pointerdown", downEvent => {
    if (downEvent.button !== 0) return; // только левая кнопка мыши
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    let started = false;
    let ghost = null;
    let overCol = null;

    function onMove(e) {
      if (!started) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
        started = true;
        card.classList.add("dragging");
        const rect = card.getBoundingClientRect();
        ghost = card.cloneNode(true);
        ghost.classList.add("board-card-ghost");
        ghost.style.width = `${rect.width}px`;
        document.body.appendChild(ghost);
        document.body.style.cursor = "grabbing";
      }
      ghost.style.left = `${e.clientX + 14}px`;
      ghost.style.top = `${e.clientY + 14}px`;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const col = under && under.closest(".board-col");
      if (col !== overCol) {
        if (overCol) overCol.classList.remove("drag-over");
        overCol = col;
        if (overCol) overCol.classList.add("drag-over");
      }
    }

    async function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (!started) return; // обычный клик — открыть карточку откроет собственный click-обработчик
      lastDragEndAt.set(card, Date.now());
      card.classList.remove("dragging");
      document.body.style.cursor = "";
      if (ghost) ghost.remove();
      if (overCol) overCol.classList.remove("drag-over");

      const targetStatus = overCol && overCol.dataset.status;
      if (!targetStatus) return;
      try {
        const res = await apiPost(`/report/${encodeURIComponent(card.dataset.id)}/status`, { status: targetStatus });
        if (res.changed) { toast("Статус изменён."); await loadBoard(); }
        else if (res.detail) toast(res.detail, "error");
      } catch (e) {
        toast(`Не удалось перенести карточку: ${e.message}`, "error");
      }
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

function wireBoardCards(root) {
  root.querySelectorAll(".board-card[data-open]").forEach(el => {
    el.addEventListener("click", () => {
      // .dragging навешивается в wireCardDrag только когда движение
      // реально превысило порог — тот же признак «это был драг, не
      // клик» (сам класс уже снят к моменту click, поэтому проверяем
      // его на pointerup чуть раньше — см. lastDragEndAt ниже).
      if (Date.now() - lastDragEndAt.get(el) < 50) return;
      openReportDetail(el.dataset.open);
    });
    wireCardDrag(el);
  });
}

export async function loadBoard() {
  const root = $("#board-body");
  root.innerHTML = dialogSkeletonHtml(4);
  let d;
  try {
    d = await apiGet("/board");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить доску: ${esc(e.message)}</div>`;
    return;
  }
  root.innerHTML = `
    <div class="board">
      ${d.statuses.map(col => `
        <div class="board-col" data-status="${esc(col.status)}" style="border-top: 3px solid var(${STATUS_COLOR_VAR[col.status] || "--s-draft"});">
          <div class="board-col-head">
            <span class="lb"><span class="dot ${STATUS_DOT_CLASS[col.status] || "draft"}"></span>${esc(col.label)}</span>
            <span class="cnt">${col.total}</span>
          </div>
          <div class="board-cards" data-count="${col.reports.length}">
            ${col.reports.length ? col.reports.map(r => boardCardHtml(r, col.status)).join("") : `<div class="board-col-empty">пусто</div>`}
          </div>
          ${col.has_more ? `<button class="btn ghost board-col-more" data-loadmore="${esc(col.status)}">Показать ещё (${col.total - col.reports.length})</button>` : ""}
        </div>
      `).join("")}
    </div>
  `;
  wireBoardCards(root);
  root.querySelectorAll("[data-loadmore]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const status = btn.dataset.loadmore;
      const colEl = root.querySelector(`.board-col[data-status="${status}"]`);
      const cardsEl = colEl.querySelector(".board-cards");
      const offset = parseInt(cardsEl.dataset.count, 10) || 0;
      btn.disabled = true;
      btn.textContent = "Загрузка…";
      try {
        const res = await apiGet(`/board/column/${status}`, { offset, limit: 60 });
        cardsEl.querySelector(".board-col-empty")?.remove();
        cardsEl.insertAdjacentHTML("beforeend", res.reports.map(r => boardCardHtml(r, status)).join(""));
        cardsEl.dataset.count = offset + res.reports.length;
        wireBoardCards(cardsEl);
        if (res.has_more) {
          btn.disabled = false;
          btn.textContent = `Показать ещё (${res.total - offset - res.reports.length})`;
        } else {
          btn.remove();
        }
      } catch (e) {
        toast(`Не удалось догрузить колонку: ${e.message}`, "error");
        btn.disabled = false;
      }
    });
  });
}
