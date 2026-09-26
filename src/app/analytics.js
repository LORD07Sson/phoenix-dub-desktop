// Вкладка «Аналитика» — оборачиваемость студии за 30 дней (сколько
// закрывается, за сколько в среднем, попадаем ли в сроки) плюс
// загрузка по колонкам доски и топ исполнителей. Тот же /api/analytics/project,
// что и клетка «Загрузка по статусам»/«Топ исполнителей» — один запрос
// на весь экран, без похода за board/team по отдельности.

import { apiGet } from "./api.js";
import { $, esc } from "./utils.js";

const WORKLOAD_COLOR_VAR = { draft: "--s-draft", working: "--s-work", review: "--s-review", completed: "--s-done" };
// Сервер отдаёт подписи колонок по-английски (Pending/In Progress/...,
// см. _PROJECT_BOARD_GROUPS в server.py) — тот же смысл, что и у
// референса, но остальной интерфейс студии целиком на русском (та же
// подмена, что уже сделана для превью-канбана на Обзоре).
const WORKLOAD_LABELS = { draft: "Черновики", working: "В работе", review: "Озвучка", completed: "Завершено" };

function periodDeltaPct(current, prior) {
  if (!prior) return current > 0 ? null : 0;
  return Math.round(((current - prior) / prior) * 100);
}

function trendLine(text, good) {
  return `<div class="an-trend" style="color:var(${good ? "--s-done" : "--s-stop"});">${esc(text)}</div>`;
}

function analyticsHtml(d) {
  const workload = (d.workload || []).map(w => ({
    label: WORKLOAD_LABELS[w.key] || w.label, count: w.total, colorVar: WORKLOAD_COLOR_VAR[w.key] || "--s-draft",
  }));
  const maxCount = Math.max(1, ...workload.map(w => w.count));
  const completedDelta = periodDeltaPct(d.completed_30d, d.completed_prior_30d);
  const performers = d.performers || [];
  const maxCompleted = Math.max(1, ...performers.map(p => p.completed));

  const metrics = [
    {
      label: "Завершено за 30 дней",
      value: d.completed_30d,
      trend: completedDelta !== null
        ? trendLine(`${completedDelta >= 0 ? "+" : ""}${completedDelta}% к прошлым 30 дням`, completedDelta >= 0)
        : `<div class="an-trend">против ${d.completed_prior_30d} за прошлые 30 дней</div>`,
    },
    {
      label: "Среднее время выполнения",
      value: d.avg_turnaround_days !== null && d.avg_turnaround_days !== undefined ? `${d.avg_turnaround_days}д` : "—",
      trend: `<div class="an-trend">создан → завершён</div>`,
    },
    {
      label: "Просрочено сейчас",
      value: d.overdue_now,
      trend: d.overdue_now > 0 ? trendLine("срок уже прошёл", false) : trendLine("всё в срок", true),
    },
    {
      label: "Вовремя",
      value: d.on_time_rate !== null && d.on_time_rate !== undefined ? `${d.on_time_rate}%` : "—",
      trend: d.on_time_rate !== null && d.on_time_rate !== undefined
        ? trendLine("закрыто не позже дедлайна", d.on_time_rate >= 80)
        : `<div class="an-trend">нет отчётов со сроком</div>`,
    },
  ];

  const metricCards = metrics.map((m, i) => `
    <div class="bcell kpi-cell" style="animation-delay:${i * 40}ms;">
      <h3>${esc(m.label)}</h3>
      <div class="big-num">${esc(String(m.value))}</div>
      ${m.trend}
    </div>
  `).join("");

  const workloadBars = workload.map(w => `
    <div class="an-bar-col">
      <div class="an-bar-count">${w.count}</div>
      <div class="an-bar" style="height:${Math.round((w.count / maxCount) * 130)}px; background:var(${w.colorVar});"></div>
      <div class="an-bar-label">${esc(w.label)}</div>
    </div>
  `).join("");

  const performerRows = performers.map(p => `
    <div class="an-perf">
      <div class="an-perf-head"><span>${esc(p.name)}</span><span>${p.completed}</span></div>
      <div class="an-perf-track"><div class="an-perf-fill" style="width:${Math.round((p.completed / maxCompleted) * 100)}%;"></div></div>
    </div>
  `).join("");

  return `
    <div class="page-header">
      <div>
        <h1>Аналитика студии</h1>
        <div class="sub">Пропускная способность и загрузка конвейера дубляжа за последние 30 дней.</div>
      </div>
    </div>
    <div class="an-metrics">${metricCards}</div>
    <div class="an-bottom">
      <div class="bcell" style="animation-delay:160ms;">
        <h3>Загрузка по колонкам доски</h3>
        <div class="an-bars">${workloadBars || `<div class="no-assignee">Нет данных</div>`}</div>
      </div>
      <div class="bcell" style="animation-delay:200ms;">
        <h3 style="margin-bottom:2px;">Топ исполнителей</h3>
        <div class="an-caption">завершённые отчёты за 30 дней</div>
        <div class="an-perf-list">
          ${performerRows || `<div class="no-assignee">Пока нет закрытых отчётов за этот период</div>`}
        </div>
      </div>
    </div>
  `;
}

export async function loadAnalytics() {
  const root = $("#analytics-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d;
  try {
    d = await apiGet("/analytics/project");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить аналитику: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = analyticsHtml(d);
}
