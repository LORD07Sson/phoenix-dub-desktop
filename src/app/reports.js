// Вкладка «Список»: таблица отчётов, фильтры, сортировка, массовые
// операции, диалоги смены статуса/назначения/приоритета/срока.
//
// Циклическая зависимость с report-detail.js (openReportDetail открывается
// по клику на строку, а из карточки отчёта вызываются диалоги отсюда) —
// это нормально для ES-модулей, пока ничего не вызывается на этапе
// инициализации модуля (только позже, из обработчиков событий).

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast } from "./api.js";
import { $, $all, esc, initials, isOverdue, STATUS_DOT_CLASS, PRIORITY_LABELS, showContextMenu } from "./utils.js";
import { openReportDetail } from "./report-detail.js";
import { isFavorite, toggleFavorite, favoriteIds } from "./favorites.js";

// page_size=100 — сервер отдаёт максимум одну страницу, offset для
// /reports в API не предусмотрен (см. docs/API.md), поэтому при
// большем числе отчётов работает фильтр, а не листание; статусбар
// теперь говорит об этом прямо, а не рисует «100 из 350» без объяснений.
export const PAGE_SIZE = 100;

export function currentFilters() {
  const params = {
    // Сортировку по колонкам делает sortLocally() ниже — на сервер уходит
    // только то значение, которое он точно понимает ("new", как в
    // командной палитре). Раньше сюда улетало имя колонки
    // ("title"/"deadline"/...), не описанное в контракте, а направление
    // сортировки не уходило вообще.
    q: $("#search-input").value.trim(),
    status: $("#status-filter").value,
    priority: $("#priority-filter").value,
    sort: "new",
    page_size: PAGE_SIZE,
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
  let ok = true;
  try {
    const r = await apiGet("/reports", currentFilters());
    let reports = r.reports || [];
    let total = r.total || 0;
    // «Избранное» — чисто локальный фильтр (см. favorites.js), сервер
    // о нём не знает и параметра под него в API нет. Фильтруем то, что
    // уже пришло на текущей странице, и подменяем total — иначе
    // статусбар ниже написал бы «показаны 3 из 47», хотя реально
    // отфильтровано ровно то, что загружено.
    if (state.quickFilter === "favorites") {
      const favs = favoriteIds();
      reports = reports.filter(x => favs.has(x.public_id));
      total = reports.length;
    }
    state.reports = reports;
    state.total = total;
    sortLocally();
    renderReports();
  } catch (e) {
    ok = false;
    toast(`Не удалось загрузить список: ${e.message}`, "error");
    statusbar.textContent = "Ошибка загрузки.";
  } finally {
    clearTimeout(skeletonTimer);
    skeleton.classList.remove("visible");
    setTimeout(() => { skeleton.hidden = true; }, 180); // DevSkim: ignore DS172411 — функция, не строка
    table.classList.remove("loading");
  }
  return ok;
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

// Диапазонное выделение Shift+клик — привычка из проводника/почты,
// которой чекбоксы-по-одному не дают: отметить полсотни строк подряд
// вручную, кликая по каждой, никто делать не станет. Индекс — вне
// renderReports(), чтобы переживать перерисовку (сортировка, фильтр,
// снятие звёздочки из фильтра «Избранное» и т.п.).
let lastCheckedIndex = null;

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
    const fav = isFavorite(r.public_id);
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-check" ${state.selected.has(r.public_id) ? "checked" : ""}></td>
      <td class="num">
        <button class="fav-star ${fav ? "on" : ""}" data-fav title="${fav ? "Убрать из избранного" : "В избранное"}">${fav ? "★" : "☆"}</button>
        ${esc(r.public_id)}
      </td>
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
      if (e.shiftKey && lastCheckedIndex !== null) {
        // Отмечаем/снимаем весь диапазон между прошлым и текущим кликом
        // тем же состоянием, в которое только что перешёл сам чекбокс.
        const from = Math.min(lastCheckedIndex, i);
        const to = Math.max(lastCheckedIndex, i);
        const on = e.target.checked;
        for (let j = from; j <= to; j++) {
          const rep = state.reports[j];
          if (!rep) continue;
          if (on) state.selected.add(rep.public_id); else state.selected.delete(rep.public_id);
        }
        renderReports();
      } else {
        toggleSelected(r.public_id, e.target.checked);
      }
      lastCheckedIndex = i;
    });
    tr.querySelector("[data-fav]").addEventListener("click", e => {
      e.stopPropagation();
      const on = toggleFavorite(r.public_id);
      e.target.classList.toggle("on", on);
      e.target.textContent = on ? "★" : "☆";
      e.target.title = on ? "Убрать из избранного" : "В избранное";
      if (state.quickFilter === "favorites" && !on) {
        // Сняли звёздочку, пока смотрим именно на фильтр «Избранное» —
        // строка должна пропасть из списка сразу, а не только после
        // следующего «Обновить».
        state.reports = state.reports.filter(x => x.public_id !== r.public_id);
        state.total = state.reports.length;
        renderReports();
      }
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
      changeStatusDialog([r.public_id], () => loadReports(), r.status);
    });
    tr.addEventListener("click", () => openReportDetail(r.public_id));
    // Правый клик — тот же набор быстрых действий, что уже есть в
    // строке «Команда» профиля (см. profile.js), только для отчёта:
    // открыть без выделения текста мышью, сменить статус/исполнителя/
    // приоритет/срок без похода внутрь карточки, скопировать номер.
    // Десктопная привычка (проводник, почта) — у мини-аппа такого
    // жеста просто нет физически.
    tr.addEventListener("contextmenu", e => {
      e.preventDefault();
      const favNow = isFavorite(r.public_id);
      showContextMenu(e.clientX, e.clientY, [
        { label: "Открыть карточку", action: () => openReportDetail(r.public_id) },
        { label: favNow ? "Убрать из избранного" : "В избранное", action: () => {
          toggleFavorite(r.public_id);
          if (state.activeTab === "list") renderReports();
        } },
        { label: "Сменить статус", action: () => changeStatusDialog([r.public_id], () => loadReports(), r.status) },
        { label: "Назначить исполнителя", action: () => assignDialog([r.public_id], () => loadReports()) },
        { label: "Приоритет", action: () => priorityDialog(r.public_id, () => loadReports(), r.priority) },
        { label: "Срок", action: () => deadlineDialog(r.public_id, r.deadline, () => loadReports()) },
        { label: "Скопировать номер", action: () => {
          navigator.clipboard.writeText(r.public_id)
            .then(() => toast(`${r.public_id} скопирован.`))
            .catch(() => toast("Не удалось скопировать.", "error"));
        } },
      ]);
    });
    tbody.appendChild(tr);
  });

  const truncated = state.total > state.reports.length;
  $("#statusbar").textContent =
    (truncated
      ? `Показаны первые ${state.reports.length} из ${state.total} — уточните фильтр или поиск, чтобы увидеть остальные · `
      : `Отчётов: ${state.reports.length} · `) +
    `клик по строке — открыть карточку, чекбоксы (Shift — диапазоном) — массовые операции · ` +
    `Ctrl+Shift+P — показать/скрыть окно из любого места`;

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

