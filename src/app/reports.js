// Вкладка «Список»: таблица отчётов, фильтры, сортировка, массовые
// операции, диалоги смены статуса/назначения/приоритета/срока.
//
// Циклическая зависимость с report-detail.js (openReportDetail открывается
// по клику на строку, а из карточки отчёта вызываются диалоги отсюда) —
// это нормально для ES-модулей, пока ничего не вызывается на этапе
// инициализации модуля (только позже, из обработчиков событий).

import { state } from "./state.js";
import { pauseSuffix } from "./people.js";
import { apiGet, apiPost, openSheet, toast, mediaUrl } from "./api.js";
import { $, $all, esc, initials, isOverdue, STATUS_DOT_CLASS, STATUS_COLOR_VAR, PRIORITY_LABELS, showContextMenu } from "./utils.js";
import { openReportDetail } from "./report-detail.js";
import { isFavorite, toggleFavorite, favoriteIds } from "./favorites.js";
import { loadAvatars } from "./profile.js";

// page_size=100 — больше сервер за раз не отдаёт, но /api/reports
// понимает page (номер страницы, с нуля): остальное догружается кнопкой
// «Показать ещё» под таблицей, как в мини-аппе.
export const PAGE_SIZE = 100;
let listPage = 0;

export function currentFilters(page = 0) {
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
  // «Мои» — тот же параметр assignee, поэтому быстрый фильтр главнее
  // выбранного в списке исполнителя: оба сразу сервер всё равно не примет.
  const assignee = $("#assignee-filter").value;
  if (state.quickFilter === "mine") params.assignee = "me";
  else if (assignee) params.assignee = assignee;
  if (state.quickFilter === "overdue") params.overdue = 1;
  if (state.quickFilter === "unassigned") params.unassigned = 1;
  const titleId = $("#title-filter").value;
  const seasonId = $("#season-filter").value;
  if (titleId) params.title_id = titleId;
  else if (seasonId) params.season_id = seasonId;
  if (page) params.page = page;
  return params;
}

// ---------- фильтры по исполнителю / сезону / тайтлу ----------
// Те же фильтры, что в мини-аппе (f-assignee, f-season, f-title): сервер
// их и так понимал, в десктопе просто не было полей.

function fillAssigneeFilter() {
  const sel = $("#assignee-filter");
  const current = sel.value;
  if (sel.options.length - 1 === state.users.length) return;
  sel.innerHTML = `<option value="">Все исполнители</option>` +
    state.users.map(u => `<option value="${u.telegram_id}">${esc(u.name)}</option>`).join("");
  sel.value = current;
}

let seasonsLoaded = false;
async function fillSeasonFilter() {
  if (seasonsLoaded) return;
  try {
    const d = await apiGet("/public/seasons");
    const sel = $("#season-filter");
    const current = sel.value;
    sel.innerHTML = `<option value="">Все сезоны</option>` +
      (d.seasons || []).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
    sel.value = current;
    seasonsLoaded = true;
  } catch (_) { /* без списка сезонов фильтр просто останется «Все сезоны» */ }
}

async function fillTitleFilter(seasonId, selectedTitleId = "") {
  const sel = $("#title-filter");
  sel.innerHTML = `<option value="">Все тайтлы</option>`;
  sel.disabled = !seasonId;
  if (!seasonId) return;
  try {
    const d = await apiGet(`/public/seasons/${seasonId}/titles`);
    sel.innerHTML = `<option value="">Все тайтлы</option>` +
      (d.titles || []).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    sel.value = selectedTitleId;
  } catch (_) { /* тайтлы не подгрузились — фильтр по сезону всё равно работает */ }
}

// ---------- сохранённые фильтры (пресеты) ----------
// Именованный снимок всех фильтров списка — как «⭐ пресеты» в мини-аппе.
// Личная настройка, поэтому localStorage на пользователя.

function presetsKey() { return `project_list_presets_${state.telegramId || "anon"}`; }
function loadPresets() {
  try { return JSON.parse(localStorage.getItem(presetsKey()) || "[]"); } catch (_) { return []; }
}
function savePresets(list) {
  try { localStorage.setItem(presetsKey(), JSON.stringify(list)); } catch (_) { /* не критично */ }
}

