// Вкладка «Доска» (канбан по статусам, /api/board).
// Список статусов и их порядок приходят прямо в ответе /api/board
// (d.statuses) — не дублируем их отдельной константой на клиенте.
//
// Цветные колонки + drag&drop карточек между статусами — раньше доска
// была плоской (все колонки серые, перенести карточку можно было
// только через диалог смены статуса из карточки отчёта). Верхняя
// полоска колонки и левая полоска карточки — один и тот же цвет
// статуса (STATUS_COLOR_VAR, те же переменные, что у точки-индикатора
// и у доната на Обзоре/профиле) — глазами отличить колонки друг от
// друга теперь можно без чтения подписи.

import { apiGet, apiPost, toast, dialogSkeletonHtml } from "./api.js";
import { $, esc, isOverdue, STATUS_DOT_CLASS, STATUS_COLOR_VAR, PRIORITY_LABELS } from "./utils.js";
import { assigneesHtml } from "./reports.js";
import { openReportDetail } from "./report-detail.js";

const PRIORITY_COLOR_VAR = { urgent: "--s-stop", high: "--ember", normal: "--ink-soft", low: "--ink-dim" };

function boardCardHtml(r, status) {
  const overdue = isOverdue(r);
  const accent = `var(${STATUS_COLOR_VAR[status] || "--s-draft"})`;
  const prColor = `var(${PRIORITY_COLOR_VAR[r.priority] || "--ink-soft"})`;
  return `
    <div class="board-card" draggable="true" data-open="${esc(r.public_id)}" data-id="${esc(r.public_id)}" style="border-left: 3px solid ${accent};">
      <div class="id">${esc(r.public_id)}</div>
      <div class="ttl">${esc(r.title)}</div>
      ${r.priority ? `<div class="pr" style="color:${prColor};">${r.priority === "urgent" ? "⚡ " : ""}${esc(PRIORITY_LABELS[r.priority] || r.priority)}</div>` : ""}
      <div class="foot">
        ${assigneesHtml(r.assignees)}
        <span class="deadline ${overdue ? "overdue" : ""}">${overdue ? "⏰ " : ""}${esc(r.deadline || "—")}</span>
      </div>
    </div>`;
}

function wireBoardCards(root) {
  root.querySelectorAll(".board-card[data-open]").forEach(el => {
    el.addEventListener("click", () => openReportDetail(el.dataset.open));
    el.addEventListener("dragstart", e => {
      e.dataTransfer.setData("text/plain", el.dataset.id);
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });
}

// Один статус, за который сейчас "отвечает" перетаскиваемая карточка —
// чтобы отличить настоящий drop от простого клика (dragstart всегда
// стреляет чуть раньше click, поэтому клик по карточке всё равно
// открывает карточку отчёта, а не путается с перетаскиванием).
function wireDropZone(colEl, status, onDropped) {
  colEl.addEventListener("dragover", e => {
    e.preventDefault();
    colEl.classList.add("drag-over");
  });
  colEl.addEventListener("dragleave", () => colEl.classList.remove("drag-over"));
  colEl.addEventListener("drop", async e => {
    e.preventDefault();
    colEl.classList.remove("drag-over");
    const publicId = e.dataTransfer.getData("text/plain");
    if (!publicId) return;
    try {
      const res = await apiPost(`/report/${encodeURIComponent(publicId)}/status`, { status });
      if (res.changed) {
        toast("Статус изменён.");
        await onDropped();
      } else if (res.detail) {
        toast(res.detail, "error");
      }
    } catch (e2) {
      toast(`Не удалось перенести карточку: ${e2.message}`, "error");
    }
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
  root.querySelectorAll(".board-col").forEach(colEl => {
    wireDropZone(colEl, colEl.dataset.status, () => loadBoard());
  });
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
