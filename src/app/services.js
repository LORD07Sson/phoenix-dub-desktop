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
    <div class="svc-row">
      <span class="svc-dot" style="background:var(${meta.colorVar}); box-shadow:0 0 0 3px color-mix(in srgb, var(${meta.colorVar}) 18%, transparent);"></span>
      <div class="svc-row-main">
        <div class="svc-row-name">${esc(s.name)}</div>
        <div class="svc-row-desc">${esc(s.desc)}</div>
      </div>
      <span class="svc-pill" style="background:color-mix(in srgb, var(${meta.colorVar}) 16%, var(--surface)); color:var(${meta.colorVar});">${meta.label}</span>
      <div class="svc-row-latency">${s.latency_ms != null ? `${s.latency_ms} мс` : "—"}</div>
      <div class="svc-row-detail">${detail}</div>
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

  const rows = services.map(serviceRowHtml).join("");
  const incidents = d.incidents || [];
  const knownDays = (d.history || []).filter(x => x.status !== "no_data").length;

  const problems = (counts.degraded || 0) + (counts.down || 0);
  const stats = [
    { label: "Работает", value: `${counts.operational || 0}/${services.length}`, sub: problems ? `${problems} с проблемами` : "все в строю", subVar: problems ? "--s-work" : "--s-done" },
    { label: "Есть проблемы", value: problems, sub: "деградация или недоступность", subVar: problems ? "--s-stop" : "--ink-dim" },
    { label: "Средний аптайм", value: avgUptime != null ? formatUptime(avgUptime) : "—", sub: "по процессам", subVar: "--ink-dim" },
    { label: "Инцидентов за 30 дней", value: incidents.length, sub: incidents.some(i => i.ongoing) ? "есть активный" : "нет активных", subVar: incidents.some(i => i.ongoing) ? "--s-stop" : "--ink-dim" },
  ];
  const statCards = stats.map((st, i) => `
    <div class="bcell kpi-cell" style="animation-delay:${i * 40}ms;">
      <h3>${esc(st.label)}</h3>
      <div class="svc-stat"><span class="big-num">${esc(String(st.value))}</span><span style="color:var(${st.subVar});">${esc(st.sub)}</span></div>
    </div>
  `).join("");

  return `
    <div class="page-header">
      <div>
        <h1>Сервисы</h1>
        <div class="sub">Состояние серверов, время отклика и стабильность.</div>
      </div>
      <span class="svc-overall" style="color:var(${overallMeta.colorVar});">
        <span class="svc-dot" style="background:var(${overallMeta.colorVar}); box-shadow:0 0 0 3px color-mix(in srgb, var(${overallMeta.colorVar}) 18%, transparent);"></span>
        ${d.overall === "operational" ? "Все системы работают" : esc(overallMeta.label)}
      </span>
    </div>
    <div class="an-metrics">${statCards}</div>
    <div class="svc-bottom-row">
      <div class="bcell svc-list-cell" style="animation-delay:160ms;">
        <h3>Статус сервисов</h3>
        <div class="svc-list">${rows || `<div class="bento-empty">Не удалось получить статус.</div>`}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:14px; min-height:0;">
        <div class="bcell" style="animation-delay:200ms;">
          <h3 style="margin-bottom:4px;">Аптайм за 30 дней</h3>
          <div class="an-caption">${knownDays ? `собрано ${knownDays} из 30 дней` : "мониторинг только что включён"}</div>
          ${historyStripHtml(d.history)}
        </div>
        <div class="bcell" style="flex-grow:1; animation-delay:240ms;">
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
