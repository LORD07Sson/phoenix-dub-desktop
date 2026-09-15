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

async function tryRestoreSession() {
  const token = await invoke("token_load");
  if (!token) return showAuth();
  state.token = token;
  try {
    const who = await api("GET", "/whoami");
    state.telegramId = who.telegram_id;
    showApp();
    await refreshAll();
  } catch (e) {
    // токен отозван/протух — просим войти заново, а не молча виснем.
    await invoke("token_clear").catch(() => {});
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
    <div class="row" style="align-items:center; justify-content:space-between;">
      <span>Версия ${esc(APP_VERSION)}</span>
      <button class="btn" id="s-check-update" style="padding:5px 12px; font-size:12.5px;">Проверить обновления</button>
    </div>
    <p style="color:var(--ink-soft); font-size:12.5px;">
      Ctrl+Shift+P — показать/скрыть окно из любого места, даже когда оно свёрнуто в трей.<br>
      Крестик у окна сворачивает в трей — опрос новых назначений продолжает идти в фоне.
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
  overlay.querySelector("#s-check-update").addEventListener("click", () => checkForUpdates(false));
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}
$("#open-settings").addEventListener("click", openSettings);

// ---------- автообновление ----------

const APP_VERSION = "0.4.2"; // держим в паре с VERSION/tauri.conf.json — только для показа в настройках

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

const BADGE_RARITY_ORDER = { legendary: 0, epic: 1, rare: 2, common: 3, custom: 0 };

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

  const statusCounts = {};
  for (const r of me.reports || []) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  const mySegments = Object.entries(STATUS_COLOR_VAR).map(([status, colorVar]) => ({
    label: state.statusOptions.find(([v]) => v === status)?.[1] || status,
    count: statusCounts[status] || 0,
    colorVar,
  }));

  const unlockedBadges = (me.badges || []).slice().sort((a, b) => (BADGE_RARITY_ORDER[a.rarity] ?? 9) - (BADGE_RARITY_ORDER[b.rarity] ?? 9));

  const goalSet = me.monthly_goal != null && me.monthly_goal > 0;
  const goalDone = me.completed_month || 0;
  const goalPct = goalSet ? Math.min(100, Math.round((goalDone / me.monthly_goal) * 100)) : 0;

  root.innerHTML = `
    <div class="profile-head">
      <div class="profile-head-inner">
        <div class="profile-avatar-wrap">
          <div class="profile-avatar">${esc(initials(me.display_name || me.name))}</div>
          <span class="profile-online-dot ${me.is_online ? "" : "offline"}" title="${me.is_online ? "в сети" : "не в сети"}"></span>
        </div>
        <div class="profile-head-info">
          <div class="profile-name-row">
            <h2>${esc(me.display_name || me.name)}</h2>
            ${me.studio_rank ? `<span class="rank-square" title="Место в студии за месяц по закрытым сериям">${me.studio_rank.place}</span>` : ""}
          </div>
          <div class="meta">
            ${me.username ? "@" + esc(me.username) : "ID " + me.telegram_id}${me.member_since_days != null ? ` · в студии ${me.member_since_days} дн.` : ""}
            ${me.is_online ? ` · <span class="online-text">в сети</span>` : ""}
          </div>
          <div class="profile-badges-chips">
            ${me.role ? `<span class="role-pill">${esc(me.role)}</span>` : ""}
            ${me.studio_rank ? `<span class="rank-chip">🏆 ${me.studio_rank.place} место из ${me.studio_rank.total} за месяц</span>` : ""}
            ${me.is_developer ? `<span class="rank-chip">🛠 Разработчик</span>` : ""}
          </div>
        </div>
      </div>
    </div>

    <div class="bento">
      <div class="bcell wide goal-card" id="goal-card" style="animation-delay:0ms;">
        <h3>Цель месяца</h3>
        ${goalSet ? `
          <div class="goal-label"><b>${goalDone} / ${me.monthly_goal}</b><span>${goalPct}%</span></div>
          <div class="goal-track"><div class="goal-fill" data-pct="${goalPct}"></div></div>
          <div class="goal-hint">закрыто отчётов в этом месяце · нажмите, чтобы изменить цель</div>
        ` : `
          <div class="goal-hint" style="margin-top:4px;">Цель не поставлена — нажмите, чтобы поставить себе план на месяц.</div>
        `}
      </div>
      <div class="bcell wide" style="animation-delay:30ms;">
        <h3>Мои активные отчёты</h3>
        <div class="donut-wrap">
          ${donutHtml(mySegments)}
          <div class="donut-legend">${donutLegendHtml(mySegments)}</div>
        </div>
      </div>
      <div class="bcell" style="animation-delay:60ms;">
        <h3>Назначено</h3>
        <div class="big-num">${me.assigned}</div>
        <div class="sub">${me.overdue ? `⏰ ${me.overdue} просрочено` : "просрочек нет"}</div>
      </div>
      <div class="bcell" style="animation-delay:100ms;">
        <h3>Закрыто</h3>
        <div class="big-num">${me.completed_total}</div>
        <div class="sub">${me.completed_week} за неделю · ${me.completed_month} за месяц</div>
      </div>
      <div class="bcell" style="animation-delay:140ms;">
        <h3>Вовремя</h3>
        <div class="big-num">${me.on_time_pct != null ? me.on_time_pct + "%" : "—"}</div>
        <div class="sub">${me.avg_days != null ? `в среднем ${me.avg_days.toFixed(1)} дн. на отчёт` : ""}</div>
      </div>
      ${me.role_breakdown && me.role_breakdown.length ? `
      <div class="bcell wide" style="animation-delay:180ms;">
        <h3>По ролям в пайплайне</h3>
        ${me.role_breakdown.map(rb => `
          <div class="role-bar-row">
            <div class="label"><span>${esc(rb.role)}</span><span>${rb.count} · ${rb.pct}%</span></div>
            <div class="role-bar-track"><div class="role-bar-fill" data-pct="${rb.pct}"></div></div>
          </div>
        `).join("")}
      </div>` : ""}
      ${me.team && me.team.count ? `
      <div class="bcell" style="animation-delay:220ms;">
        <h3>Коллеги</h3>
        <div class="team-teaser">
          <span class="avatar-stack">${me.team.preview.map(t => `<span class="avatar-bubble">${esc(initials(t.name))}</span>`).join("")}</span>
          <span class="sub">${me.team.count} ${pluralColleagues(me.team.count)}</span>
        </div>
      </div>` : ""}
      <div class="bcell wide" style="animation-delay:260ms;">
        <h3>Достижения</h3>
        <div class="badge-grid">
          ${unlockedBadges.map(b => `
            <div class="badge-item ${b.unlocked ? "unlocked" : ""}" title="${esc(b.label)}${!b.unlocked && b.target ? ` — ${b.current}/${b.target}` : ""}">
              <div>${esc(b.icon)}</div>
              <span class="lbl">${esc(b.label)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
  playDonutIntro(root);
  root.querySelectorAll(".role-bar-fill, .goal-fill").forEach(el => {
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = el.dataset.pct + "%"; }));
  });
  root.querySelector("#goal-card").addEventListener("click", () => monthlyGoalDialog(me.monthly_goal));
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

// ---------- запуск ----------

tryRestoreSession();
setTimeout(() => appWindow.show(), 0);
setTimeout(() => checkForUpdates(true), 3000);
