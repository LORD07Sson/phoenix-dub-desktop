// Вкладка «Список»: таблица отчётов, фильтры, сортировка, массовые
// операции, диалоги смены статуса/назначения/приоритета/срока.
//
// Циклическая зависимость с report-detail.js (openReportDetail открывается
// по клику на строку, а из карточки отчёта вызываются диалоги отсюда) —
// это нормально для ES-модулей, пока ничего не вызывается на этапе
// инициализации модуля (только позже, из обработчиков событий).

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast } from "./api.js";
import { $, $all, esc, initials, isOverdue, STATUS_DOT_CLASS, PRIORITY_LABELS } from "./utils.js";
import { openReportDetail } from "./report-detail.js";

export function currentFilters() {
  const params = {
    q: $("#search-input").value.trim(),
    status: $("#status-filter").value,
    priority: $("#priority-filter").value,
    sort: state.sort.field === "public_id" ? "new" : state.sort.field,
    page_size: 100,
  };
  if (state.quickFilter === "mine") params.assignee = "me";
  if (state.quickFilter === "overdue") params.overdue = 1;
  if (state.quickFilter === "unassigned") params.unassigned = 1;
  return params;
}

export async function loadReports() {
  const statusbar = $("#statusbar");
  const skeleton = $("#skeleton");
  const table = $(".content table");
  // Скелетон показываем только если загрузка реально затянулась (>100мс) —
  // иначе на быстром ответе он просто мигнёт туда-обратно.
  // DevSkim: ignore DS172411 — функция, не строка, данные не внешние
  const skeletonTimer = setTimeout(() => {
    skeleton.hidden = false;
    requestAnimationFrame(() => skeleton.classList.add("visible"));
  }, 100);
  table.classList.add("loading");
  try {
    const r = await apiGet("/reports", currentFilters());
    state.reports = r.reports || [];
    state.total = r.total || 0;
    sortLocally();
    renderReports();
  } catch (e) {
    toast(`Не удалось загрузить список: ${e.message}`, "error");
    statusbar.textContent = "Ошибка загрузки.";
  } finally {
    clearTimeout(skeletonTimer);
    skeleton.classList.remove("visible");
    setTimeout(() => { skeleton.hidden = true; }, 180); // DevSkim: ignore DS172411 — функция, не строка
    table.classList.remove("loading");
  }
}