function filterSnapshot() {
  return {
    q: $("#search-input").value.trim(),
    status: $("#status-filter").value,
    priority: $("#priority-filter").value,
    assignee: $("#assignee-filter").value,
    seasonId: $("#season-filter").value,
    titleId: $("#title-filter").value,
    quick: state.quickFilter,
  };
}

async function applySnapshot(f) {
  $("#search-input").value = f.q || "";
  $("#status-filter").value = f.status || "";
  $("#priority-filter").value = f.priority || "";
  $("#assignee-filter").value = f.assignee || "";
  $("#season-filter").value = f.seasonId || "";
  await fillTitleFilter(f.seasonId || "", f.titleId || "");
  setQuickFilter(f.quick || null);
  await loadReports();
}

function deletePreset(id) {
  savePresets(loadPresets().filter(p => p.id !== id));
  renderPresetChips();
}

export function renderPresetChips() {
  const root = $("#preset-chips");
  if (!root) return;
  root.innerHTML = loadPresets().map(p => `
    <span class="qf-chip preset-chip" data-preset="${esc(p.id)}" title="Применить фильтр «${esc(p.name)}» · правый клик — удалить">
      <span class="preset-chip-name">${esc(p.name)}</span>
      <button type="button" class="preset-chip-del" data-preset-del="${esc(p.id)}" title="Удалить фильтр" aria-label="Удалить фильтр «${esc(p.name)}»">×</button>
    </span>`).join("");
  root.querySelectorAll("[data-preset]").forEach(chip => {
    const preset = loadPresets().find(p => p.id === chip.dataset.preset);
    if (!preset) return;
    chip.addEventListener("click", e => {
      if (e.target.closest("[data-preset-del]")) return;
      applySnapshot(preset.filters);
      toast(`Фильтр «${preset.name}» применён.`);
    });
    chip.addEventListener("contextmenu", e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "Применить", action: () => applySnapshot(preset.filters) },
        { label: "Удалить", action: () => deletePreset(preset.id) },
      ]);
    });
  });
  root.querySelectorAll("[data-preset-del]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      deletePreset(btn.dataset.presetDel);
    });
  });
}

function savePresetDialog() {
  const overlay = openSheet(`
    <h2>Сохранить фильтр</h2>
    <label class="field-label" for="dlg-preset-name">Название</label>
    <div class="row"><input type="text" id="dlg-preset-name" maxlength="40" placeholder="Например: мои срочные"></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Сохранить</button>
    </div>
  `);
  const input = overlay.querySelector("#dlg-preset-name");
  input.focus();
  const save = () => {
    const name = input.value.trim();
    if (!name) { toast("Введите название фильтра.", "error"); return; }
    const list = loadPresets().filter(p => p.name !== name);
    list.push({ id: String(Date.now()), name, filters: filterSnapshot() });
    savePresets(list);
    renderPresetChips();
    overlay.remove();
    toast(`Фильтр «${name}» сохранён.`, "success");
  };
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter") save(); });
}

// Соседи отчёта в текущем порядке списка — для кнопок «‹ ›» в карточке
// отчёта, как в мини-аппе: пролистать выборку, не закрывая карточку.
export function listNeighbors(publicId) {
  if (state.activeTab !== "list") return null;
  const idx = state.reports.findIndex(r => r.public_id === publicId);
  if (idx === -1) return null;
  return {
    prev: idx > 0 ? state.reports[idx - 1].public_id : null,
    next: idx < state.reports.length - 1 ? state.reports[idx + 1].public_id : null,
  };
}

// «Фрирен 2, серия 7» → имя тайтла + «серия 7» отдельно. Если отчёт
// привязан к тайтлу (title_name), имя берём оттуда, а свободный текст
// отчёта остаётся подписью — у старых отчётов он бывает любым.
export function seriesParts(r) {
  const raw = String(r.title || "").trim();
  const m = raw.match(/^(.*?)[,\s—-]+(серия|эп\.?|ep\.?)\s*(\d+)\s*$/i);
  if (r.title_name) {
    const ep = r.episode ? `серия ${r.episode}` : m ? `серия ${m[3]}` : "";
    const sub = m && m[1].trim() === r.title_name ? "" : (m ? "" : raw);
    return { name: r.title_name, ep, sub: sub && sub !== r.title_name ? sub : "" };
  }
  if (m && m[1].trim()) return { name: m[1].trim(), ep: `серия ${m[3]}`, sub: "" };
  return { name: raw || r.public_id, ep: "", sub: "" };
}

