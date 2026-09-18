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
import { invoke } from "./tauri.js";
import { $, esc, STATUS_DOT_CLASS, STATUS_COLOR_VAR, PRIORITY_LABELS } from "./utils.js";
import { assigneesHtml } from "./reports.js";
import { openReportDetail } from "./report-detail.js";
import { state } from "./state.js";

// Свёрнутые колонки — узкая студия часто держит "Завершено"/"Отменено"
// сложенными: сами по себе они редко нужны, но занимают на широкой
// доске столько же места, сколько активные статусы. Чисто локальное
// предпочтение раскладки (у API нет и не должно быть такого поля) —
// живёт в localStorage на пользователя, тем же приёмом, что избранное
// в списке (см. favorites.js).
function collapsedKey() { return `phoenix_board_collapsed_${state.telegramId || "anon"}`; }
function readCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(collapsedKey()) || "[]")); } catch (_) { return new Set(); }
}
function writeCollapsed(set) {
  try { localStorage.setItem(collapsedKey(), JSON.stringify([...set])); } catch (_) { /* не критично */ }
}

const PRIORITY_COLOR_VAR = { urgent: "--s-stop", high: "--ember", normal: "--ink-soft", low: "--ink-dim" };
const DRAG_THRESHOLD_PX = 6;

// pointerup снимает .dragging до того, как браузер успевает выстрелить
// следующим click по тому же элементу, поэтому проверять класс внутри
// самого click-обработчика уже поздно — вместо этого запоминаем момент
// окончания настоящего (превысившего порог) драга и в click просто
// смотрим, не только ли что это было — тот же приём, что и у любого
// самодельного drag&drop на pointer events.
const lastDragEndAt = new WeakMap();

// Настройки вида доски — сортировка и поиск. Как и свёрнутые колонки,
// это личное предпочтение раскладки, у API такого поля нет и не должно
// быть.
const SORTS = [
  ["smart", "🔥 По срочности"],
  ["deadline", "📅 По сроку"],
  ["priority", "⚡ По приоритету"],
  ["age", "🕸 По давности"],
  ["none", "↕ Как на сервере"],
];
// Сколько карточек в статусе считаем перебором. Значения «на глаз» для
// студии из нескольких человек: больше — верный признак, что работу
// набрали в параллель и ничего не доводят.
const WIP_LIMITS = { working: 8, review: 6, revision: 6 };
const STALE_AFTER_DAYS = 7;

function sortKey() { return `phoenix_board_sort_${state.telegramId || "anon"}`; }
function readSort() {
  try { return localStorage.getItem(sortKey()) || "smart"; } catch (_) { return "smart"; }
}
function writeSort(value) {
  try { localStorage.setItem(sortKey(), value); } catch (_) { /* не критично */ }
}

const boardView = { sort: readSort(), query: "" };
// Последний ответ сервера — чтобы пересортировать и отфильтровать доску
// мгновенно, не ходя за теми же данными второй раз.
let lastBoardData = null;

// Сегодняшняя дата глазами клиента: «просрочено» должно считаться по
// местному календарю студии, а не по часовому поясу процесса.
function todayLocal() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function layoutRequest(columns) {
  return invoke("board_layout", {
    columns,
    view: {
      sort: boardView.sort,
      query: boardView.query,
      today: todayLocal(),
      wipLimits: WIP_LIMITS,
      staleAfterDays: STALE_AFTER_DAYS,
    },
  });
}

// Срок словами, а не голой датой: «через 2 дня» читается с одного
// взгляда, «2026-09-20» требует посчитать в уме.
function deadlineLabel(c) {
  if (c.deadline == null) return "без срока";
  if (c.daysLeft == null) return c.deadline;
  if (c.daysLeft < -1) return `просрочено на ${-c.daysLeft} дн.`;
  if (c.daysLeft === -1) return "просрочено вчера";
  if (c.daysLeft === 0) return "сегодня";
  if (c.daysLeft === 1) return "завтра";
  if (c.daysLeft <= 14) return `через ${c.daysLeft} дн.`;
  return c.deadline;
}

