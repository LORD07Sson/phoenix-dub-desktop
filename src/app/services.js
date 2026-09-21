// Вкладка «Сервисы» — статус того, что держит студию на ногах: бот,
// локальный Bot API, сама эта мини-апп-API, nginx, база, диск.
// Реальный опрос systemctl/файловой системы плюс настоящий latency
// (TCP-connect до локального порта сервиса) на каждый запрос, и
// настоящая 30-дневная история из service_status_snapshots — фоновый
// семплер на сервере пишет по снэпшоту раз в 5 минут (см. server.py:
// _service_status_sampler). График честно неполный первые дни после
// включения — "нет данных", а не зелёная заливка наугад.

import { apiGet } from "./api.js";
import { $, esc, relTime } from "./utils.js";

const STATUS_META = {
  operational: { label: "Работает", colorVar: "--s-done", dot: "🟢" },
  degraded: { label: "Есть проблемы", colorVar: "--s-work", dot: "🟡" },
  down: { label: "Не отвечает", colorVar: "--s-stop", dot: "🔴" },
  no_data: { label: "Нет данных", colorVar: "--ink-dim", dot: "⚪" },
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

function serviceCardHtml(s) {
  const meta = STATUS_META[s.status] || STATUS_META.down;
  let detail;
  if (s.key === "database") {
    detail = s.size_bytes != null ? `${(s.size_bytes / 1_000_000).toFixed(1)} МБ на диске` : "—";
  } else if (s.key === "disk") {
    detail = s.used_pct != null ? `занято ${s.used_pct}%` : "—";
  } else {
    detail = `аптайм ${formatUptime(s.uptime_seconds)}`;
  }
  const latency = s.latency_ms != null ? `${s.latency_ms} мс` : null;
  return `
    <div class="svc-card">
      <div class="svc-card-top">
        <span class="svc-dot" style="background:var(${meta.colorVar}); box-shadow:0 0 0 4px color-mix(in srgb, var(${meta.colorVar}) 20%, transparent);"></span>
        <span class="svc-pill" style="background:color-mix(in srgb, var(${meta.colorVar}) 18%, var(--surface-2)); color:var(${meta.colorVar});">${meta.label}</span>
      </div>
      <div class="svc-card-name">${esc(s.name)}</div>
      <div class="svc-card-desc">${esc(s.desc)}</div>
      <div class="svc-card-detail">${detail}${latency ? ` · ${latency}` : ""}</div>
    </div>
  `;
}

function historyStripHtml(history) {
  const bars = (history || []).map(d => {
    const meta = STATUS_META[d.status] || STATUS_META.no_data;
    return `<span class="svc-history-bar" style="background:var(${meta.colorVar});" title="${esc(d.date)}: ${esc(meta.label)}"></span>`;
  }).join("");
  return `
    <div class="svc-history-strip">${bars}</div>
    <div class="svc-history-axis"><span>${history?.length ? esc(history[0].date) : ""}</span><span>сегодня</span></div>
  `;
}

// SQLite CURRENT_TIMESTAMP отдаёт "YYYY-MM-DD HH:MM:SS" (пробел, без
// зоны) — тот же формат, что уже разбирает relTime() в utils.js.
function parseSqliteTimestamp(ts) {
  return Date.parse(`${ts.replace(" ", "T")}Z`);
}

function incidentRowHtml(inc) {
  const meta = STATUS_META[inc.status] || STATUS_META.down;
  const started = relTime(inc.started_at);
  const durationMin = Math.round((parseSqliteTimestamp(inc.ended_at) - parseSqliteTimestamp(inc.started_at)) / 60000);
  const durationLabel = inc.ongoing ? "ещё не закончилось" : durationMin > 0 ? `~${durationMin} мин` : "< 5 мин";
  return `
    <div class="mini-row" style="align-items:flex-start;">
      <span style="width:7px; height:7px; border-radius:50%; background:var(${meta.colorVar}); margin-top:5px; flex:none;"></span>
      <div style="min-width:0;">
        <div style="font-size:12px; font-weight:600;">${esc(inc.service_name)} — ${esc(meta.label).toLowerCase()}</div>
        <div style="font-size:10.5px; color:var(--ink-dim); margin-top:2px;">${esc(started)} · ${esc(durationLabel)}</div>
      </div>
    </div>
  `;
}

function servicesHtml(d) {
  const services = d.services || [];
  const overallMeta = STATUS_META[d.overall] || STATUS_META.down;
  const counts = services.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const uptimes = services.map(s => s.uptime_seconds).filter(v => v != null);
  const avgUptime = uptimes.length ? Math.round(uptimes.reduce((a, b) => a + b, 0) / uptimes.length) : null;

  const cards = services.map(serviceCardHtml).join("");
  const incidents = d.incidents || [];
  const knownDays = (d.history || []).filter(x => x.status !== "no_data").length;

  return `
    <div class="page-header">
      <h1>Сервисы</h1>
      <div class="sub">Состояние серверных процессов, живой latency и настоящая история с момента включения мониторинга.</div>
    </div>
    <div class="bento">
      <div class="bcell" style="animation-delay:0ms;">
        <h3>Общий статус</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style="background:color-mix(in srgb, var(${overallMeta.colorVar}) 20%, var(--surface-2)); color:var(${overallMeta.colorVar});">${overallMeta.dot}</span>
          <div class="big-num" style="font-size:18px;">${overallMeta.label}</div>
        </div>
        <div class="sub">${services.length} процессов под наблюдением</div>
      </div>
      <div class="bcell" style="animation-delay:40ms;">
        <h3>Работает</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style="background:color-mix(in srgb, var(--s-done) 20%, var(--surface-2)); color:var(--s-done);">✅</span>
          <div class="big-num">${counts.operational || 0}</div>
        </div>
        <div class="sub">из ${services.length}</div>
      </div>
      <div class="bcell" style="animation-delay:80ms;">
        <h3>Есть проблемы</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style="background:color-mix(in srgb, ${(counts.degraded || 0) + (counts.down || 0) > 0 ? "var(--s-work)" : "var(--s-done)"} 20%, var(--surface-2)); color:${(counts.degraded || 0) + (counts.down || 0) > 0 ? "var(--s-work)" : "var(--s-done)"};">⚠️</span>
          <div class="big-num ${(counts.degraded || 0) + (counts.down || 0) > 0 ? "warn" : ""}">${(counts.degraded || 0) + (counts.down || 0)}</div>
        </div>
        <div class="sub">деградация или недоступность</div>
      </div>
      <div class="bcell" style="animation-delay:120ms;">
        <h3>Средний аптайм</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style="background:color-mix(in srgb, var(--fire) 20%, var(--surface-2)); color:var(--fire);">⏱</span>
          <div class="big-num" style="font-size:18px;">${avgUptime != null ? formatUptime(avgUptime) : "—"}</div>
        </div>
        <div class="sub">по процессам с известным временем запуска</div>
      </div>
    </div>
    <div class="svc-bottom-row">
      <div class="bcell">
        <h3>Процессы и инфраструктура</h3>
        <div class="svc-grid">${cards || `<div class="bento-empty">Не удалось получить статус.</div>`}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:14px; min-height:0;">
        <div class="bcell">
          <h3>30-дневный аптайм</h3>
          <div class="sub" style="margin:-4px 0 12px;">${knownDays ? `собрано ${knownDays} из 30 дней` : "мониторинг только что включён"}</div>
          ${historyStripHtml(d.history)}
        </div>
        <div class="bcell" style="flex-grow:1;">
          <h3>Последние инциденты</h3>
          <div class="mini-list">
            ${incidents.map(incidentRowHtml).join("") || `<div class="no-assignee">За последние 30 дней ничего не было</div>`}
          </div>
        </div>
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