// Установка быстрого фильтра без загрузки — списку её зовёт обработчик
// ниже, а профилю («на руках пусто → посмотреть свободные серии») важно
// сначала переключить вкладку и только потом решать, нужен ли запрос.
export function setQuickFilter(key) {
  state.quickFilter = key;
  $all(".qf-chip").forEach(c => c.classList.toggle("active", c.dataset.qf === key));
}

$all(".qf-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    const key = chip.dataset.qf;
    setQuickFilter(state.quickFilter === key ? null : key);
    loadReports();
  });
});

// Ctrl+F — фокус на поиск по списку. Только когда вкладка «Список»
// действительно открыта и поверх неё нет модалки: раньше сочетание
// перехватывалось всегда и уводило фокус в поле под оверлеем — прямо
// посреди набора заметки в карточке отчёта.
// (Escape, закрывающий верхнюю модалку, живёт теперь в api.js — рядом
// с openSheet, к вкладке «Список» он отношения не имел.)
document.addEventListener("keydown", e => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
  if (state.activeTab !== "list" || document.querySelector(".overlay")) return;
  e.preventDefault();
  $("#search-input").focus();
  $("#search-input").select();
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

// selected === undefined (массовая операция — у отчётов статусы разные)
// показывает пустой пункт-заглушку вместо молчаливого выбора первого в
// списке: раньше диалог всегда открывался на «Черновик», и случайное
// «Применить» откатывало завершённый отчёт в черновик.
function statusOptionsHtml(selected) {
  const placeholder = selected === undefined ? `<option value="" selected>— выберите статус —</option>` : "";
  return placeholder + state.statusOptions.map(([v, label]) =>
    `<option value="${v}" ${v === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function usersOptionsHtml() {
  if (!state.users.length) return `<option value="">Нет доступных исполнителей</option>`;
  return state.users.map(u => `<option value="${u.telegram_id}">${esc(u.name)}</option>`).join("");
}

export function changeStatusDialog(publicIds, onDone, currentStatus) {
  const overlay = openSheet(`
    <h2>Сменить статус — ${publicIds.length > 1 ? publicIds.length + " отчётов" : publicIds[0]}</h2>
    <div class="row"><select id="dlg-status">${statusOptionsHtml(publicIds.length === 1 ? currentStatus : undefined)}</select></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Применить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const status = overlay.querySelector("#dlg-status").value;
    if (!status) { toast("Выберите статус.", "error"); return; }
    try {
      if (publicIds.length === 1) {
        await apiPost(`/report/${publicIds[0]}/status`, { status, comment: "" });
      } else {
        await apiPost("/reports/bulk/status", { public_ids: publicIds, status });
      }
      toast("Статус обновлён.", "success");
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
      toast("Исполнитель назначен.", "success");
      overlay.remove();
      state.selected.clear();
      await loadReports();
      if (onDone) await onDone();
    } catch (e) {
      toast(`Не удалось назначить: ${e.message}`, "error");
    }
  });
}

export function priorityDialog(publicId, onDone, current) {
  const overlay = openSheet(`
    <h2>Приоритет — ${publicId}</h2>
    <div class="row"><select id="dlg-priority">${Object.entries(PRIORITY_LABELS).map(([v, l]) => `<option value="${v}" ${v === current ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Применить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    try {
      await apiPost(`/report/${publicId}/details`, { priority: overlay.querySelector("#dlg-priority").value });
      toast("Приоритет обновлён.", "success");
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
      toast("Срок убран.", "success");
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
      toast("Срок обновлён.", "success");
      overlay.remove();
      await loadReports();
      if (onDone) await onDone();
    } catch (e) { toast(`Не удалось изменить срок: ${e.message}`, "error"); }
  });
}

$("#bulk-status").addEventListener("click", () => changeStatusDialog([...state.selected]));
$("#bulk-assign").addEventListener("click", () => assignDialog([...state.selected]));