// Постеры — через /img_proxy: к <img>/background заголовок с токеном
// не приделать, а внешний сайт постеров из webview может не открыться.
export function posterSrc(url) {
  return url ? mediaUrl("/img_proxy", { url }) : "";
}

export function priorityFlagHtml(p) {
  if (p === "urgent") return `<span class="ls-prio urgent" title="Срочный">🔥 срочно</span>`;
  if (p === "high") return `<span class="ls-prio high" title="Высокий приоритет">🔥</span>`;
  if (p === "low") return `<span class="ls-prio low" title="Низкий приоритет">низкий</span>`;
  return "";
}

// Этапы пайплайна точками: пройденные закрашены, текущий светится.
// pipeline_roles/pipeline_stage — прямо из отчёта; нет цепочки — прочерк.
export function pipelineDotsHtml(r) {
  const roles = r.pipeline_roles || [];
  if (!roles.length) return `<span class="ls-nopipe">—</span>`;
  const stage = r.status === "completed" ? roles.length : (r.pipeline_stage ?? 0);
  const dots = roles.map((role, i) =>
    `<i class="${i < stage ? "done" : i === stage ? "cur" : ""}" title="${esc(role)}${i < stage ? " — готово" : i === stage ? " — сейчас" : ""}"></i>`).join("");
  const cur = stage < roles.length ? roles[stage] : "готово";
  return `<span class="ls-pipe"><span class="dots">${dots}</span><span class="lbl">${esc(cur)}</span></span>`;
}

