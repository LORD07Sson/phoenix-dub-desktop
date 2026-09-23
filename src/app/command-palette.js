// Командная палитра (Ctrl+K / Cmd+K) — быстрый переход по вкладкам,
// действиям и отчётам без мыши, тот же приём, что в VS Code/Linear.
// Overlay — тот же openSheet(), что и у остальных модалок: закрытие по
// Escape и клику по фону уже работает бесплатно (см. reports.js —
// глобальный keydown на Escape закрывает верхний ".overlay", ничего
// специального тут переопределять не нужно).

import { state } from "./state.js";
import { openSheet, apiGet } from "./api.js";
import { $, esc } from "./utils.js";
import { switchTab } from "./tabs.js";
import { openReportDetail } from "./report-detail.js";
import { recentReports } from "./recent-reports.js";

const ACTIONS = [
  { label: "Обзор", icon: "📊", run: () => switchTab("overview") },
  { label: "Список", icon: "📋", run: () => switchTab("list") },
  { label: "Доска", icon: "🗂", run: () => switchTab("board") },
  { label: "Тайтлы", icon: "🗳️", run: () => switchTab("titles") },
  { label: "Лента", icon: "🕘", run: () => switchTab("feed") },
  { label: "Я", icon: "👤", run: () => switchTab("profile") },
  { label: "Настройки", icon: "⚙️", run: () => $("#open-settings").click() },
  { label: "Обновить", icon: "↻", run: () => $("#refresh-btn").click() },
];

let searchDebounce = null;

function openPalette() {
  const overlay = openSheet(`
    <div class="cmdk-input-row">
      <span class="cmdk-ic">🔎</span>
      <input id="cmdk-input" placeholder="Перейти, найти отчёт, выполнить действие…" autocomplete="off">
    </div>
    <div id="cmdk-list" class="cmdk-list"></div>
  `);
  overlay.classList.add("cmdk-overlay");
  const input = overlay.querySelector("#cmdk-input");
  const list = overlay.querySelector("#cmdk-list");
  let items = []; // {label, icon, sub, run}
  let selected = 0;

  function renderList() {
    list.innerHTML = items.map((it, i) => `
      <div class="cmdk-item${i === selected ? " sel" : ""}" data-i="${i}">
        <span class="cmdk-ic">${esc(it.icon)}</span>
        <span class="cmdk-label">${esc(it.label)}</span>
        ${it.sub ? `<span class="cmdk-sub">${esc(it.sub)}</span>` : ""}
      </div>
    `).join("") || `<div class="cmdk-empty">Ничего не найдено</div>`;
    list.querySelectorAll(".cmdk-item").forEach(el => {
      // Подсветка — переключением класса, а не renderList(): раньше
      // каждый проезд мышью по пункту пересобирал весь список через
      // innerHTML (вместе с перевешиванием обработчиков) — на каждый
      // mouseenter, включая те, что порождал сам же пересбор.
      el.addEventListener("mouseenter", () => highlight(parseInt(el.dataset.i, 10)));
      el.addEventListener("click", () => activate(parseInt(el.dataset.i, 10)));
    });
  }

  function highlight(i) {
    selected = i;
    list.querySelectorAll(".cmdk-item").forEach(el => {
      el.classList.toggle("sel", Number(el.dataset.i) === selected);
    });
  }

  function activate(i) {
    const it = items[i];
    if (!it) return;
    overlay.remove();
    it.run();
  }

  function setItems(next) {
    items = next;
    selected = 0;
    renderList();
  }

  // Недавно открытые отчёты — только при пустом запросе, сверху над
  // действиями (тот же порядок, что в reportItems ниже: то, что скорее
  // всего искали, — первым). Как только начали печатать, это уже не
  // "куда я недавно заходил", а обычный поиск — MRU прячется.
  function recentItems() {
    return recentReports().map(r => ({
      label: r.title ? `${r.publicId} · ${r.title}` : r.publicId,
      icon: "🕘",
      sub: "недавнее",
      run: () => openReportDetail(r.publicId),
    }));
  }

  async function onInput() {
    const q = input.value.trim();
    const staticMatches = q
      ? ACTIONS.filter(a => a.label.toLowerCase().includes(q.toLowerCase()))
      : ACTIONS;
    const base = staticMatches.map(a => ({ label: a.label, icon: a.icon, run: a.run }));
    setItems(q ? base : [...recentItems(), ...base]);

    clearTimeout(searchDebounce);
    if (q.length < 2) return;
    searchDebounce = setTimeout(async () => {
      try {
        const res = state.isAdmin ? await apiGet("/reports", { q, page_size: 6, sort: "new" }) : { reports: [] };
        const reportItems = (res.reports || []).map(r => ({
          label: `${r.public_id} · ${r.title}`,
          icon: "📄",
          sub: r.status_label,
          run: () => openReportDetail(r.public_id),
        }));
        // Отчёты — сверху (обычно то, что искали, набирая номер/название),
        // подходящие действия — под ними, если input ещё не изменился.
        if (input.value.trim() === q) setItems([...reportItems, ...staticMatches.map(a => ({ label: a.label, icon: a.icon, run: a.run }))]);
      } catch (_) { /* тихо — командная палитра не должна ронять остальной UI сетевой ошибкой */ }
    }, 200); // DevSkim: ignore DS172411 — функция, не строка, данные не внешние
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight(Math.min(selected + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight(Math.max(selected - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected);
    }
  });

  setItems([...recentItems(), ...ACTIONS.map(a => ({ label: a.label, icon: a.icon, run: a.run }))]);
  input.focus();
}

document.addEventListener("keydown", e => {
  // e.code, а не e.key: e.key зависит от раскладки клавиатуры (с русской
  // ЙЦУКЕН физическая "K" даёт e.key === "л", а не "k" — Ctrl+K тогда
  // молча никогда не срабатывал бы). e.code — код физической клавиши,
  // от раскладки не зависит.
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyK") {
    e.preventDefault();
    if ($(".cmdk-overlay")) return; // уже открыта — второй Ctrl+K не плодит вторую
    openPalette();
  }
});
