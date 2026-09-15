// Вкладка «Обзор».

import { apiGet, openSheet, dialogSkeletonHtml } from "./api.js";
import { $, esc, initials, STATUS_COLOR_VAR } from "./utils.js";
import { donutHtml, donutLegendHtml, playDonutIntro } from "./charts.js";
import { avatarHtml, loadAvatars } from "./profile.js";

export async function loadOverview() {
  const root = $("#overview-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d, trend;
  try {
    [d, trend] = await Promise.all([apiGet("/overview"), apiGet("/trend").catch(() => null)]);
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
      ${trendChartHtml(trend)}
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
        ${d.performers.length ? `<button class="btn" id="btn-monthly-top" style="margin-top:8px; width:100%; justify-content:center;">📆 Рейтинг месяца →</button>` : ""}
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
  root.querySelectorAll(".trend-bar-fill").forEach(el => {
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.height = el.dataset.h; }));
  });
  const topBtn = root.querySelector("#btn-monthly-top");
  if (topBtn) topBtn.addEventListener("click", openMonthlyTopSheet);
}

// Динамика за 14 дней — те же данные (/api/trend), что и в мини-аппе:
// столбики «создано»/«завершено» по дням, растущие из нуля при
// вставке (тот же приём, что у донат-чарта — playDonutIntro).
function trendChartHtml(trend) {
  if (!trend || !trend.days || !trend.days.length) return "";
  const days = trend.days;
  const peak = Math.max(1, ...days.map(x => Math.max(x.created, x.completed)));
  if (peak <= 1 && days.every(x => x.created === 0 && x.completed === 0)) {
    return `
      <div class="bcell wide" style="animation-delay:200ms;">
        <h3>Динамика за 14 дней</h3>
        <div class="no-assignee">🌱 Пока без движения</div>
      </div>`;
  }
  const labelFirst = days[0].date.slice(5).replace("-", ".");
  const labelLast = days[days.length - 1].date.slice(5).replace("-", ".");
  const bars = days.map(x => {
    const hc = Math.round((x.created / peak) * 100);
    const hd = Math.round((x.completed / peak) * 100);
    return `<div class="trend-col" title="${esc(x.date)}: ${x.created} создано, ${x.completed} завершено">
      <div class="trend-bar-fill created" data-h="${hc}%" style="height:0;"></div>
      <div class="trend-bar-fill completed" data-h="${hd}%" style="height:0;"></div>
    </div>`;
  }).join("");
  return `
    <div class="bcell wide" style="animation-delay:200ms;">
      <h3>Динамика за 14 дней</h3>
      <div class="trend-chart">${bars}</div>
      <div class="trend-axis"><span>${esc(labelFirst)}</span><span>${esc(labelLast)}</span></div>
      <div class="trend-legend-row"><span><i style="background:var(--ember)"></i>создано</span><span><i style="background:var(--s-done)"></i>завершено</span></div>
    </div>`;
}

async function openMonthlyTopSheet() {
  const overlay = openSheet(`<h2>📆 Рейтинг месяца</h2>${dialogSkeletonHtml(5)}`);
  const sheet = overlay.querySelector(".sheet");
  let d;
  try {
    d = await apiGet("/overview/monthly-top");
  } catch (e) {
    sheet.innerHTML = `<h2>📆 Рейтинг месяца</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const medals = ["🥇", "🥈", "🥉"];
  const rows = (d.top || []).map((p, i) => `
    <div class="mini-row">
      <span class="rank">${medals[i] || i + 1}</span>
      ${avatarHtml(p.telegram_id, p.name, "sm")}
      <span class="name">${esc(p.name)}</span>
      <span class="val">${p.completed} ✓</span>
    </div>
  `).join("");
  sheet.innerHTML = `
    <h2>📆 Рейтинг месяца</h2>
    <div style="color:var(--ink-dim); font-size:12px; margin:-8px 0 12px;">по закрытым отчётам за последние 30 дней</div>
    <div class="mini-list">${rows || `<div class="no-assignee">Пока никто не закрыл ни одной серии за последние 30 дней</div>`}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  loadAvatars(sheet);
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}