// Срок пилюлей с отсчётом («завтра», «просрочено 2 дн.») и цветом —
// то, что горит, видно без подсчёта дат в уме; сама дата мельче рядом.
export function deadlineCellHtml(r, overdue) {
  if (!r.deadline) return `<span class="ls-dl-none">без срока</span>`;
  const d = new Date();
  const today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((Date.parse(`${r.deadline}T00:00:00Z`) - today) / 86400000);
  const date = `${r.deadline.slice(8, 10)}.${r.deadline.slice(5, 7)}`;
  if (r.status === "completed" || r.status === "cancelled") return `<span class="ls-dl-none">${date}</span>`;
  const [txt, cls] = overdue ? [`просрочено ${-days} дн.`, "late"]
    : days === 0 ? ["сегодня", "late"] : days === 1 ? ["завтра", "soon"] : days <= 3 ? [`через ${days} дн.`, "soon"] : [`через ${days} дн.`, "ok"];
  return `<span class="ls-dl-pill ${cls}">${txt}</span><span class="ls-dl-date">${date}</span>`;
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
  fillAssigneeFilter();
  fillSeasonFilter();
  renderPresetChips();
  listPage = 0;
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

export async function loadMoreReports() {
  const btn = $("#list-more");
  btn.disabled = true;
  btn.textContent = "Загрузка…";
  try {
    const r = await apiGet("/reports", currentFilters(listPage + 1));
    listPage += 1;
    const known = new Set(state.reports.map(x => x.public_id));
    let fresh = (r.reports || []).filter(x => !known.has(x.public_id));
    if (state.quickFilter === "favorites") {
      const favs = favoriteIds();
      fresh = fresh.filter(x => favs.has(x.public_id));
    }
    state.reports = state.reports.concat(fresh);
    state.total = r.total || state.total;
    sortLocally();
    renderReports();
  } catch (e) {
    toast(`Не удалось догрузить список: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
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
  if (!empty.hidden) {
    // Причина пустого списка обычно понятна сразу (активный фильтр),
    // так что подсказка — не общая заглушка, а конкретный следующий
    // шаг под конкретную причину, а не догадки пользователя.
    const textEl = empty.querySelector(".empty-state-text");
    const icEl = empty.querySelector(".empty-state-ic");
    if (state.quickFilter === "favorites") {
      icEl.textContent = "★";
      textEl.textContent = "Пока нет избранного — нажмите ☆ у номера отчёта в списке, чтобы отметить нужные.";
    } else if (state.quickFilter === "overdue") {
      icEl.textContent = "🎉";
      textEl.textContent = "Просроченных нет — всё по срокам.";
    } else if (state.quickFilter === "unassigned") {
      icEl.textContent = "✅";
      textEl.textContent = "Без исполнителя ничего не осталось.";
    } else if (state.quickFilter === "mine") {
      icEl.textContent = "🗂️";
      textEl.textContent = "На вас пока ничего не назначено.";
    } else {
      icEl.textContent = "🗂️";
      textEl.textContent = "Ничего не найдено — попробуйте другой фильтр.";
    }
  }

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
    const t = seriesParts(r);
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-check" ${state.selected.has(r.public_id) ? "checked" : ""}></td>
      <td class="ls-series">
        <div class="ls-series-in">
          <span class="ls-poster"${posterSrc(r.poster_url) ? ` style="background-image:url('${esc(posterSrc(r.poster_url))}')"` : ""}>${posterSrc(r.poster_url) ? "" : esc(initials(t.name))}</span>
          <div class="ls-names">
            <div class="ls-name">${esc(t.name)}${t.ep ? `<span class="ls-ep">${esc(t.ep)}</span>` : ""}${priorityFlagHtml(r.priority)}</div>
            <div class="ls-id"><button class="fav-star ${fav ? "on" : ""}" data-fav title="${fav ? "Убрать из избранного" : "В избранное"}">${fav ? "★" : "☆"}</button>${esc(r.public_id)}${t.sub ? ` · ${esc(t.sub)}` : ""}${r.files_count ? ` · 📎${r.files_count}` : ""}${r.notes_count ? ` · 💬${r.notes_count}` : ""}</div>
          </div>
        </div>
      </td>
      <td><span class="chip status-chip" style="--chip-accent: var(${STATUS_COLOR_VAR[r.status] || "--s-draft"})"><span class="dot ${dotClass}"></span>${esc(r.status_label)}</span>${r.stuck ? `<span class="ls-stuck" title="Статус не менялся 3+ дня">застряло</span>` : ""}</td>
      <td>${pipelineDotsHtml(r)}</td>
      <td class="ls-dl">${deadlineCellHtml(r, overdue)}</td>
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

  const truncated = state.quickFilter !== "favorites" && state.total > state.reports.length;
  const moreBtn = $("#list-more");
  moreBtn.hidden = !truncated;
  if (truncated) {
    const left = state.total - state.reports.length;
    moreBtn.textContent = left > PAGE_SIZE ? `Показать ещё ${PAGE_SIZE} (осталось ${left})` : `Показать оставшиеся ${left}`;
  }
  $("#statusbar").textContent =
    (truncated
      ? `Показаны ${state.reports.length} из ${state.total} · `
      : `Отчётов: ${state.reports.length} · `) +
    `клик по строке — открыть карточку, чекбоксы (Shift — диапазоном) — массовые операции · ` +
    `Ctrl+Shift+P — показать/скрыть окно из любого места`;

  $("#select-all").checked = state.reports.length > 0 && state.reports.every(r => state.selected.has(r.public_id));
  updateBulkBar();
  loadAvatars(tbody);
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
$("#assignee-filter").addEventListener("change", loadReports);
$("#season-filter").addEventListener("change", async () => {
  await fillTitleFilter($("#season-filter").value);
  loadReports();
});
$("#title-filter").addEventListener("change", loadReports);
$("#list-more").addEventListener("click", loadMoreReports);
$("#preset-save").addEventListener("click", savePresetDialog);
renderPresetChips();

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
  // e.code — физическая клавиша, не зависит от раскладки (см. командную
  // палитру в command-palette.js: та же причина, что и там).
  if (!(e.ctrlKey || e.metaKey) || e.code !== "KeyF") return;
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
  return state.users.map(u => `<option value="${u.telegram_id}">${esc(u.name)}${esc(pauseSuffix(u))}</option>`).join("");
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
