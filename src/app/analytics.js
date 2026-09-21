// Вкладка «Аналитика» — оборачиваемость студии за 30 дней (сколько
// закрывается, за сколько в среднем, попадаем ли в сроки) плюс
// загрузка по колонкам доски и топ исполнителей. Тот же /api/analytics/phoenix,
// что и клетка «Загрузка по статусам»/«Топ исполнителей» — один запрос
// на весь экран, без похода за board/team по отдельности.
//
// Вёрстка — тот же bento, что у Обзора (bcell/kpi-row/mini-list),
// segmentedBarHtml/segBadgesHtml/segLegendHtml из charts.js — то же,
// чем уже рисуется «Структура загрузки» на Обзоре, здесь другой набор
// сегментов (4 колонки доски вместо 6 статусов).

import { apiGet } from "./api.js";
import { $, esc } from "./utils.js";
import { segmentedBarHtml, segBadgesHtml, segLegendHtml, playSegBarIntro, deltaPillHtml, kpiRingHtml, playRingIntro } from "./charts.js";

const WORKLOAD_COLOR_VAR = { draft: "--s-draft", working: "--s-work", review: "--s-review", completed: "--s-done" };
// Сервер отдаёт подписи колонок по-английски (Pending/In Progress/...,
// см. _PHOENIX_BOARD_GROUPS в server.py) — тот же смысл, что и у
// референса, но остальной интерфейс студии целиком на русском (та же
// подмена, что уже сделана для превью-канбана на Обзоре).
const WORKLOAD_LABELS = { draft: "Черновики", working: "В работе", review: "На проверке", completed: "Завершено" };

function periodDeltaPct(current, prior) {
  if (!prior) return current > 0 ? null : 0;
  return Math.round(((current - prior) / prior) * 100);
}

function analyticsHtml(d) {
  const workload = (d.workload || []).map(w => ({
    label: WORKLOAD_LABELS[w.key] || w.label, count: w.total, colorVar: WORKLOAD_COLOR_VAR[w.key] || "--s-draft",
  }));
  const completedDelta = periodDeltaPct(d.completed_30d, d.completed_prior_30d);
  const onTimeFrac = d.on_time_rate === null || d.on_time_rate === undefined ? null : d.on_time_rate / 100;

  const performersRows = (d.performers || []).map((p, i) => `
    <div class="mini-row">
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(p.name)}</span>
      <span class="val">${p.completed} завершено</span>
    </div>
  `).join("");

  return `
    <div class="page-header">
      <h1>Аналитика</h1>
      <div class="sub">Оборачиваемость студии за последние 30 дней: сколько закрывается, за сколько и попадаем ли в сроки.</div>
    </div>
    <div class="bento" id="analytics-bento">
      <div class="bcell kpi-cell" style="animation-delay:0ms;">
        <h3>Завершено за 30 дней</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style="background:color-mix(in srgb, var(--s-done) 20%, var(--surface-2)); color:var(--s-done);">✅</span>
          <div class="big-num">${d.completed_30d}</div>
          ${completedDelta !== null ? deltaPillHtml(completedDelta) : ""}
        </div>
        <div class="sub">против ${d.completed_prior_30d} за предыдущие 30 дней</div>
      </div>
      <div class="bcell kpi-cell" style="animation-delay:60ms;">
        <h3>Среднее время выполнения</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style="background:color-mix(in srgb, var(--fire) 20%, var(--surface-2)); color:var(--fire);">⏱</span>
          <div class="big-num">${d.avg_turnaround_days !== null ? `${d.avg_turnaround_days}д` : "—"}</div>
        </div>
        <div class="sub">создан → завершён, по закрытым за 30 дней</div>
      </div>
      <div class="bcell kpi-cell" style="animation-delay:100ms;">
        <h3>Просрочено сейчас</h3>
        <div class="kpi-row">
          <span class="kpi-icon" style="background:color-mix(in srgb, var(${d.overdue_now > 0 ? "--s-stop" : "--s-done"}) 20%, var(--surface-2)); color:var(${d.overdue_now > 0 ? "--s-stop" : "--s-done"});">⏰</span>
          <div class="big-num ${d.overdue_now > 0 ? "danger" : ""}">${d.overdue_now}</div>
        </div>
        <div class="sub">не завершено, срок уже прошёл</div>
      </div>
      <div class="bcell kpi-cell" style="animation-delay:140ms;">
        <h3>Вовремя</h3>
        <div class="kpi-row">
          <div class="big-num">${d.on_time_rate !== null && d.on_time_rate !== undefined ? `${d.on_time_rate}%` : "—"}</div>
          ${onTimeFrac !== null ? `<div class="kpi-ring-wrap">${kpiRingHtml(onTimeFrac, { colorVar: d.on_time_rate >= 80 ? "--s-done" : d.on_time_rate >= 50 ? "--s-work" : "--s-stop" })}</div>` : ""}
        </div>
        <div class="sub">закрыто не позже дедлайна, из тех что имели срок</div>
      </div>
      <div class="bcell wide" style="animation-delay:180ms;">
        <h3>Загрузка по колонкам доски</h3>
        <div class="seg-badges">${segBadgesHtml(workload)}</div>
        ${segmentedBarHtml(workload)}
        <div class="seg-legend">${segLegendHtml(workload)}</div>
      </div>
      <div class="bcell wide" style="animation-delay:220ms;">
        <h3>Топ исполнителей за 30 дней</h3>
        <div class="mini-list">
          ${performersRows || `<div class="no-assignee">Пока нет закрытых отчётов за этот период</div>`}
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
    d = await apiGet("/analytics/phoenix");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить аналитику: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = analyticsHtml(d);
  playSegBarIntro(root);
  playRingIntro(root);
}