function boardCardHtml(c, status) {
  const accent = `var(${STATUS_COLOR_VAR[status] || "--s-draft"})`;
  const prColor = `var(${PRIORITY_COLOR_VAR[c.priority] || "--ink-soft"})`;
  // Полоска слева — не просто цвет статуса: её насыщенность показывает
  // срочность (heat считает board.rs). Раньше все карточки колонки
  // выглядели одинаково, и «что горит» приходилось искать глазами по
  // датам.
  const heat = Math.max(0, Math.min(1, c.heat || 0));
  return `
    <div class="board-card${c.overdue ? " is-overdue" : ""}${c.stale ? " is-stale" : ""}"
         data-open="${esc(c.publicId)}" data-id="${esc(c.publicId)}" data-status="${esc(status)}"
         style="--accent-dot: ${accent}; --heat: ${heat.toFixed(3)};">
      <span class="board-card-heat" style="background:${accent};"></span>
      <div class="board-card-top">
        <span class="id">${esc(c.publicId)}</span>
        ${c.priority ? `<span class="pr-badge" style="color:${prColor}; border-color:${prColor};">${c.priority === "urgent" ? "⚡ " : ""}${esc(PRIORITY_LABELS[c.priority] || c.priority)}</span>` : ""}
      </div>
      <div class="ttl">${esc(c.title)}</div>
      <div class="foot">
        ${assigneesHtml(c.assignees)}
        <span class="deadline-pill ${c.overdue ? "overdue" : ""}" title="${esc(c.deadline || "срок не назначен")}">${c.overdue ? "⏰ " : "📅 "}${esc(deadlineLabel(c))}</span>
      </div>
      ${c.stale || c.unassigned ? `<div class="board-card-flags">
        ${c.stale ? `<span class="board-flag stale" title="Ничего не менялось ${c.ageDays} дн.">🕸 ${c.ageDays} дн. без движения</span>` : ""}
        ${c.unassigned ? `<span class="board-flag free" title="Исполнитель не назначен">👤 без исполнителя</span>` : ""}
      </div>` : ""}
    </div>`;
}

// Ручной drag одной карточки — от pointerdown до pointerup.
//
// Мышь: как и было. Ниже DRAG_THRESHOLD_PX это просто клик (открываем
// карточку отчёта), выше — тащим клон-«призрак» под курсором и
// подсвечиваем колонку, над которой он сейчас висит
// (document.elementFromPoint, не события самой колонки — с ручным
// драгом других dragenter/dragover всё равно нет).
//
// Палец/перо: жест сначала считается прокруткой доски, как в телефоне —
// повёл пальцем по любому месту, включая карточки, и доска едет влево/
// вправо. Иначе прокрутить было почти невозможно: карточками занята вся
// площадь колонок, а зажатие на них начинало перенос. Перенести карточку
// пальцем можно после удержания на месте (LONG_PRESS_MS) — ровно та же
// схема, что в мобильных канбан-досках.
//
// Почему не «горизонтально = прокрутка» и для мыши тоже: перенос
// карточки в соседнюю колонку по своей природе горизонтальный, так что
// на мыши это отобрало бы главный жест доски.
const LONG_PRESS_MS = 350;