export function sortLocally() {
  const { field, dir } = state.sort;
  const mul = dir === "asc" ? 1 : -1;
  state.reports.sort((a, b) => {
    let av = a[field], bv = b[field];
    if (av == null) av = "";
    if (bv == null) bv = "";
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
}

export function assigneesHtml(list) {
  if (!list || !list.length) return `<span class="no-assignee">не назначен</span>`;
  const shown = list.slice(0, 3);
  const bubbles = shown.map(a => `<span class="avatar-bubble" data-avatar-for="${a.telegram_id}" title="${esc(a.name)}">${esc(initials(a.name))}</span>`).join("");
  const more = list.length > 3 ? `<span class="avatar-more">+${list.length - 3}</span>` : "";
  return `<span class="avatar-stack">${bubbles}</span>${more}`;
}

export function renderReports() {
  const tbody = $("#reports-body");
  tbody.innerHTML = "";
  const empty = $("#empty-state");
  empty.hidden = state.reports.length > 0;

  state.reports.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.publicId = r.public_id;
    if (state.selected.has(r.public_id)) tr.classList.add("selected");
    // Stagger: строки появляются с небольшой нарастающей задержкой, а не все разом.
    // Ограничиваем задержку первыми ~18 строками, чтобы длинные списки не "доезжали" целую вечность.
    tr.classList.add("row-in");
    tr.style.animationDelay = `${Math.min(i, 18) * 22}ms`;
    const dotClass = STATUS_DOT_CLASS[r.status] || "draft";
    const overdue = isOverdue(r);
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-check" ${state.selected.has(r.public_id) ? "checked" : ""}></td>
      <td class="num">${esc(r.public_id)}</td>
      <td>${esc(r.title)}</td>
      <td><span class="chip"><span class="dot ${dotClass}"></span>${esc(r.status_label)}</span></td>
      <td><span class="priority-chip ${esc(r.priority)}"><span class="dot"></span>${esc(r.priority_label)}</span></td>
      <td class="deadline ${overdue ? "overdue" : ""}">${overdue ? "⏰ " : ""}${esc(r.deadline || "без срока")}</td>
      <td>${assigneesHtml(r.assignees)}</td>
      <td class="row-actions">
        <button class="icon-btn" data-quick-assign title="Назначить">👤</button>
        <button class="icon-btn" data-quick-status title="Сменить статус">✓</button>
      </td>
    `;
    tr.querySelector(".row-check").addEventListener("click", e => {
      e.stopPropagation();
      toggleSelected(r.public_id, e.target.checked);
    });
    // Быстрые действия по наведению на строку — открывают тот же диалог,
    // что и чип на карточке отчёта, просто без похода внутрь карточки.
    // stopPropagation — иначе клик по кнопке ещё и открыл бы саму карточку.
    tr.querySelector("[data-quick-assign]").addEventListener("click", e => {
      e.stopPropagation();
      assignDialog([r.public_id], () => loadReports());
    });
    tr.querySelector("[data-quick-status]").addEventListener("click", e => {
      e.stopPropagation();
      changeStatusDialog([r.public_id], () => loadReports());
    });
    tr.addEventListener("click", () => openReportDetail(r.public_id));
    tbody.appendChild(tr);
  });

  $("#statusbar").textContent =
    `Отчётов: ${state.reports.length} из ${state.total} · клик по строке — открыть карточку, ` +
    `чекбоксы — массовые операции · Ctrl+Shift+P — показать/скрыть окно из любого места`;

  $("#select-all").checked = state.reports.length > 0 && state.reports.every(r => state.selected.has(r.public_id));
  updateBulkBar();
}

export function toggleSelected(publicId, on) {
  if (on) state.selected.add(publicId);
  else state.selected.delete(publicId);
  const tr = $all("#reports-body tr").find(t => t.dataset.publicId === publicId);
  if (tr) tr.classList.toggle("selected", on);
  $("#select-all").checked = state.reports.length > 0 && state.reports.every(r => state.selected.has(r.public_id));
  updateBulkBar();
}

$("#select-all").addEventListener("change", e => {
  const on = e.target.checked;
  for (const r of state.reports) {
    if (on) state.selected.add(r.public_id); else state.selected.delete(r.public_id);
  }
  renderReports();
});

function updateBulkBar() {
  const bar = $("#bulk-bar");
  const n = state.selected.size;
  bar.hidden = n === 0;
  $("#bulk-count").textContent = n;
}

$("#bulk-clear").addEventListener("click", () => {
  state.selected.clear();
  renderReports();
});

let searchDebounce = null;
$("#search-input").addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadReports, 320); // DevSkim: ignore DS172411 — функция, не строка
});
$("#search-input").addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(searchDebounce); loadReports(); } });
$("#status-filter").addEventListener("change", loadReports);
$("#priority-filter").addEventListener("change", loadReports);

$all(".qf-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const key = chip.dataset.qf;
    state.quickFilter = state.quickFilter === key ? null : key;
    $all(".qf-chip").forEach(c => c.classList.toggle("active", c.dataset.qf === state.quickFilter));
    loadReports();
  });
});

// Ctrl+F — фокус на поиск; Escape — закрыть верхнюю модалку.
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    $("#search-input").focus();
    $("#search-input").select();
  } else if (e.key === "Escape") {
    const overlays = $all(".overlay");
    if (overlays.length) overlays[overlays.length - 1].remove();
  }
});

$all("thead th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    const field = th.dataset.sort;
    if (state.sort.field === field) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort = { field, dir: "asc" };
    }
    $all("thead th").forEach(t => t.classList.remove("sorted", "asc"));
    th.classList.add("sorted");
    if (state.sort.dir === "asc") th.classList.add("asc");
    sortLocally();
    renderReports();
  });
});

// ---------- смена статуса / назначение / приоритет / срок ----------

function statusOptionsHtml(selected) {
  return state.statusOptions.map(([v, label]) =>
    `<option value="${v}" ${v === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function usersOptionsHtml() {
  if (!state.users.length) return `<option value="">Нет доступных исполнителей</option>`;
  return state.users.map(u => `<option value="${u.telegram_id}">${esc(u.name)}</option>`).join("");
}

export function changeStatusDialog(publicIds, onDone) {
  const overlay = openSheet(`
    <h2>Сменить статус — ${publicIds.length > 1 ? publicIds.length + " отчётов" : publicIds[0]}</h2>
    <div class="row"><select id="dlg-status">${statusOptionsHtml()}</select></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Применить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const status = overlay.querySelector("#dlg-status").value;
    try {
      if (publicIds.length === 1) {
        await apiPost(`/report/${publicIds[0]}/status`, { status, comment: "" });
      } else {
        await apiPost("/reports/bulk/status", { public_ids: publicIds, status });
      }
      toast("Статус обновлён.");
      overlay.remove();
      state.selected.clear();
      await loadReports();
      if (onDone) await onDone();
    } catch (e) {
      toast(`Не удалось сменить статус: ${e.message}`, "error");
    }
  });
}

export function assignDialog(publicIds, onDone) {
  const overlay = openSheet(`
    <h2>Назначить исполнителя — ${publicIds.length > 1 ? publicIds.length + " отчётов" : publicIds[0]}</h2>
    <div class="row"><select id="dlg-user">${usersOptionsHtml()}</select></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Назначить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const telegramId = Number(overlay.querySelector("#dlg-user").value);
    if (!telegramId) return;
    try {
      if (publicIds.length === 1) {
        await apiPost(`/report/${publicIds[0]}/assign`, { telegram_id: telegramId });
      } else {
        await apiPost("/reports/bulk/assign", { public_ids: publicIds, telegram_id: telegramId });
      }
      toast("Исполнитель назначен.");
      overlay.remove();
      state.selected.clear();
      await loadReports();
      if (onDone) await onDone();
    } catch (e) {
      toast(`Не удалось назначить: ${e.message}`, "error");
    }
  });
}

export function priorityDialog(publicId, onDone) {
  const overlay = openSheet(`
    <h2>Приоритет — ${publicId}</h2>
    <div class="row"><select id="dlg-priority">${Object.entries(PRIORITY_LABELS).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Применить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    try {
      await apiPost(`/report/${publicId}/details`, { priority: overlay.querySelector("#dlg-priority").value });
      toast("Приоритет обновлён.");
      overlay.remove();
      await loadReports();
      if (onDone) await onDone();
    } catch (e) { toast(`Не удалось изменить приоритет: ${e.message}`, "error"); }
  });
}

export function deadlineDialog(publicId, current, onDone) {
  const overlay = openSheet(`
    <h2>Срок — ${publicId}</h2>
    <div class="row"><input type="date" id="dlg-deadline" value="${esc(current || "")}"></div>
    <div class="sheet-actions">
      <button class="btn ghost" id="dlg-clear">Убрать срок</button>
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Сохранить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-clear").addEventListener("click", async () => {
    try {
      await apiPost(`/report/${publicId}/details`, { clear_deadline: true });
      toast("Срок убран.");
      overlay.remove();
      await loadReports();
      if (onDone) await onDone();
    } catch (e) { toast(`Не удалось убрать срок: ${e.message}`, "error"); }
  });
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const val = overlay.querySelector("#dlg-deadline").value;
    if (!val) return;
    try {
      await apiPost(`/report/${publicId}/details`, { deadline: val });
      toast("Срок обновлён.");
      overlay.remove();
      await loadReports();
      if (onDone) await onDone();
    } catch (e) { toast(`Не удалось изменить срок: ${e.message}`, "error"); }
  });
}

$("#bulk-status").addEventListener("click", () => changeStatusDialog([...state.selected]));
$("#bulk-assign").addEventListener("click", () => assignDialog([...state.selected]));
