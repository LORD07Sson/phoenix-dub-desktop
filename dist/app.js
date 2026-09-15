// PHOENIX DUB Desktop — фронтенд. Обычный vanilla JS, без сборки: ходит
// напрямую в тот же REST API, что и мини-апп (см. api.js-эквивалент в
// прежнем PySide6-клиенте — те же пути, тот же заголовок X-Init-Data,
// только теперь сама разметка/логика — веб, а не Qt-виджеты).

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const API_BASE = "https://minitg.shitstudent.com:8443/api";
const appWindow = getCurrentWindow();

// ---------- состояние ----------

const state = {
  token: null,
  telegramId: null,
  name: null,
  reports: [],
  total: 0,
  sort: { field: "public_id", dir: "asc" },
  selected: new Set(), // public_id
  statusOptions: [
    ["draft", "Черновик"],
    ["working", "В работе"],
    ["review", "На проверке"],
    ["revision", "Требует исправления"],
    ["completed", "Завершено"],
    ["cancelled", "Отменено"],
  ],
  users: [],
  quickFilter: null, // null | "mine" | "overdue" | "unassigned"
};

const STATUS_DOT_CLASS = {
  draft: "draft", working: "work", review: "review",
  revision: "fix", completed: "done", cancelled: "stop",
};

const PRIORITY_LABELS = { low: "Низкий", normal: "Обычный", high: "Высокий", urgent: "Срочный" };

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  const a = parts[0] ? parts[0][0] : "";
  const b = parts[1] ? parts[1][0] : "";
  return (a + b).toUpperCase() || "?";
}

function isOverdue(r) {
  if (!r.deadline || r.status === "completed" || r.status === "cancelled") return false;
  return r.deadline < new Date().toISOString().slice(0, 10);
}

// ---------- утилиты ----------

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(text, kind = "info") {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  if (kind === "error") el.style.borderLeftColor = "var(--s-stop)";
  const duration = 4200;
  el.innerHTML = `<span class="toast-text"></span><span class="toast-progress" style="animation-duration:${duration}ms;"></span>`;
  el.querySelector(".toast-text").textContent = text;
  root.appendChild(el);
  const remove = () => {
    el.classList.add("toast-out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  const timer = setTimeout(remove, duration);
  el.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

// Скелетон-заглушка для модалок, пока грузятся реальные данные
// (карточка отчёта, QC-анализ) — вместо одного спиннера с текстом.
function dialogSkeletonHtml(lines = 4) {
  const rows = Array.from({ length: lines }, (_, i) =>
    `<div class="skeleton-row" style="animation-delay:${i * 60}ms;"></div>`).join("");
  return `<div class="skeleton-wrap">${rows}</div>`;
}

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["X-Init-Data"] = state.token;
  const url = path.startsWith("/desktop/pair") ? `${API_BASE}${path}` : `${API_BASE}${path}`;
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Нет связи с сервером: ${e.message}`);
  }
  if (!resp.ok) {
    let detail = resp.status;
    try { detail = (await resp.json()).detail ?? detail; } catch (_) {}
    throw new Error(String(detail));
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

function apiGet(path, params) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)) : "";
  return api("GET", path + qs);
}
function apiPost(path, body) { return api("POST", path, body || {}); }

function openSheet(html, variant) {
  const tpl = $(variant === "wide" ? "#tpl-overlay-wide" : "#tpl-overlay").content.cloneNode(true);
  const overlay = tpl.querySelector(".overlay");
  overlay.querySelector(".sheet").innerHTML = html;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  return overlay;
}

// ---------- тема ----------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("phoenix-theme", theme); } catch (_) {}
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("phoenix-theme"); } catch (_) {}
  applyTheme(saved || "dark");
})();
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(cur);
});

// ---------- авторизация ----------

// Экран загрузки при старте — тот же маскот/прогресс-бар, что и в
// мини-аппе (см. #splash в miniapp/static/index.html). Держим минимум
// 700мс, чтобы не мигать на мгновенном /whoami, и прячем сразу же,
// как только известно, куда вести — в приложение или на экран входа.
const SPLASH_MIN_MS = 700;
const splashShownAt = Date.now();
function hideSplash() {
  const el = $("#app-splash");
  if (!el || el.dataset.hidden) return;
  el.dataset.hidden = "1";
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  setTimeout(() => {
    el.classList.add("hide");
    setTimeout(() => el.remove(), 400);
  }, wait);
}

async function tryRestoreSession() {
  const token = await invoke("token_load");
  if (!token) { hideSplash(); return showAuth(); }
  state.token = token;
  try {
    const who = await api("GET", "/whoami");
    state.telegramId = who.telegram_id;
    showApp();
    hideSplash();
    await refreshAll();
  } catch (e) {
    // токен отозван/протух — просим войти заново, а не молча виснем.
    await invoke("token_clear").catch(() => {});
    hideSplash();
    showAuth(`Сессия истекла: ${e.message}`);
  }
}

function showAuth(err) {
  $("#auth-screen").hidden = false;
  $("#app-screen").hidden = true;
  if (err) $("#auth-error").textContent = err;
  $("#code-input").focus();
}

function showApp() {
  $("#auth-screen").hidden = true;
  $("#app-screen").hidden = false;
  $("#whoami").textContent = state.name ? `— ${state.name}` : "";
}

async function submitCode() {
  const code = $("#code-input").value.trim();
  const errEl = $("#auth-error");
  errEl.textContent = "";
  if (!/^\d{4,8}$/.test(code)) {
    errEl.textContent = "Введите код из сообщения бота.";
    return;
  }
  const btn = $("#submit-code");
  btn.disabled = true;
  try {
    const os = navigator.platform || "desktop";
    const result = await api("POST", "/desktop/pair", { code, label: `Desktop (${os})` });
    state.token = result.token;
    state.telegramId = result.telegram_id;
    state.name = result.name;
    await invoke("token_save", { token: result.token });
    showApp();
    await refreshAll();
  } catch (e) {
    errEl.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
$("#submit-code").addEventListener("click", submitCode);
$("#code-input").addEventListener("keydown", e => { if (e.key === "Enter") submitCode(); });

$("#logout-btn").addEventListener("click", async () => {
  await invoke("token_clear").catch(() => {});
  state.token = null;
  state.selected.clear();
  $("#code-input").value = "";
  showAuth();
});

// ---------- вкладки ----------

state.activeTab = "overview";
state.loadedTabs = new Set();

function switchTab(name) {
  state.activeTab = name;
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $all(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === name));
  loadActiveTab();
}
$all(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

function loadActiveTab(force) {
  const name = state.activeTab;
  if (!force && state.loadedTabs.has(name)) return;
  state.loadedTabs.add(name);
  if (name === "overview") loadOverview();
  else if (name === "list") loadReports();
  else if (name === "board") loadBoard();
  else if (name === "titles") loadTitlesTab();
  else if (name === "feed") loadFeed();
  else if (name === "profile") loadProfile();
}

// ---------- список отчётов ----------

async function refreshAll() {
  await loadUsers();
  loadActiveTab(true);
}

async function loadUsers() {
  try {
    const r = await apiGet("/assignable-users");
    state.users = r.users || [];
  } catch (_) { /* не критично для списка */ }
}

function currentFilters() {
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

async function loadReports() {
  const statusbar = $("#statusbar");
  const skeleton = $("#skeleton");
  const table = $(".content table");
  // Скелетон показываем только если загрузка реально затянулась (>100мс) —
  // иначе на быстром ответе он просто мигнёт туда-обратно.
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
    setTimeout(() => { skeleton.hidden = true; }, 180);
    table.classList.remove("loading");
  }
}

function sortLocally() {
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

function assigneesHtml(list) {
  if (!list || !list.length) return `<span class="no-assignee">не назначен</span>`;
  const shown = list.slice(0, 3);
  const bubbles = shown.map(a => `<span class="avatar-bubble" title="${esc(a.name)}">${esc(initials(a.name))}</span>`).join("");
  const more = list.length > 3 ? `<span class="avatar-more">+${list.length - 3}</span>` : "";
  return `<span class="avatar-stack">${bubbles}</span>${more}`;
}

function renderReports() {
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
    `;
    tr.querySelector(".row-check").addEventListener("click", e => {
      e.stopPropagation();
      toggleSelected(r.public_id, e.target.checked);
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

function toggleSelected(publicId, on) {
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
  searchDebounce = setTimeout(loadReports, 320);
});
$("#search-input").addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(searchDebounce); loadReports(); } });
$("#status-filter").addEventListener("change", loadReports);
$("#priority-filter").addEventListener("change", loadReports);
$("#refresh-btn").addEventListener("click", refreshAll);

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

// ---------- смена статуса / назначение ----------

function statusOptionsHtml(selected) {
  return state.statusOptions.map(([v, label]) =>
    `<option value="${v}" ${v === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function usersOptionsHtml() {
  if (!state.users.length) return `<option value="">Нет доступных исполнителей</option>`;
  return state.users.map(u => `<option value="${u.telegram_id}">${esc(u.name)}</option>`).join("");
}

function changeStatusDialog(publicIds, onDone) {
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

function assignDialog(publicIds, onDone) {
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

$("#bulk-status").addEventListener("click", () => changeStatusDialog([...state.selected]));
$("#bulk-assign").addEventListener("click", () => assignDialog([...state.selected]));

// ---------- карточка отчёта ----------

const QC_FINDING_LABELS_RU = { clipping: "Клиппинг", silence: "Пауза", noise: "Шум", loud: "Громко", quiet: "Тихо" };

async function openReportDetail(publicId) {
  const overlay = openSheet(`
    <h2 class="skeleton-row" style="width:60%; height:22px;"></h2>
    ${dialogSkeletonHtml(5)}
  `, "wide");

  async function render() {
    let detail, notes, checklist, files;
    try {
      [detail, notes, checklist, files] = await Promise.all([
        apiGet(`/report/${publicId}`),
        apiGet(`/report/${publicId}/notes`),
        apiGet(`/report/${publicId}/checklist`),
        apiGet(`/report/${publicId}/files`),
      ]);
    } catch (e) {
      overlay.querySelector(".sheet").innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить карточку: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
      overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
      return;
    }

    const dotClass = STATUS_DOT_CLASS[detail.status] || "draft";
    const overdue = isOverdue(detail);

    overlay.querySelector(".sheet").innerHTML = `
      <div class="detail-head">
        <h2>${esc(detail.title)}</h2>
        <button class="icon-btn" data-close style="flex:none;">✕</button>
      </div>
      <div class="detail-id">${esc(detail.public_id)} · от ${esc((detail.author && (detail.author.first_name || detail.author.username)) || "?")} · ${esc(detail.created_at || "")}</div>

      <div class="detail-chips">
        <span class="chip" id="chip-status"><span class="dot ${dotClass}"></span>${esc(detail.status_label)}</span>
        <span class="chip" id="chip-priority">${esc(detail.priority_label)}</span>
        <span class="chip ${overdue ? "" : ""}" id="chip-deadline" style="${overdue ? "border-color:var(--s-stop); color:var(--s-stop);" : ""}">${overdue ? "⏰ " : "📅 "}${esc(detail.deadline || "без срока")}</span>
        <span class="chip" id="chip-assign">👤 Назначить</span>
      </div>

      <div class="detail-section">
        <h3>Исполнители</h3>
        ${(detail.assignees && detail.assignees.length)
          ? detail.assignees.map(a => `<div class="assignee-row"><span class="avatar-bubble">${esc(initials(a.first_name || a.username))}</span>${esc(a.first_name || a.username || `ID ${a.telegram_id}`)}</div>`).join("")
          : `<div class="no-assignee">Никто не назначен</div>`}
      </div>

      <div class="detail-section">
        <h3>Чек-лист ${checklist.items.length ? `(${checklist.items.filter(i => i.done).length}/${checklist.items.length})` : ""}</h3>
        <div id="checklist-list">${checklist.items.map(checklistItemHtml).join("") || `<div class="no-assignee">Пусто</div>`}</div>
        <div class="add-row">
          <input id="checklist-new" placeholder="Новый пункт…">
          <button class="btn" id="checklist-add">+</button>
        </div>
      </div>

      <div class="detail-section">
        <h3>Заметки ${notes.notes.length ? `(${notes.notes.length})` : ""}</h3>
        <div id="notes-list">${notes.notes.map(noteHtml).join("") || `<div class="no-assignee">Пока нет заметок</div>`}</div>
        <div class="add-row">
          <textarea id="note-new" rows="2" placeholder="Написать заметку…"></textarea>
          <button class="btn" id="note-add">Добавить</button>
        </div>
      </div>

      ${files.files.length ? `
      <div class="detail-section">
        <h3>Файлы (${files.files.length})</h3>
        <div id="files-list">${files.files.map(fileHtml).join("")}</div>
      </div>` : ""}

      <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
    `;

    const sheet = overlay.querySelector(".sheet");
    sheet.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => overlay.remove()));
    sheet.querySelector("#chip-status").addEventListener("click", () => changeStatusDialog([publicId], render));
    sheet.querySelector("#chip-assign").addEventListener("click", () => assignDialog([publicId], render));
    sheet.querySelector("#chip-priority").addEventListener("click", () => priorityDialog(publicId, render));
    sheet.querySelector("#chip-deadline").addEventListener("click", () => deadlineDialog(publicId, detail.deadline, render));

    sheet.querySelectorAll(".checklist-item").forEach(el => {
      el.addEventListener("click", async () => {
        try {
          await apiPost(`/report/${publicId}/checklist/${el.dataset.id}/toggle`, {});
          await render();
        } catch (e) { toast(`Не удалось изменить пункт: ${e.message}`, "error"); }
      });
    });
    sheet.querySelector("#checklist-add").addEventListener("click", async () => {
      const input = sheet.querySelector("#checklist-new");
      const text = input.value.trim();
      if (!text) return;
      try {
        await apiPost(`/report/${publicId}/checklist`, { text });
        await render();
      } catch (e) { toast(`Не удалось добавить пункт: ${e.message}`, "error"); }
    });
    sheet.querySelector("#note-add").addEventListener("click", async () => {
      const ta = sheet.querySelector("#note-new");
      const text = ta.value.trim();
      if (!text) return;
      try {
        await apiPost(`/report/${publicId}/notes`, { text });
        await render();
      } catch (e) { toast(`Не удалось добавить заметку: ${e.message}`, "error"); }
    });
    sheet.querySelectorAll("[data-qc-file]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const fileId = btn.dataset.qcFile;
        btn.disabled = true;
        btn.textContent = "Анализ…";
        try {
          const res = await apiPost(`/report/${publicId}/files/${fileId}/qc`, {});
          const resultEl = sheet.querySelector(`#qc-result-${fileId}`);
          const findings = res.findings || [];
          resultEl.innerHTML = findings.length
            ? findings.map(f => `<div class="qc-finding ${f.severity || "warn"}"><span class="tag">${esc(QC_FINDING_LABELS_RU[f.kind] || f.kind || "?")}</span><div>${esc(f.message || "")}</div></div>`).join("")
            : `<div style="color:var(--s-done); font-size:12px;">✓ Замечаний не найдено</div>`;
        } catch (e) {
          toast(`AI-проверка не удалась: ${e.message}`, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "🤖 AI-проверка";
        }
      });
    });
  }

  await render();
}