function wireCardDrag(card) {
  card.addEventListener("pointerdown", downEvent => {
    if (downEvent.button !== 0) return; // только левая кнопка мыши
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const boardEl = card.closest(".board");
    const byTouch = downEvent.pointerType !== "mouse";
    // "pending" — ещё не решили, прокрутка это или перенос (только палец);
    // "pan" — тянем доску; "card" — тащим карточку.
    let mode = byTouch ? "pending" : "card";
    let dragging = false; // карточка реально поехала
    let panned = false;   // доску реально сдвинули
    let ghost = null;
    let overCol = null;
    let holdTimer = null;
    const startScroll = boardEl ? boardEl.scrollLeft : 0;

    // Захват указателя на самой карточке — без него в реальном
    // WebView2 pointermove/pointerup, навешанные на window, иногда не
    // доставляются, если курсор хоть на миг ушёл не над тем элементом
    // (тот же класс проблем, что раньше был у нативного HTML5 drag&drop,
    // см. комментарий над файлом). setPointerCapture жёстко привязывает
    // все последующие события этого pointerId к card, независимо от
    // того, что реально под курсором.
    card.setPointerCapture(downEvent.pointerId);

    function moveGhost(x, y) {
      ghost.style.left = `${x + 14}px`;
      ghost.style.top = `${y + 14}px`;
      const under = document.elementFromPoint(x, y);
      const col = under && under.closest(".board-col");
      if (col !== overCol) {
        if (overCol) overCol.classList.remove("drag-over");
        overCol = col;
        if (overCol) overCol.classList.add("drag-over");
      }
    }

    function beginCardDrag(x, y) {
      dragging = true;
      card.classList.add("dragging");
      const rect = card.getBoundingClientRect();
      ghost = card.cloneNode(true);
      ghost.classList.add("board-card-ghost");
      ghost.style.width = `${rect.width}px`;
      document.body.appendChild(ghost);
      document.body.style.cursor = "grabbing";
      moveGhost(x, y);
    }

    if (byTouch) {
      holdTimer = setTimeout(() => { // DevSkim: ignore DS172411 — функция, не строка
        holdTimer = null;
        if (mode !== "pending") return;
        mode = "card";
        // Палец всё это время стоял на месте, значит браузер жест ещё не
        // классифицировал — можно забрать его себе целиком, вместе с
        // вертикалью (иначе перенос карточки вверх/вниз уехал бы в
        // прокрутку страницы, см. touch-action: pan-y в styles.css).
        card.style.touchAction = "none";
        beginCardDrag(startX, startY);
      }, LONG_PRESS_MS);
    }

    function endPanVisuals() {
      if (!boardEl) return;
      boardEl.classList.remove("panning");
      boardEl.style.scrollBehavior = "smooth"; // вернуть плавность колесу мыши
    }

    function onMove(e) {
      if (e.pointerId !== downEvent.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (mode === "pending") {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        // Повели раньше, чем сработало удержание — это прокрутка.
        clearTimeout(holdTimer);
        holdTimer = null;
        mode = "pan";
        if (boardEl) {
          boardEl.classList.add("panning");
          // 1:1 за пальцем, без анимации — как и в wireBoardScroll.
          boardEl.style.scrollBehavior = "auto";
        }
      }

      if (mode === "pan") {
        if (!boardEl) return;
        panned = true;
        boardEl.scrollLeft = startScroll - dx;
        return;
      }

      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        beginCardDrag(e.clientX, e.clientY);
        return;
      }
      moveGhost(e.clientX, e.clientY);
    }

    async function onUp(e) {
      if (e.pointerId !== downEvent.pointerId) return;
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (card.hasPointerCapture(downEvent.pointerId)) card.releasePointerCapture(downEvent.pointerId);
      card.style.touchAction = "";

      if (mode === "pan") {
        endPanVisuals();
        // Пролистнули доску пальцем — это не тап по карточке, открывать
        // отчёт не надо (тот же признак, что и у настоящего драга).
        if (panned) lastDragEndAt.set(card, Date.now());
        return;
      }
      if (!dragging) return; // обычный клик/тап — карточку откроет собственный click-обработчик
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

function columnBadgesHtml(col) {
  const badges = [];
  if (col.overdue) badges.push(`<span class="board-col-badge late" title="Просрочено">⏰ ${col.overdue}</span>`);
  if (col.stale) badges.push(`<span class="board-col-badge stale" title="Без движения больше ${STALE_AFTER_DAYS} дн.">🕸 ${col.stale}</span>`);
  if (col.unassigned) badges.push(`<span class="board-col-badge free" title="Без исполнителя">👤 ${col.unassigned}</span>`);
  return badges.join("");
}

function boardToolbarHtml(layout) {
  const summary = [];
  if (layout.totalOverdue) summary.push(`<span class="board-sum late">⏰ ${layout.totalOverdue} просрочено</span>`);
  if (layout.totalStale) summary.push(`<span class="board-sum stale">🕸 ${layout.totalStale} без движения</span>`);
  if (!summary.length) summary.push(`<span class="board-sum ok">✓ всё в сроках</span>`);
  return `
    <div class="board-toolbar">
      <label class="board-search">
        <span aria-hidden="true">🔎</span>
        <input type="search" id="board-search" placeholder="Номер или название" value="${esc(boardView.query)}" autocomplete="off">
      </label>
      <select id="board-sort" class="board-sort" title="Порядок карточек в колонках">
        ${SORTS.map(([v, l]) => `<option value="${v}" ${v === boardView.sort ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
      <div class="board-summary">${summary.join("")}</div>
    </div>`;
}

function columnHtml(col, collapsed) {
  const colorVar = STATUS_COLOR_VAR[col.status] || "--s-draft";
  // Полоска заполнения показывает, какая часть колонки уже загружена
  // (колонки подгружаются порциями), а не долю выполнения.
  const loaded = col.total ? Math.round((col.cards.length / col.total) * 100) : 100;
  return `
    <div class="board-col ${collapsed.has(col.status) ? "collapsed" : ""}${col.overWip ? " over-wip" : ""}"
         data-status="${esc(col.status)}" style="--col-accent: var(${colorVar});">
      <div class="board-col-head">
        <span class="lb"><span class="dot ${STATUS_DOT_CLASS[col.status] || "draft"}"></span>${esc(col.label)}</span>
        <span class="cnt${col.overWip ? " over" : ""}" title="${col.overWip ? `Больше ${col.wipLimit} в работе одновременно — многовато` : "Всего в статусе"}">${col.total}${col.overWip ? ` / ${col.wipLimit}` : ""}</span>
        <button class="board-col-collapse" data-collapse="${esc(col.status)}" title="Свернуть/развернуть колонку">‹</button>
      </div>
      ${columnBadgesHtml(col) ? `<div class="board-col-badges">${columnBadgesHtml(col)}</div>` : ""}
      <div class="board-col-progress"><i style="width:${loaded}%; background:var(${colorVar});"></i></div>
      <div class="board-cards" data-count="${col.cards.length}">
        ${col.cards.length ? col.cards.map(c => boardCardHtml(c, col.status)).join("") : `<div class="board-col-empty">${boardView.query ? "ничего не нашлось" : "пусто"}</div>`}
      </div>
      ${col.hasMore ? `<button class="btn ghost board-col-more" data-loadmore="${esc(col.status)}">Показать ещё (${col.total - col.cards.length})</button>` : ""}
    </div>`;
}

// Перерисовка доски из уже полученных данных — без похода на сервер.
// Нужна поиску и переключателю сортировки: оба меняют только раскладку.
async function renderBoard(root) {
  if (!lastBoardData) return;
  let layout;
  try {
    layout = await layoutRequest(lastBoardData.statuses);
  } catch (e) {
    // Раскладку считает бэкенд (board_layout), и если он почему-то не
    // ответил, честнее сказать об этом, чем оставить пустую доску,
    // неотличимую от «у вас нет отчётов».
    root.innerHTML = `<div class="bento-empty">Не удалось разложить доску: ${esc(e.message || e)}</div>`;
    return;
  }
  if (!layout || !Array.isArray(layout.columns)) {
    root.innerHTML = `<div class="bento-empty">Доска вернулась в непонятном виде — попробуйте обновить.</div>`;
    return;
  }
  const collapsed = readCollapsed();
  root.innerHTML = `
    ${boardToolbarHtml(layout)}
    <div class="board">${layout.columns.map(col => columnHtml(col, collapsed)).join("")}</div>
  `;
  wireBoardCards(root);
  wireBoardScroll(root.querySelector(".board"));
  wireBoardToolbar(root);
  wireColumnButtons(root);
}

function wireBoardToolbar(root) {
  const search = root.querySelector("#board-search");
  const sort = root.querySelector("#board-sort");
  if (sort) sort.addEventListener("change", () => {
    boardView.sort = sort.value;
    writeSort(boardView.sort);
    renderBoard(root);
  });
  if (search) {
    // Дебаунс: перерисовка доски на каждое нажатие клавиши крала бы
    // фокус и дёргала раскладку под пальцами.
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer); // DevSkim: ignore DS172411 — функция, не строка
      timer = setTimeout(async () => { // DevSkim: ignore DS172411 — функция, не строка
        boardView.query = search.value;
        await renderBoard(root);
        // После перерисовки поле — новый узел, возвращаем в него курсор.
        const again = root.querySelector("#board-search");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      }, 180);
    });
  }
}

function wireColumnButtons(root) {
  root.querySelectorAll("[data-collapse]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const status = btn.dataset.collapse;
      const colEl = root.querySelector(`.board-col[data-status="${status}"]`);
      const set = readCollapsed();
      const now = colEl.classList.toggle("collapsed");
      if (now) set.add(status); else set.delete(status);
      writeCollapsed(set);
    });
  });
  root.querySelectorAll("[data-loadmore]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const status = btn.dataset.loadmore;
      const column = lastBoardData.statuses.find(c => c.status === status);
      const offset = column ? column.reports.length : 0;
      btn.disabled = true;
      btn.textContent = "Загрузка…";
      try {
        const res = await apiGet(`/board/column/${status}`, { offset, limit: 60 });
        // Догруженное уходит в тот же кэш и проходит ту же раскладку —
        // иначе новые карточки встали бы в конец колонки без сортировки
        // и без отметок «просрочено», в отличие от уже показанных.
        if (column) {
          column.reports = column.reports.concat(res.reports);
          column.has_more = res.has_more;
          column.total = res.total ?? column.total;
        }
        await renderBoard(root);
      } catch (e) {
        toast(`Не удалось догрузить колонку: ${e.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Показать ещё";
      }
    });
  });
}

export async function loadBoard() {
  const root = $("#board-body");
  root.innerHTML = dialogSkeletonHtml(5, "cards");
  try {
    lastBoardData = await apiGet("/board");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить доску: ${esc(e.message)}</div>`;
    return false;
  }
  await renderBoard(root);
}
