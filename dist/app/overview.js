// Вкладка «Обзор».

import { apiGet } from "./api.js";
import { $, esc, initials, STATUS_COLOR_VAR } from "./utils.js";
import { donutHtml, donutLegendHtml, playDonutIntro } from "./charts.js";

export async function loadOverview() {
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