function checklistItemHtml(item) {
  return `<div class="checklist-item ${item.done ? "done" : ""}" data-id="${item.id}">
    <input type="checkbox" ${item.done ? "checked" : ""} tabindex="-1">
    <span>${esc(item.text)}</span>
  </div>`;
}

function noteHtml(n) {
  return `<div class="note-item">
    <div class="meta">${esc(n.author)} · ${esc(n.created_at || "")}</div>
    <div>${esc(n.text)}</div>
  </div>`;
}

function fileHtml(f) {
  const isAudio = /audio|wav|mp3|flac|m4a|ogg/i.test(f.file_type || f.file_name || "");
  return `<div class="file-item">
    <div>${esc(f.file_name || f.file_type)} <span class="meta">${esc(f.file_size_label || "")}</span></div>
    ${isAudio ? `<button class="btn" style="padding:4px 10px; font-size:12px;" data-qc-file="${f.id}">🤖 AI-проверка</button>` : ""}
    <div id="qc-result-${f.id}" style="width:100%;"></div>
  </div>`;
}

function priorityDialog(publicId, onDone) {
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

function deadlineDialog(publicId, current, onDone) {
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

// ---------- QC звука ----------

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function formatRange(start, end) {
  const dur = end - start;
  if (dur < 1) return `${formatTime(start)} (~${Math.round(dur * 1000)} мс)`;
  return `${formatTime(start)}–${formatTime(end)}`;
}

const FINDING_LABELS = {
  clipping: "Клиппинг", silence: "Пауза", quiet: "Тихо", loud: "Громко",
};

async function openQcDialog() {
  const { open } = window.__TAURI__.dialog;
  const path = await open({
    multiple: false,
    filters: [{ name: "Аудио/видео", extensions: ["wav", "mp3", "flac", "m4a", "aac", "ogg", "mp4", "mkv", "mov"] }],
  });
  if (!path) return;

  const overlay = openSheet(`
    <h2>QC звука</h2>
    <p style="color:var(--ink-soft); font-size:12.5px; margin-top:-8px;">${esc(path)}</p>
    <div id="qc-body">${dialogSkeletonHtml(3)}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());

  try {
    const report = await invoke("qc_analyze", { path });
    const body = overlay.querySelector("#qc-body");
    if (!report.findings.length) {
      body.innerHTML = `<div style="color:var(--s-done);">✓ Замечаний не найдено. Пик ${report.peak_dbfs.toFixed(1)} дБФС, RMS ${report.rms_dbfs.toFixed(1)} дБФС, длительность ${formatTime(report.duration)}.</div>`;
      return;
    }
    body.innerHTML =
      `<div style="color:var(--ink-soft); font-size:12.5px; margin-bottom:10px;">Длительность ${formatTime(report.duration)} · Пик ${report.peak_dbfs.toFixed(1)} дБФС · RMS ${report.rms_dbfs.toFixed(1)} дБФС</div>` +
      report.findings.map(f => `
        <div class="qc-finding ${f.severity}">
          <span class="tag">${esc(FINDING_LABELS[f.kind] || f.kind)}</span>
          <div>
            <div class="time">${formatRange(f.start, f.end)}</div>
            <div>${esc(f.message)}</div>
          </div>
        </div>
      `).join("");
  } catch (e) {
    overlay.querySelector("#qc-body").innerHTML = `<div style="color:var(--s-stop);">${esc(e)}</div>`;
  }
}
$("#open-qc").addEventListener("click", openQcDialog);

// ---------- настройки (автозапуск, горячие клавиши, тема) ----------

async function openSettings() {
  let autostartOn = false;
  try { autostartOn = await invoke("is_autostart"); } catch (_) {}

  // Переключатель dev-режима виден только реальным разработчикам студии
  // (state.isDeveloper — из /api/me, is_developer сервер сам проверяет
  // по OWNER_IDS на каждый /api/dev/* запрос, фронту тут не доверяют).
  if (state.isDeveloper == null) {
    try { state.isDeveloper = !!(await apiGet("/me")).is_developer; } catch (_) { state.isDeveloper = false; }
  }

  const overlay = openSheet(`
    <h2>Настройки</h2>
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>Запускать при старте системы</span>
      <input type="checkbox" id="s-autostart" ${autostartOn ? "checked" : ""}>
    </div>
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>Тема</span>
      <select id="s-theme">
        <option value="dark">Тёмная</option>
        <option value="light">Светлая</option>
      </select>
    </div>
    ${state.isDeveloper ? `
    <div class="row dev-pill-toggle" style="align-items:center; justify-content:space-between;">
      <span>🛠 Режим разработчика</span>
      <input type="checkbox" id="s-dev-mode" ${isDevModeOn() ? "checked" : ""}>
    </div>` : ""}
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>Версия ${esc(APP_VERSION)}</span>
      <button class="btn" id="s-check-update" style="padding:5px 12px; font-size:12.5px;">Проверить обновления</button>
    </div>
    <p style="color:var(--ink-soft); font-size:12.5px;">
      Ctrl+Shift+P — показать/скрыть окно из любого места, даже когда оно свёрнуто в трей.<br>
      Крестик у окна сворачивает в трей — опрос новых назначений продолжает идти в фоне.
      ${state.isDeveloper ? "<br>Режим разработчика открывает правку чужих ролей/профиля/даты вступления/наград — на карточке коллеги (клик по тизеру команды)." : ""}
    </p>
    <div class="sheet-actions"><button class="btn primary" data-close>Готово</button></div>
  `);
  overlay.querySelector("#s-theme").value = document.documentElement.dataset.theme || "dark";
  overlay.querySelector("#s-theme").addEventListener("change", e => applyTheme(e.target.value));
  overlay.querySelector("#s-autostart").addEventListener("change", async e => {
    try {
      await invoke("set_autostart", { enabled: e.target.checked });
    } catch (err) {
      toast(`Не удалось изменить автозапуск: ${err}`, "error");
      e.target.checked = !e.target.checked;
    }
  });
  const devToggle = overlay.querySelector("#s-dev-mode");
  if (devToggle) devToggle.addEventListener("change", e => setDevModeOn(e.target.checked));
  overlay.querySelector("#s-check-update").addEventListener("click", () => checkForUpdates(false));
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}
$("#open-settings").addEventListener("click", openSettings);

// ---------- автообновление ----------

const APP_VERSION = "0.5.0"; // подставляется автоматически из VERSION при сборке в CI (build.yml)

async function checkForUpdates(silent) {
  try {
    const { check } = window.__TAURI__.updater;
    const update = await check();
    if (!update) {
      if (!silent) toast("У вас уже последняя версия.");
      return;
    }
    const yes = await confirmUpdateSheet(update);
    if (!yes) return;
    await installUpdate(update);
  } catch (e) {
    if (!silent) toast(`Не удалось проверить обновления: ${e}`, "error");
  }
}

function confirmUpdateSheet(update) {
  return new Promise(resolve => {
    const overlay = openSheet(`
      <h2>Доступно обновление ${esc(update.version)}</h2>
      <div style="color:var(--ink-soft); font-size:13px; white-space:pre-wrap; max-height:200px; overflow:auto; margin-bottom:6px;">${esc(update.body || "Без описания изменений.")}</div>
      <div class="sheet-actions">
        <button class="btn ghost" data-no>Позже</button>
        <button class="btn primary" data-yes>Обновить и перезапустить</button>
      </div>
    `);
    overlay.querySelector("[data-no]").addEventListener("click", () => { overlay.remove(); resolve(false); });
    overlay.querySelector("[data-yes]").addEventListener("click", () => { overlay.remove(); resolve(true); });
    overlay.addEventListener("click", e => { if (e.target === overlay) resolve(false); });
  });
}

async function installUpdate(update) {
  const overlay = openSheet(`
    <h2>Устанавливаю обновление…</h2>
    <div class="update-progress-track"><div class="update-progress-fill" id="upd-fill"></div></div>
    <div id="upd-status" style="color:var(--ink-soft); font-size:12.5px;">Скачивание…</div>
  `);
  const fill = overlay.querySelector("#upd-fill");
  const statusEl = overlay.querySelector("#upd-status");
  let total = 0, downloaded = 0;
  try {
    await update.downloadAndInstall(event => {
      if (event.event === "Started") {
        total = event.data.contentLength || 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength || 0;
        if (total) {
          const pct = Math.min(100, Math.round((downloaded / total) * 100));
          fill.style.width = pct + "%";
          statusEl.textContent = `Скачано ${pct}%`;
        }
      } else if (event.event === "Finished") {
        fill.style.width = "100%";
        statusEl.textContent = "Устанавливаю…";
      }
    });
    statusEl.textContent = "Готово — перезапуск…";
    const { relaunch } = window.__TAURI__.process;
    await relaunch();
  } catch (e) {
    statusEl.textContent = `Ошибка: ${e}`;
    statusEl.style.color = "var(--s-stop)";
  }
}

// ---------- уведомления о новых назначениях (диф-опрос) ----------

let knownAssigned = null; // Set — null значит «ещё не было первого опроса»
const POLL_INTERVAL_MS = 60_000;

async function pollAssignments() {
  if (!state.token) return;
  try {
    const r = await apiGet("/reports", { assignee: "me", page_size: 100 });
    const ids = new Set((r.reports || []).map(x => x.public_id));
    if (knownAssigned !== null) {
      const fresh = [...ids].filter(id => !knownAssigned.has(id));
      if (fresh.length) {
        const { sendNotification } = window.__TAURI__.notification;
        sendNotification({
          title: "PHOENIX DUB",
          body: fresh.length === 1
            ? `Вам назначен отчёт ${fresh[0]}`
            : `Вам назначено ${fresh.length} новых отчётов`,
        });
      }
    }
    knownAssigned = ids;
  } catch (_) { /* тихо: трей не должен спамить ошибками сети раз в минуту */ }
}
setInterval(pollAssignments, POLL_INTERVAL_MS);

// ---------- донат-чарт (SVG, с анимацией заливки) ----------

const STATUS_COLOR_VAR = {
  draft: "--s-draft", working: "--s-work", review: "--s-review",
  revision: "--s-fix", completed: "--s-done", cancelled: "--s-stop",
};

function donutHtml(segments, size, thickness) {
  size = size || 120;
  thickness = thickness || 16;
  const r = (size - thickness) / 2;
  const circumference = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.count, 0);
  const cx = size / 2, cy = size / 2;
  let offsetAcc = 0;
  const circles = segments.filter(s => s.count > 0).map(s => {
    const frac = total ? s.count / total : 0;
    const len = frac * circumference;
    const dasharray = `${len} ${circumference - len}`;
    const dashoffset = -offsetAcc;
    offsetAcc += len;
    return `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="var(${s.colorVar})" stroke-width="${thickness}"
      stroke-dasharray="${circumference} ${circumference}"
      stroke-dashoffset="${circumference}"
      data-target-dasharray="${dasharray}" data-target-dashoffset="${dashoffset}"
      transform="rotate(-90 ${cx} ${cy})"></circle>`;
  }).join("");
  return `
    <svg class="donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="${thickness}"></circle>
      ${circles}
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="20" font-weight="700" fill="var(--ink)">${total}</text>
      <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="10" fill="var(--ink-dim)">всего</text>
    </svg>`;
}

// Заставляет только что вставленные .donut-seg проиграть анимацию
// заливки — без этого браузер применил бы target-значения мгновенно
// (переход же должен идти от "пусто" к заполненному состоянию).
function playDonutIntro(root) {
  const segs = root.querySelectorAll(".donut-seg");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      segs.forEach(c => {
        c.setAttribute("stroke-dasharray", c.dataset.targetDasharray);
        c.setAttribute("stroke-dashoffset", c.dataset.targetDashoffset);
      });
    });
  });
}

function donutLegendHtml(segments) {
  const total = segments.reduce((s, x) => s + x.count, 0);
  return segments.filter(s => s.count > 0).map(s => `
    <div class="donut-legend-item">
      <span class="dot" style="background:var(${s.colorVar})"></span>
      <span class="name">${esc(s.label)}</span>
      <span class="count">${s.count}${total ? ` · ${Math.round(s.count / total * 100)}%` : ""}</span>
    </div>
  `).join("") || `<div class="no-assignee">Пока нет данных</div>`;
}

// ---------- Обзор ----------

async function loadOverview() {
  const root = $("#overview-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d;
  try {
    d = await apiGet("/overview");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить обзор: ${esc(e.message)}</div>`;
    return;
  }

  const segments = d.reports.statuses.map(s => ({
    label: s.label, count: s.count, colorVar: STATUS_COLOR_VAR[s.status] || "--s-draft",
  }));

  root.innerHTML = `
    <div class="bento">
      <div class="bcell wide" style="animation-delay:0ms;">
        <h3>Структура загрузки</h3>
        <div class="donut-wrap">
          ${donutHtml(segments)}
          <div class="donut-legend">${donutLegendHtml(segments)}</div>
        </div>
      </div>
      <div class="bcell" style="animation-delay:60ms;">
        <h3>Всего активных</h3>
        <div class="big-num">${d.reports.total - (d.reports.statuses.find(s => s.status === "completed")?.count || 0) - (d.reports.statuses.find(s => s.status === "cancelled")?.count || 0)}</div>
        <div class="sub">из ${d.reports.total} всего</div>
      </div>
      <div class="bcell" style="animation-delay:100ms;">
        <h3>Просрочено</h3>
        <div class="big-num ${d.reports.overdue > 0 ? "danger" : ""}">${d.reports.overdue}</div>
        <div class="sub">${d.reports.important} важных (высокий/срочный)</div>
      </div>
      <div class="bcell" style="animation-delay:140ms;">
        <h3>Доступ</h3>
        <div class="big-num">${d.access.allowed}</div>
        <div class="sub">${d.access.pending_requests ? `${d.access.pending_requests} заявок ждут решения` : "заявок нет"}</div>
      </div>
      <div class="bcell" style="animation-delay:180ms;">
        <h3>Тикеты в поддержку</h3>
        <div class="big-num ${d.open_tickets > 0 ? "warn" : ""}">${d.open_tickets}</div>
        <div class="sub">открыто сейчас</div>
      </div>
      <div class="bcell wide" style="animation-delay:220ms;">
        <h3>Топ исполнителей</h3>
        <div class="mini-list">
          ${d.performers.length ? d.performers.map((p, i) => `
            <div class="mini-row">
              <span class="rank">${i + 1}</span>
              <span class="avatar-bubble" style="margin-left:0;">${esc(initials(p.name))}</span>
              <span class="name">${esc(p.name)}</span>
              <span class="val">${p.assigned} назначено${p.overdue ? ` · ⏰${p.overdue}` : ""}</span>
            </div>
          `).join("") : `<div class="no-assignee">Пока нет данных</div>`}
        </div>
      </div>
      ${d.birthdays.length ? `
      <div class="bcell" style="animation-delay:260ms;">
        <h3>Дни рождения</h3>
        <div class="mini-list">
          ${d.birthdays.map(b => `
            <div class="mini-row"><span class="name">🎂 ${esc(b.name)}</span><span class="val">${b.day}.${String(b.month).padStart(2, "0")}</span></div>
          `).join("")}
        </div>
      </div>` : ""}
    </div>
  `;
  playDonutIntro(root);
}

// ---------- Я (профиль) ----------
// Разметка и логика ниже — портированы «в точь-точь» из мини-аппа
// (miniapp/static/index.html: profileHtml/teamTeaserHtml/statDonutHtml/
// goalRingHtml/rankTagHtml/tenureTier/avatarHtml), под тот же /api/me.

const BADGE_RARITY_ORDER = { legendary: 0, epic: 1, rare: 2, common: 3, custom: 0 };
const MONTHS_RU = ["", "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function avatarHtml(telegramId, name, size) {
  const initial = esc((name || "?").trim().charAt(0).toUpperCase() || "?");
  const cls = size === "xl" ? " xl" : (size === "sm" ? " sm" : "");
  return `<span class="avatar${cls}" data-avatar-for="${telegramId || ""}">${initial}</span>`;
}

// Реальные фото участников подгружаются лениво поверх инициалов —
// тот же приём, что в мини-аппе: отдельный <img>, а не background,
// чтобы молча остаться на инициалах при 204/ошибке сети (см. /api/avatar).
function loadAvatars(root) {
  (root || document).querySelectorAll("[data-avatar-for]").forEach(el => {
    const tid = el.getAttribute("data-avatar-for");
    if (!tid || el.getAttribute("data-avatar-loaded")) return;
    el.setAttribute("data-avatar-loaded", "1");
    const img = new Image();
    img.onload = () => { el.innerHTML = ""; el.appendChild(img); };
    img.onerror = () => {};
    img.src = `${API_BASE}/avatar/${tid}?init_data=${encodeURIComponent(state.token)}`;
  });
}

// Своя картинка баннера профиля (/api/banner/{id}) — 204, если её нет
// (пресет/пусто), тогда молча остаёмся на градиенте из CSS.
function loadProfileBanner(el, telegramId) {
  if (!el || !telegramId) return;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url(${img.src})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  };
  img.onerror = () => {};
  img.src = `${API_BASE}/banner/${telegramId}?init_data=${encodeURIComponent(state.token)}`;
}

// Кольцо аватара по стажу в команде — те же пороги, что в мини-аппе.
function tenureTier(days) {
  if (days == null) return null;
  if (days >= 365) return "gold";
  if (days >= 180) return "silver";
  if (days >= 30) return "bronze";
  return null;
}

function roleMeta(role) {
  const r = (role || "").toLowerCase();
  if (r.includes("актр") || r.includes("актё") || r.includes("дублир")) return { ic: "🎙", c: "var(--sakura)" };
  if (r.includes("режисс")) return { ic: "🎬", c: "var(--fire)" };
  if (r.includes("звукореж")) return { ic: "🔊", c: "var(--s-review)" };
  if (r.includes("перевод")) return { ic: "📝", c: "var(--gold)" };
  if (r.includes("тайпсет") || r.includes("тайминг")) return { ic: "⏱", c: "var(--ember)" };
  if (r.includes("монтаж")) return { ic: "🎞", c: "var(--sakura)" };
  if (r.includes("дизайн")) return { ic: "✏️", c: "var(--gold)" };
  return { ic: "🎭", c: "var(--fire)" };
}

function rankTagHtml(rank) {
  if (!rank) return "";
  const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const medal = medals[rank.place] || "🏅";
  return `<span class="rank-tag rank-${rank.place <= 3 ? rank.place : "other"}">${medal} #${rank.place} из ${rank.total}</span>`;
}

function goalRingHtml(pct, over) {
  const r = 30, c = 2 * Math.PI * r;
  return `<svg class="goal-ring" viewBox="0 0 70 70" width="70" height="70">
    <circle class="goal-ring-track" cx="35" cy="35" r="${r}"></circle>
    <circle class="goal-ring-fill${over ? " over" : ""}" cx="35" cy="35" r="${r}"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${c.toFixed(2)}"
      data-target-offset="${(c - (pct / 100) * c).toFixed(2)}"></circle>
  </svg>`;
}

function teamTeaserHtml(me) {
  if (!me.team || !me.team.count) return "";
  const stack = me.team.preview.map(u => avatarHtml(u.telegram_id, u.name, "sm")).join("");
  const names = me.team.preview.map(u => u.name).join(", ");
  return `
    <div class="team-teaser" id="team-teaser">
      <span class="stack">${stack}</span>
      <div><div class="tt">${me.team.count} ${pluralColleagues(me.team.count)} по студии</div>
      ${names ? `<div class="tsub">${esc(names)}${me.team.count > me.team.preview.length ? " и др." : ""}</div>` : ""}</div>
      <span class="go">→</span>
    </div>`;
}

// «Структура загрузки» — донат по статусам активных отчётов + разбивка
// по ролям пайплайна, одной озаглавленной карточкой (как в мини-аппе),
// с явным пустым состоянием вместо того, чтобы просто не показывать
// раздел при отсутствии данных.
function loadStructureHtml(me) {
  const hasReports = me.reports && me.reports.length;
  const hasRoles = me.role_breakdown && me.role_breakdown.length;
  if (!hasReports && !hasRoles) {
    return `
      <div class="sec-title">📊 Структура загрузки</div>
      <div class="stat-donut-card stat-donut-empty">🕊️ Пока нечего показать — нет ни одного активного отчёта на руках</div>
    `;
  }
  const statusCounts = {};
  for (const r of me.reports || []) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  const segments = Object.entries(STATUS_COLOR_VAR)
    .filter(([status]) => statusCounts[status])
    .map(([status, colorVar]) => ({
      label: state.statusOptions.find(([v]) => v === status)?.[1] || status,
      count: statusCounts[status],
      colorVar,
    }));
  const donutBlock = hasReports ? `
    <div class="donut-wrap">
      ${donutHtml(segments)}
      <div class="donut-legend">${donutLegendHtml(segments)}</div>
    </div>` : "";
  const roleBlock = hasRoles ? `
    <div style="margin-top:${hasReports ? "14px" : "0"}; font-size:12px; font-weight:700; color:var(--ink-soft); margin-bottom:6px;">Роли в пайплайне</div>
    ${me.role_breakdown.map(rb => `
      <div class="role-bar-row">
        <div class="label"><span>${esc(rb.role)}</span><span>${rb.count} · ${rb.pct}%</span></div>
        <div class="role-bar-track"><div class="role-bar-fill" data-pct="${rb.pct}"></div></div>
      </div>
    `).join("")}` : "";
  return `
    <div class="sec-title">📊 Структура загрузки</div>
    <div class="stat-donut-card">${donutBlock}${roleBlock}</div>
  `;
}

// ---------- Режим разработчика (/api/dev/*, только для owner) ----------
// Тумблер хранится в localStorage, как и в мини-аппе — чисто
// косметическое переключение, что показать (панель правки на карточке).
// Авторизацию на КАЖДОЕ действие сервер всё равно проверяет заново по
// OWNER_IDS (_require_owner) — фронту тут доверять нельзя.

const DEV_MODE_KEY = "phoenix-dev-mode";
function isDevModeOn() {
  try { return localStorage.getItem(DEV_MODE_KEY) === "1"; } catch (_) { return false; }
}
function setDevModeOn(on) {
  try { localStorage.setItem(DEV_MODE_KEY, on ? "1" : "0"); } catch (_) {}
}
function devModeActive() { return !!state.isDeveloper && isDevModeOn(); }

let META_ROLES = null;
async function loadMetaRoles() {
  if (META_ROLES) return META_ROLES;
  try { META_ROLES = (await apiGet("/meta")).roles || []; } catch (_) { META_ROLES = []; }
  return META_ROLES;
}

function devPanelHtml(d) {
  return `
    <div class="sec-title" style="margin-top:16px;">🛠 Служебные данные</div>
    <div class="dev-bento">
      <div class="dev-bcell wide">
        <div class="h">Идентификаторы</div>
        <div class="ro-line"><span>telegram_id</span><b>${d.telegram_id}</b></div>
        <div class="ro-line"><span>internal id</span><b>${d.internal_id != null ? d.internal_id : "—"}</b></div>
        <div class="ro-line"><span>в базе с</span><b style="font-family:inherit; font-weight:400;">${esc(d.created_at || "—")}</b></div>
      </div>
      <div class="dev-bcell wide">
        <div class="h">Роль</div>
        <select id="dev-role-select" class="field-input"><option value="">— загрузка…</option></select>
        <button id="dev-role-save" class="dev-save-btn">Сохранить роль</button>
      </div>
      <div class="dev-bcell wide">
        <div class="h">Статус и о себе</div>
        <input type="text" id="dev-status-input" class="field-input" maxlength="80" placeholder="Короткий статус" value="${esc(d.status_text || "")}">
        <textarea id="dev-bio-input" class="field-textarea" maxlength="300" placeholder="О себе">${esc(d.bio || "")}</textarea>
        <button id="dev-profile-save" class="dev-save-btn">Сохранить профиль</button>
      </div>
      <div class="dev-bcell">
        <div class="h">Дата вступления</div>
        <input type="date" id="dev-joined-input" class="field-input" value="${esc((d.created_at || "").slice(0, 10))}">
        <button id="dev-joined-save" class="dev-save-btn">Сохранить</button>
      </div>
      <div class="dev-bcell">
        <div class="h">Выдать награду</div>
        <div class="dev-badge-row">
          <input type="text" id="dev-badge-icon" class="field-input" placeholder="🐉" maxlength="8">
          <input type="text" id="dev-badge-label" class="field-input" placeholder="Название" maxlength="60">
        </div>
        <button id="dev-badge-grant" class="dev-save-btn">Выдать</button>
      </div>
    </div>
  `;
}

function wireDevPanel(root, telegramId, onSaved) {
  loadMetaRoles().then(roles => {
    const sel = root.querySelector("#dev-role-select");
    if (!sel) return;
    sel.innerHTML = `<option value="">— без роли —</option>` + roles.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
  });

  const roleBtn = root.querySelector("#dev-role-save");
  if (roleBtn) roleBtn.addEventListener("click", async () => {
    const role = root.querySelector("#dev-role-select").value;
    roleBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/role`, { role });
      toast("Роль обновлена.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить роль: ${e.message}`, "error"); }
    finally { roleBtn.disabled = false; }
  });

  const profileBtn = root.querySelector("#dev-profile-save");
  if (profileBtn) profileBtn.addEventListener("click", async () => {
    const status_text = root.querySelector("#dev-status-input").value;
    const bio = root.querySelector("#dev-bio-input").value;
    profileBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/profile`, { status_text, bio });
      toast("Профиль обновлён.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить профиль: ${e.message}`, "error"); }
    finally { profileBtn.disabled = false; }
  });

  const joinedBtn = root.querySelector("#dev-joined-save");
  if (joinedBtn) joinedBtn.addEventListener("click", async () => {
    const date = root.querySelector("#dev-joined-input").value;
    if (!date) { toast("Укажите дату.", "error"); return; }
    joinedBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/joined`, { date });
      toast("Дата вступления обновлена.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось сохранить дату: ${e.message}`, "error"); }
    finally { joinedBtn.disabled = false; }
  });

  const badgeBtn = root.querySelector("#dev-badge-grant");
  if (badgeBtn) badgeBtn.addEventListener("click", async () => {
    const icon = root.querySelector("#dev-badge-icon").value || "🏅";
    const label = root.querySelector("#dev-badge-label").value.trim();
    if (!label) { toast("Нужно название награды.", "error"); return; }
    badgeBtn.disabled = true;
    try {
      await apiPost(`/dev/user/${telegramId}/badge`, { icon, label });
      toast("Награда выдана.");
      if (onSaved) await onSaved();
    } catch (e) { toast(`Не удалось выдать награду: ${e.message}`, "error"); }
    finally { badgeBtn.disabled = false; }
  });
}

