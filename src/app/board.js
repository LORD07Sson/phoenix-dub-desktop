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
    <div class="board-card" data-open="${esc(r.public_id)}" data-id="${esc(r.public_id)}" data-status="${esc(status)}" style="border-left: 3px solid ${accent};">
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

    // Захват указателя на самой карточке — без него в реальном
    // WebView2 pointermove/pointerup, навешанные на window, иногда не
    // доставляются, если курсор хоть на миг ушёл не над тем элементом
    // (тот же класс проблем, что раньше был у нативного HTML5 drag&drop,
    // см. комментарий над файлом). setPointerCapture жёстко привязывает
    // все последующие события этого pointerId к card, независимо от
    // того, что реально под курсором.
    card.setPointerCapture(downEvent.pointerId);

    function onMove(e) {
      if (e.pointerId !== downEvent.pointerId) return;
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

    async function onUp(e) {
      if (e.pointerId !== downEvent.pointerId) return;
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      if (card.hasPointerCapture(downEvent.pointerId)) card.releasePointerCapture(downEvent.pointerId);
      if (!started) return; // обычный клик — открыть карточку откроет собственный click-обработчик
      lastDragEndAt.set(card, Date.now());
      card.classList.remove("dragging");
      document.body.style.cursor = "";
      if (ghost) ghost.remove();
      if (overCol) overCol.classList.remove("drag-over");

      const targetStatus = overCol && overCol.dataset.status;
      // Бросили обратно в ту же колонку — это не перенос, дёргать
      // сервер (и перезагружать всю доску) незачем.
      if (!targetStatus || targetStatus === card.dataset.status) return;
      try {
        const res = await apiPost(`/report/${encodeURIComponent(card.dataset.id)}/status`, { status: targetStatus });
        if (res.changed) { toast("Статус изменён."); await loadBoard(); }
        else if (res.detail) toast(res.detail, "error");
      } catch (e) {
        toast(`Не удалось перенести карточку: ${e.message}`, "error");
      }
    }

    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  });
}

// Колонок обычно больше, чем видно в окне (board шире, чем экран,
// overflow-x: auto) — но колесо мыши по умолчанию крутит только
// вертикаль, а внутри .board вертикального переполнения нет, поэтому
// без этого доска выглядела «нельзя прокрутить». Переводим вертикальный
// скролл колеса в горизонтальный (как в Trello/Notion), плюс drag
// пустого места доски левой кнопкой — тоже горизонтальный скролл, не
// перенос карточки (обработчик карточек — отдельный, wireCardDrag).
function wireBoardScroll(boardEl) {
  if (!boardEl) return;
  boardEl.addEventListener("wheel", e => {
    if (e.deltaY === 0) return;
    // Трекпад с горизонтальным жестом шлёт deltaX сам — не мешаем ему.
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    boardEl.scrollLeft += e.deltaY;
  }, { passive: false });

  let panning = false;
  let panPointerId = null;
  let startX = 0;
  let startScroll = 0;
  boardEl.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest(".board-card")) return;
    panning = true;
    panPointerId = e.pointerId;
    startX = e.clientX;
    startScroll = boardEl.scrollLeft;
    boardEl.classList.add("panning");
    // scroll-behavior:smooth (CSS) — только для колеса мыши; во время
    // ручного драга доска должна 1:1 следовать за курсором без
    // задержки на анимацию, иначе будет ощутимо отставать от руки.
    boardEl.style.scrollBehavior = "auto";
    // Захват указателя на самой доске — без него в реальном WebView2
    // pointermove/pointerup (были на window) иногда не доставлялись
    // надёжно, если курсор хоть на миг ушёл не над тем элементом (тот
    // же класс проблем, что раньше был у нативного HTML5 drag&drop,
    // см. комментарий над файлом).
    boardEl.setPointerCapture(e.pointerId);
  });
  boardEl.addEventListener("pointermove", e => {
    if (!panning || e.pointerId !== panPointerId) return;
    boardEl.scrollLeft = startScroll - (e.clientX - startX);
  });
  function endPan(e) {
    if (e.pointerId !== panPointerId) return;
    panning = false;
    boardEl.classList.remove("panning");
    boardEl.style.scrollBehavior = "smooth"; // вернуть плавность для колеса мыши
    if (boardEl.hasPointerCapture(panPointerId)) boardEl.releasePointerCapture(panPointerId);
  }
  boardEl.addEventListener("pointerup", endPan);
  boardEl.addEventListener("pointercancel", endPan);
}

// :not([data-wired]) — после «Показать ещё» сюда приходит контейнер
// колонки целиком, вместе с уже привязанными карточками: без фильтра
// каждая догрузка вешала им ВТОРОЙ обработчик клика и второй драг, и
// клик по старой карточке открывал карточку отчёта дважды.
function wireBoardCards(root) {
  root.querySelectorAll(".board-card[data-open]:not([data-wired])").forEach(el => {
    el.dataset.wired = "1";
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
    return false;
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
  wireBoardScroll(root.querySelector(".board"));
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
