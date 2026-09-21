// Вкладка «Сервисы» — живой статус того, что держит студию на ногах:
// бот, локальный Bot API, сама эта мини-апп-API, nginx, база, диск.
// Реальный опрос systemctl/файловой системы на сервере (/api/services/status),
// не выдуманные проценты — поэтому здесь нет ни задержки (latency), ни
// 30-дневного графика аптайма: для последнего нужен был бы отдельный
// хранимый ряд метрик на сервере, которого пока нет. Врать процентом
// было бы хуже, чем просто не рисовать график.

import { apiGet } from "./api.js";
import { $, esc } from "./utils.js";

const STATUS_META = {
  operational: { label: "Работает", colorVar: "--s-done", dot: "🟢" },
  degraded: { label: "Есть проблемы", colorVar: "--s-work", dot: "🟡" },
  down: { label: "Не отвечает", colorVar: "--s-stop", dot: "🔴" },
};

function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return "меньше минуты";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} м`;
  return `${minutes} м`;
}

function serviceRowHtml(s) {
  const meta = STATUS_META[s.status] || STATUS_META.down;
  let detail;
  if (s.key === "database") {
    detail = s.size_bytes != null ? `${(s.size_bytes / 1_000_000).toFixed(1)} МБ` : "—";
  } else if (s.key === "disk") {
    detail = s.used_pct != null ? `занято ${s.used_pct}%` : "—";
  } else {
    detail = `аптайм ${formatUptime(s.uptime_seconds)}`;
  }
  return `
    <div class="team-row" style="cursor:default;">
      <span style="font-size:14px; flex:none;">${meta.dot}</span>
      <div class="nm">
        <div class="n">${esc(s.name)}</div>
        <div class="r">${esc(s.desc)}</div>
      </div>
      <div class="stat" style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
        <span style="color:var(${meta.colorVar}); font-weight:700;">${meta.label}</span>
        <span>${detail}</span>
      </div>
    </div>
  `;
}

function servicesHtml(d) {
  const overallMeta = STATUS_META[d.overall] || STATUS_META.down;
  const rows = (d.services || []).map(serviceRowHtml).join("");
  return `
    <div class="page-header">
      <h1>Сервисы</h1>
      <div class="sub">Состояние серверных процессов прямо сейчас — живой опрос, без истории за прошлые дни.</div>
    </div>
    <div class="bento">
      <div class="bcell wide" style="animation-delay:0ms;">
        <h3>Общий статус</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style="background:color-mix(in srgb, var(${overallMeta.colorVar}) 20%, var(--surface-2)); color:var(${overallMeta.colorVar});">${overallMeta.dot}</span>
          <div class="big-num" style="font-size:20px;">${overallMeta.label}</div>
        </div>
      </div>
      <div class="bcell wide" style="animation-delay:60ms;">
        <h3>Процессы и инфраструктура</h3>
        <div class="team-list">${rows || `<div class="bento-empty">Не удалось получить статус.</div>`}</div>
      </div>
    </div>
  `;
}

export async function loadServices() {
  const root = $("#services-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d;
  try {
    d = await apiGet("/services/status");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить статус сервисов: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = servicesHtml(d);
}