// ---------- Команда / чужой профиль ----------

async function openTeamSheet() {
  const overlay = openSheet(dialogSkeletonHtml(6), "wide");
  overlay.querySelector(".sheet").innerHTML = `<h2>Команда</h2>` + dialogSkeletonHtml(6);
  let d;
  try {
    d = await apiGet("/team");
  } catch (e) {
    overlay.querySelector(".sheet").innerHTML = `<h2>Команда</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const rows = (d.users || []).map(u => `
    <div class="team-row" data-open-user="${u.telegram_id}">
      ${avatarHtml(u.telegram_id, u.name, "sm")}
      <span class="online-dot${u.online ? "" : " off"}"></span>
      <div class="nm"><div class="n">${esc(u.name)}${u.is_owner ? ` <span class="dev-pill">DEV</span>` : ""}</div><div class="r">${esc(u.role || "без роли")}</div></div>
      <div class="stat">${u.assigned} сейчас · ${u.completed_total} закрыто</div>
    </div>
  `).join("");
  overlay.querySelector(".sheet").innerHTML = `
    <h2>Команда · ${d.users.length}</h2>
    <div class="team-list">${rows || `<div class="bento-empty">Пока никого нет.</div>`}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  const sheet = overlay.querySelector(".sheet");
  loadAvatars(sheet);
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelectorAll("[data-open-user]").forEach(row => {
    row.addEventListener("click", () => openUserProfile(parseInt(row.dataset.openUser, 10)));
  });
}

async function openUserProfile(telegramId) {
  const overlay = openSheet(dialogSkeletonHtml(6), "wide");
  let d;
  try {
    d = await apiGet(`/user/${telegramId}`);
  } catch (e) {
    overlay.querySelector(".sheet").innerHTML = `<div class="bento-empty">Не удалось загрузить профиль: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  d.telegram_id = telegramId;
  const reportsHtml = (d.reports && d.reports.length) ? `
    <div class="sec-title" style="margin-top:16px;">📋 Текущие отчёты</div>
    <div class="mini-list">
      ${d.reports.map(r => `<div class="mini-row" data-open-report="${esc(r.public_id)}" style="cursor:pointer;"><span class="name">${esc(r.public_id)} · ${esc(r.title)}</span><span class="val">${esc(r.status_label)}</span></div>`).join("")}
    </div>` : "";

  const sheet = overlay.querySelector(".sheet");
  sheet.innerHTML = `
    ${profileHeaderHtml(d)}
    <div class="bento">${badgesBentoHtml(d, 0)}</div>
    ${reportsHtml}
    ${devModeActive() ? devPanelHtml(d) : ""}
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  wireProfileCommon(sheet, telegramId);
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelectorAll("[data-open-report]").forEach(row => {
    row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
  if (devModeActive()) wireDevPanel(sheet, telegramId, async () => { await openUserProfile(telegramId); overlay.remove(); });
}

// Шапка + тизер команды + цитата статуса + био + метастрока + «Структура
// загрузки» — общая часть между своей «Я» и карточкой коллеги (тот же
// приём, что и в мини-аппе: /api/me и /api/user/{id} отдают совместимую
// форму, поэтому и разметка одна на двоих).
function profileHeaderHtml(d) {
  const tier = tenureTier(d.member_since_days);
  const rMeta = roleMeta(d.role);
  const roleLabel = d.role ? esc(d.role) : "Участник PHOENIX";

  let joinedLine = "";
  if (d.created_at) {
    const jd = new Date(d.created_at.replace(" ", "T") + "Z");
    if (!isNaN(jd.getTime())) {
      joinedLine = ` · в команде с ${jd.getUTCDate()} ${MONTHS_RU[jd.getUTCMonth() + 1]}. ${jd.getUTCFullYear()}`;
    }
  }

  return `
    <div class="profile-banner-wrap" data-role="profile-banner"></div>
    <div class="profile-head-card">
      <span class="avatar-ring${tier ? " tier-" + tier : ""}">${avatarHtml(d.telegram_id, d.display_name || d.name, "xl")}</span>
      <div class="nm-row">
        <span class="nm">${esc(d.display_name || d.name)}</span>
        ${d.is_developer || d.is_owner ? `<span class="dev-pill">DEV</span>` : ""}
        ${rankTagHtml(d.studio_rank)}
      </div>
      ${d.username ? `<div class="un">@${esc(d.username)}</div>` : ""}
      ${d.internal_id != null ? `<div class="id-row"><span class="id-chip">#${d.internal_id}</span>${joinedLine}${d.is_online ? ` · <span style="color:var(--s-done); font-weight:600;">в сети</span>` : ""}</div>` : ""}
      <span class="role-tag" style="--tag-c:${rMeta.c}">${rMeta.ic} ${roleLabel}</span>
    </div>

    ${teamTeaserHtml(d)}
    ${d.status_text ? `<div class="status-quote">💬 ${esc(d.status_text)}</div>` : ""}
    ${d.bio ? `<div class="profile-bio">${esc(d.bio)}</div>` : ""}

    <div class="bc-meta-line">📋 ${d.assigned} на нём сейчас${d.overdue ? ` · <span class="warn">⏰ ${d.overdue} просрочено</span>` : ""}${d.avg_days != null ? ` · ⏱ в среднем ${d.avg_days.toFixed ? d.avg_days.toFixed(1) : d.avg_days} дн.` : ""}</div>

    ${loadStructureHtml(d)}
  `;
}

// Достижения — общий бенто-блок, тоже переиспользуется для «Я» и чужого профиля.
function badgesBentoHtml(d, delayMs) {
  const unlocked = (d.badges || []).slice().sort((a, b) => (BADGE_RARITY_ORDER[a.rarity] ?? 9) - (BADGE_RARITY_ORDER[b.rarity] ?? 9));
  return `
    <div class="bcell wide" style="animation-delay:${delayMs}ms;">
      <h3>Достижения</h3>
      <div class="badge-grid">
        ${unlocked.map(b => `
          <div class="badge-item ${b.unlocked ? "unlocked" : ""}" title="${esc(b.label)}${!b.unlocked && b.target ? ` — ${b.current}/${b.target}` : ""}">
            <div>${esc(b.icon)}</div>
            <span class="lbl">${esc(b.label)}</span>
          </div>
        `).join("")}
      </div>
    </div>`;
}

function wireProfileCommon(root, telegramId) {
  loadAvatars(root);
  loadProfileBanner(root.querySelector('[data-role="profile-banner"]'), telegramId);
  playDonutIntro(root);
  root.querySelectorAll(".role-bar-fill").forEach(el => {
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = el.dataset.pct + "%"; }));
  });
  root.querySelectorAll(".goal-ring-fill").forEach(el => {
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.strokeDashoffset = el.dataset.targetOffset; }));
  });
  const teaser = root.querySelector("#team-teaser");
  if (teaser) teaser.addEventListener("click", openTeamSheet);
}

async function loadProfile() {
  const root = $("#profile-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let me;
  try {
    me = await apiGet("/me");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить профиль: ${esc(e.message)}</div>`;
    return;
  }
  state.isDeveloper = !!me.is_developer; // используется для показа переключателя dev-режима в Настройках

  const goalSet = me.monthly_goal != null && me.monthly_goal > 0;
  const goalDone = me.completed_month || 0;
  const goalOver = goalSet && goalDone >= me.monthly_goal;
  const goalPct = goalSet ? Math.min(100, Math.round((goalDone / me.monthly_goal) * 100)) : 0;
  const goalCardHtml = goalSet ? `
    <div class="bcell wide goal-card with-ring" id="goal-card">
      <div class="goal-ring-wrap">${goalRingHtml(goalPct, goalOver)}
        <div class="goal-ring-label"><b>${goalDone}</b><span>из ${me.monthly_goal}</span></div>
      </div>
      <div><div class="cap">${goalOver ? "✅ цель выполнена" : `цель месяца · <b>${goalPct}%</b>`}</div>
      <div class="edit-hint">изменить →</div></div>
    </div>
  ` : `
    <div class="bcell wide goal-card" id="goal-card">
      <h3>Цель месяца</h3>
      <div class="goal-hint" style="margin-top:4px;">🎯 Цель на месяц не задана — нажмите, чтобы поставить себе план.</div>
    </div>
  `;

  root.innerHTML = `
    ${profileHeaderHtml(me)}
    <div class="bento">
      ${goalCardHtml}
      <div class="bcell" style="animation-delay:60ms;">
        <h3>Закрыто</h3>
        <div class="big-num">${me.completed_total}</div>
        <div class="sub">${me.completed_week} за неделю · ${me.completed_month} за месяц</div>
      </div>
      <div class="bcell" style="animation-delay:100ms;">
        <h3>Вовремя</h3>
        <div class="big-num">${me.on_time_pct != null ? me.on_time_pct + "%" : "—"}</div>
        <div class="sub">${me.avg_days != null ? `в среднем ${me.avg_days.toFixed(1)} дн. на отчёт` : ""}</div>
      </div>
      ${badgesBentoHtml(me, 140)}
    </div>
    ${devModeActive() ? devPanelHtml(me) : ""}
  `;
  wireProfileCommon(root, me.telegram_id);
  root.querySelector("#goal-card").addEventListener("click", () => monthlyGoalDialog(me.monthly_goal));
  if (devModeActive()) wireDevPanel(root, me.telegram_id, () => loadProfile());
}

function monthlyGoalDialog(current) {
  const overlay = openSheet(`
    <h2>Цель на месяц</h2>
    <p style="color:var(--ink-soft); font-size:12.5px; margin-top:-8px;">Сколько отчётов хотите закрыть в этом месяце. 0 — снять цель.</p>
    <div class="row"><input type="number" id="dlg-goal" min="0" max="500" value="${current || 0}"></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Сохранить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const goal = Number(overlay.querySelector("#dlg-goal").value) || 0;
    try {
      await apiPost("/me/goal", { goal });
      toast(goal ? "Цель сохранена." : "Цель снята.");
      overlay.remove();
      await loadProfile();
    } catch (e) {
      toast(`Не удалось сохранить цель: ${e.message}`, "error");
    }
  });
}

function pluralColleagues(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "коллега";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "коллеги";
  return "коллег";
}

// ---------- Доска (канбан по статусам, /api/board) ----------
// Список статусов и их порядок приходят прямо в ответе /api/board
// (d.statuses) — не дублируем их отдельной константой на клиенте.

function boardCardHtml(r) {
  const overdue = isOverdue(r);
  return `
    <div class="board-card" data-open="${esc(r.public_id)}">
      <div class="id">${esc(r.public_id)}</div>
      <div class="ttl">${esc(r.title)}</div>
      <div class="foot">
        ${assigneesHtml(r.assignees)}
        <span class="deadline ${overdue ? "overdue" : ""}">${overdue ? "⏰ " : ""}${esc(r.deadline || "—")}</span>
      </div>
    </div>`;
}

function wireBoardCards(root) {
  root.querySelectorAll(".board-card[data-open]").forEach(el => {
    el.addEventListener("click", () => openReportDetail(el.dataset.open));
  });
}

async function loadBoard() {
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
        <div class="board-col" data-status="${esc(col.status)}">
          <div class="board-col-head">
            <span class="lb"><span class="dot ${STATUS_DOT_CLASS[col.status] || "draft"}"></span>${esc(col.label)}</span>
            <span class="cnt">${col.total}</span>
          </div>
          <div class="board-cards" data-count="${col.reports.length}">
            ${col.reports.length ? col.reports.map(boardCardHtml).join("") : `<div class="board-col-empty">пусто</div>`}
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
        cardsEl.insertAdjacentHTML("beforeend", res.reports.map(boardCardHtml).join(""));
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

// ---------- Тайтлы (голосование, /api/public/*) ----------
// Портировано из мини-аппа: loadVote/renderVoteTitles/voteBentoHtml/
// voteCardHtml/castVote/openTitleDetailPublic (miniapp/static/index.html).

function imgProxy(url) {
  if (!url) return "";
  return `${API_BASE}/img_proxy?url=${encodeURIComponent(url)}&init_data=${encodeURIComponent(state.token)}`;
}

const TD_ICONS = {
  episodes: '<span class="td-ic square"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="M10 9.3v5.4l4.6-2.7z" fill="currentColor" stroke="none"></path></svg></span>',
  schedule: '<span class="td-ic square"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"></rect><path d="M3.5 9.5h17M8 2.5v4M16 2.5v4M7.2 13.2h3.4M7.2 16.8h6.6"></path></svg></span>',
  source: '<span class="td-ic round"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7.2"></circle><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"></circle></svg></span>',
  crew: '<span class="td-ic round"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.7" cy="9" r="2.5"></circle><path d="M3.8 17.8c0-2.7 2.1-4.4 4.9-4.4s4.9 1.7 4.9 4.4"></path><circle cx="16.2" cy="8.3" r="2"></circle><path d="M14.9 12.1c2 .2 3.6 1.6 3.6 3.8"></path></svg></span>',
};

function titleDetailMetaRowsHtml(det) {
  if (!det) return "";
  const rows = [];

  const epParts = [];
  if (det.episodes_aired != null && det.episodes_total) epParts.push(`${det.episodes_aired} из ${det.episodes_total} эп.`);
  else if (det.episodes_total) epParts.push(`${det.episodes_total} эп.`);
  if (det.duration_min) epParts.push(`по ~${det.duration_min} мин.`);
  if (epParts.length) rows.push(`<div class="td-meta-row">${TD_ICONS.episodes}<span>${esc(epParts.join(" "))}</span></div>`);

  const statusParts = [det.kind_label, det.status_label].filter(Boolean);
  if (statusParts.length) rows.push(`<div class="td-meta-row">${TD_ICONS.schedule}<span>${esc(statusParts.join(", "))}</span></div>`);

  if (det.source_label) rows.push(`<div class="td-meta-row">${TD_ICONS.source}<span>Первоисточник ${esc(det.source_label)}</span></div>`);

  const crewParts = [det.studio, det.author, det.director].filter(Boolean);
  if (crewParts.length) rows.push(`<div class="td-meta-row">${TD_ICONS.crew}<span>${esc(crewParts.join(" · "))}</span></div>`);

  return rows.join("");
}

function voteActivity(t) { return t.likes + t.dislikes; }

// Лидер сезона — только если реально есть за что бороться (хоть один
// голос с перевесом), иначе на свежем сезоне без голосов "лидером"
// стал бы случайный первый по порядку тайтл.
function voteSeasonTop(titles) {
  const ranked = titles.filter(t => t.likes > t.dislikes)
    .sort((a, b) => (b.likes - b.dislikes) - (a.likes - a.dislikes));
  return ranked[0] || null;
}

function voteBentoHtml(titles, top) {
  const totalVotes = titles.reduce((s, t) => s + voteActivity(t), 0);

  const statsHtml = `
    <div class="bcell"><h3>Тайтлов в сезоне</h3><div class="big-num">${titles.length}</div></div>
    <div class="bcell"><h3>Голосов подано</h3><div class="big-num">${totalVotes}</div></div>
  `;

  if (!top) return `<div class="bento">${statsHtml}</div>`;

  const poster = top.poster_url
    ? `<img class="vote-hero-poster" src="${imgProxy(top.poster_url)}" alt="" data-open-title-detail="${top.id}">`
    : `<div class="vote-hero-poster vote-poster-ph" data-open-title-detail="${top.id}">🎬</div>`;

  const heroHtml = `
    <div class="bcell wide vote-hero">
      ${poster}
      <div class="vote-hero-body">
        <div data-open-title-detail="${top.id}" style="cursor:pointer;">
          <span class="vote-hero-tag">🏆 Топ сезона</span>
          <div class="vote-hero-name">${esc(top.name)}</div>
        </div>
        <div class="vote-actions">
          <button class="vote-btn${top.my_vote === 1 ? " on-like" : ""}" data-vote-title="${top.id}" data-vote-choice="1">👍 <span>${top.likes}</span></button>
          <button class="vote-btn${top.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${top.id}" data-vote-choice="-1">👎 <span>${top.dislikes}</span></button>
        </div>
      </div>
    </div>`;

  return `<div class="bento">${statsHtml}${heroHtml}</div>`;
}

function voteCardHtml(t) {
  const poster = t.poster_url
    ? `<img class="vote-poster" src="${imgProxy(t.poster_url)}" alt="" loading="lazy">`
    : `<div class="vote-poster vote-poster-ph">🎬</div>`;
  const voteCls = t.my_vote === 1 ? " voted-like" : (t.my_vote === -1 ? " voted-dislike" : "");

  return `
    <div class="vote-card${voteCls}">
      <div class="vote-card-tap" data-open-title-detail="${t.id}">
        ${poster}
        <div class="vote-name">${esc(t.name)}</div>
      </div>
      <div class="vote-actions">
        <button class="vote-btn${t.my_vote === 1 ? " on-like" : ""}" data-vote-title="${t.id}" data-vote-choice="1">👍 <span>${t.likes}</span></button>
        <button class="vote-btn${t.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${t.id}" data-vote-choice="-1">👎 <span>${t.dislikes}</span></button>
      </div>
    </div>`;
}

async function castVote(titleId, choice, btn) {
  const card = btn.closest(".vote-card") || btn.closest(".vote-hero");
  const likeBtn = card.querySelector('[data-vote-choice="1"]');
  const dislikeBtn = card.querySelector('[data-vote-choice="-1"]');
  const already = btn.classList.contains(choice === 1 ? "on-like" : "on-dislike");
  const vote = already ? 0 : choice;

  card.classList.add("vote-pending");
  try {
    const r = await apiPost(`/public/titles/${titleId}/vote`, { vote });
    likeBtn.classList.toggle("on-like", r.my_vote === 1);
    dislikeBtn.classList.toggle("on-dislike", r.my_vote === -1);
    likeBtn.querySelector("span").textContent = r.likes;
    dislikeBtn.querySelector("span").textContent = r.dislikes;
  } catch (e) {
    toast(e.message, "error");
  } finally {
    card.classList.remove("vote-pending");
  }
}

function wireVoteButtons(root) {
  root.querySelectorAll("[data-vote-title]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      castVote(parseInt(btn.dataset.voteTitle, 10), parseInt(btn.dataset.voteChoice, 10), btn);
    });
  });
  root.querySelectorAll("[data-open-title-detail]").forEach(el => {
    el.addEventListener("click", () => openTitleDetail(parseInt(el.dataset.openTitleDetail, 10)));
  });
}

async function openTitleDetail(titleId) {
  const overlay = openSheet(dialogSkeletonHtml(4));
  let d;
  try {
    d = await apiGet(`/public/titles/${titleId}`);
  } catch (e) {
    overlay.querySelector(".sheet").innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить тайтл: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const det = d.details && Array.isArray(d.details) ? null : d.details;
  const poster = d.poster_url ? imgProxy(d.poster_url) : "";
  const posterHtml = poster ? `<img class="td-poster" src="${poster}" alt="">` : `<div class="td-poster">🎬</div>`;
  const bgHtml = poster ? `<div class="td-bg" style="background-image:url(${poster})"></div>` : "";

  overlay.querySelector(".sheet").innerHTML = `
    <div class="td-hero">
      ${bgHtml}
      <div class="td-poster-wrap">${posterHtml}</div>
    </div>
    <div class="td-body">
      <div class="td-name">${esc(d.name)}</div>
      ${det && det.name_original ? `<div class="td-name-original">${esc(det.name_original)}</div>` : ""}
      ${d.season_name ? `<div class="td-chip">${esc(d.season_name)}</div>` : ""}
      <div class="td-stat-row">
        <span class="td-stat-pill like">👍 ${d.likes}</span>
        <span class="td-stat-pill dislike">👎 ${d.dislikes}</span>
      </div>
      <div class="td-vote-cta">
        <button class="${d.my_vote === 1 ? "on-like" : ""}" data-vote-title="${d.id}" data-vote-choice="1">👍 Нравится</button>
        <button class="${d.my_vote === -1 ? "on-dislike" : ""}" data-vote-title="${d.id}" data-vote-choice="-1">👎 Не то</button>
      </div>
      ${det ? `
      <div class="td-meta">${titleDetailMetaRowsHtml(det)}</div>
      ${det.genres && det.genres.length ? `<div class="td-genre-row">${det.genres.map(g => `<span class="td-genre-chip">${esc(g)}</span>`).join("")}</div>` : ""}
      ${det.description ? `<div class="td-desc">${esc(det.description)}</div>` : ""}
      ` : ""}
    </div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  wireVoteButtons(overlay);
}

state.titleSeasonId = null;

async function loadTitlesTab() {
  const root = $("#titles-body");
  root.innerHTML = dialogSkeletonHtml(3);
  let d;
  try {
    d = await apiGet("/public/seasons");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить сезоны: ${esc(e.message)}</div>`;
    return;
  }
  if (!d.seasons.length) {
    root.innerHTML = `<div class="empty-state"><div style="font-size:34px; margin-bottom:8px;">📅</div>Эфир-сезонов пока нет.</div>`;
    return;
  }
  if (state.titleSeasonId == null || !d.seasons.some(s => s.id === state.titleSeasonId)) {
    state.titleSeasonId = d.seasons[0].id;
  }
  renderTitlesForSeason(d.seasons);
}

function renderTitlesForSeason(seasons) {
  const root = $("#titles-body");
  root.innerHTML = `
    <div class="chip-row">
      ${seasons.map(s => `<button class="qchip${s.id === state.titleSeasonId ? " on" : ""}" data-season="${s.id}">${esc(s.name)}</button>`).join("")}
    </div>
    <div id="titles-grid">${dialogSkeletonHtml(3)}</div>
  `;
  root.querySelectorAll("[data-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.titleSeasonId = parseInt(btn.dataset.season, 10);
      renderTitlesForSeason(seasons);
    });
  });

  apiGet(`/public/seasons/${state.titleSeasonId}/titles`).then(d => {
    const wrap = $("#titles-grid");
    if (!wrap) return; // успели переключить сезон/вкладку, пока грузилось
    if (!d.titles.length) {
      wrap.innerHTML = `<div class="empty-state"><div style="font-size:34px; margin-bottom:8px;">🎬</div>Тайтлов в этом сезоне пока нет.</div>`;
      return;
    }
    const top = voteSeasonTop(d.titles);
    const gridTitles = top ? d.titles.filter(t => t.id !== top.id) : d.titles;
    wrap.innerHTML = voteBentoHtml(d.titles, top) + `<div class="vote-grid">${gridTitles.map(voteCardHtml).join("")}</div>`;
    wireVoteButtons(wrap);
  }).catch(e => {
    const wrap = $("#titles-grid");
    if (wrap) wrap.innerHTML = `<div class="bento-empty">Не удалось загрузить тайтлы: ${esc(e.message)}</div>`;
  });
}

// ---------- Лента (история изменений по отчётам + админ-лог) ----------
// Тот же /api/feed, что у мини-аппа — объединяет report_activity и
// (только для владельцев студии) admin_log, листается "Показать ещё".

function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + (iso.indexOf("Z") === -1 && iso.indexOf("+") === -1 ? "Z" : ""));
  if (isNaN(d.getTime())) return iso;
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "только что";
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH} ч назад`;
  const diffD = Math.round(diffH / 24);
  return `${diffD} дн назад`;
}

function feedMeta(ev) {
  if (ev.kind === "admin") return { ic: "🛡️", c: "var(--sakura)" };
  const a = ev.action || "";
  if (a.includes("создан")) return { ic: "🆕", c: "var(--s-done)" };
  if (a.includes("просрочк")) return { ic: "⚠️", c: "var(--s-stop)" };
  if (a.includes("Статус")) return { ic: "🔄", c: "var(--fire)" };
  if (a.includes("снят")) return { ic: "➖", c: "var(--ink-dim)" };
  if (a.includes("назначен")) return { ic: "👤", c: "var(--s-review)" };
  if (a.includes("Заметка")) return { ic: "📝", c: "var(--gold)" };
  if (a.includes("Файл")) return { ic: "📎", c: "var(--s-review)" };
  if (a.includes("Пайплайн")) return { ic: "⏭", c: "var(--ember)" };
  if (a.includes("дедлайн") || a.includes("Срок")) return { ic: "⏰", c: "var(--s-fix)" };
  if (a.includes("изменён")) return { ic: "✏️", c: "var(--ink-soft)" };
  return { ic: "•", c: "var(--ink-dim)" };
}

function feedItemHtml(ev) {
  const meta = feedMeta(ev);
  let actionText = esc(ev.action);
  if (ev.public_id) actionText += ` <span style="color:var(--fire); font-weight:700;">${esc(ev.public_id)}</span>`;
  const detailText = ev.detail ? `<div class="feed-detail">${esc(ev.detail)}</div>` : "";
  const titleText = ev.title ? `<div class="feed-detail" style="color:var(--ink-dim)">${esc(ev.title)}</div>` : "";
  const linkable = !!ev.public_id;
  return `
    <div class="feed-item">
      <div class="feed-dot" style="--fc:${meta.c}">${meta.ic}</div>
      <div class="feed-body${linkable ? " linkable" : ""}"${linkable ? ` data-open="${esc(ev.public_id)}"` : ""}>
        <div class="feed-action">${actionText}</div>
        ${titleText}${detailText}
        <div class="feed-meta">
          ${ev.kind === "admin" ? `<span style="color:var(--sakura); font-weight:700;">владелец</span><span class="sep">·</span>` : ""}
          <span>${esc(ev.actor)}</span><span class="sep">·</span><span>${relTime(ev.created_at)}</span>
        </div>
      </div>
    </div>`;
}

function wireFeedList(root) {
  root.querySelectorAll(".feed-body[data-open]").forEach(el => {
    el.addEventListener("click", () => openReportDetail(el.dataset.open));
  });
}

const FEED_PAGE_SIZE = 60;

async function loadFeed() {
  const root = $("#feed-body");
  root.innerHTML = dialogSkeletonHtml(6);
  let d;
  try {
    d = await apiGet("/feed", { offset: 0, page_size: FEED_PAGE_SIZE });
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить ленту: ${esc(e.message)}</div>`;
    return;
  }
  if (!d.events.length) {
    root.innerHTML = `<div class="empty-state"><div style="font-size:34px; margin-bottom:8px;">🕓</div>Пока тихо<div class="sub" style="margin-top:4px;">как только кто-то что-то сделает с отчётом — появится здесь</div></div>`;
    return;
  }
  root.innerHTML = `
    <div class="feed-list" id="feed-list" data-count="${d.events.length}">${d.events.map(feedItemHtml).join("")}</div>
    ${d.has_more ? `<button class="btn feed-load-more" id="feed-loadmore">Показать ещё (${d.total - d.events.length})</button>` : ""}
  `;
  wireFeedList(root);
  const loadMoreBtn = $("#feed-loadmore");
  if (loadMoreBtn) loadMoreBtn.addEventListener("click", async () => {
    const list = $("#feed-list");
    const offset = parseInt(list.dataset.count, 10) || 0;
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Загрузка…";
    try {
      const res = await apiGet("/feed", { offset, page_size: FEED_PAGE_SIZE });
      list.insertAdjacentHTML("beforeend", res.events.map(feedItemHtml).join(""));
      list.dataset.count = offset + res.events.length;
      wireFeedList(root);
      if (res.has_more) {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = `Показать ещё (${res.total - offset - res.events.length})`;
      } else {
        loadMoreBtn.remove();
      }
    } catch (e) {
      toast(`Не удалось загрузить ленту: ${e.message}`, "error");
      loadMoreBtn.disabled = false;
    }
  });
}

// ---------- запуск ----------

tryRestoreSession();
setTimeout(() => appWindow.show(), 0);
setTimeout(() => checkForUpdates(true), 3000);
